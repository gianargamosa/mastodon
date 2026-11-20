import { readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { expandHome, resolveAgent, shellCommand, tildify } from './config.js';
import { renderRow } from './screen.js';
import { Session } from './session.js';
import { fit, fitLeft, sgr, width } from './text.js';

const SIDEBAR_WIDTH = 32;
const SIDEBAR_HEADER_ROWS = 2; // title and rule above the session list
const PREFIX = '\x1d'; // Ctrl+]
const NOTIFY_STATES = new Set(['blocked', 'done', 'error']);
const BELL_INTERVAL_MS = 3000;
const FRAME_MS = 16; // at most ~60 redraws a second
const SYNC_TIMEOUT_MS = 150; // longest we wait on a program's unfinished frame
const WHEEL_LINES = 3; // lines one wheel notch scrolls
const CLOSE_BUTTON = ' × '; // clickable, at the end of each session's name row
// Mouse reports (SGR encoding), which mas asks the terminal for so the wheel
// scrolls instead of arriving as arrow keys.
const MOUSE_REPORT = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
// Sidebar palette (24-bit colour).
const rgb = (hex, base = 38) => `${base};2;${parseInt(hex.slice(1, 3), 16)};${parseInt(hex.slice(3, 5), 16)};${parseInt(hex.slice(5, 7), 16)}`;
const COLORS = {
  name: rgb('#cdd6f4'),
  muted: rgb('#6c7086'),
  idle: rgb('#a6e3a1'),
  working: rgb('#f9e2af'),
  blocked: rgb('#f38ba8'),
  done: rgb('#94e2d5'),
  error: rgb('#f38ba8'),
  activeBg: rgb('#232334', 48),
};
const KEYS = {
  up: ['\x1b[A', '\x1bOA', 'k'],
  down: ['\x1b[B', '\x1bOB', 'j'],
  enter: ['\r', '\n'],
  scrollUp: ['\x1b[5;2~'], // Shift+PageUp
  scrollDown: ['\x1b[6;2~'], // Shift+PageDown
};
const is = (key, name) => KEYS[name].includes(key);

export class App {
  // `tab` is this mas's name from --tab ('' for the default one).
  constructor(config, { tab = '' } = {}) {
    this.config = config;
    this.tab = tab;
    this.agentNames = Object.keys(config.agents);
    this.sessions = [];
    this.activeIndex = -1;
    this.focus = 'sidebar'; // 'sidebar' | 'pane'
    this.modal = null; // new-session dialog
    this.confirm = null; // { message, onYes }
    this.lastDir = process.cwd();
    this.nextId = 1;
    this.drawn = { side: [], pane: [] };
    this.terminalModes = {};
    this.sidebarFirst = 0;
    this.title = '';
    this.renderTimer = null;
    this.lastRender = 0;
    this.syncSince = null; // when the active program started its unfinished frame
  }

  get active() {
    return this.sessions[this.activeIndex] ?? null;
  }

  get paneSize() {
    return {
      cols: Math.max(20, (process.stdout.columns || 100) - SIDEBAR_WIDTH),
      rows: Math.max(5, process.stdout.rows || 30),
    };
  }

  // ── lifecycle ──────────────────────────────────────────────────────────

  start(initialSessions = []) {
    const { stdin, stdout } = process;
    if (!stdin.isTTY || !stdout.isTTY) throw new Error('mas needs an interactive terminal.');

    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.on('data', (data) => this.onInput(data));
    stdin.resume();
    stdout.on('resize', () => this.onResize());
    stdout.write('\x1b[?1049h\x1b[?25l\x1b[2J\x1b[?1000h\x1b[?1006h');

    process.on('exit', () => this.restoreTerminal());
    for (const signal of ['SIGTERM', 'SIGHUP']) process.on(signal, () => this.quit());

    for (const spec of initialSessions) {
      try {
        this.addSession(spec);
      } catch (err) {
        this.flash = err.message;
      }
    }
    if (this.sessions.length) {
      this.activate(0);
      this.focus = 'pane';
    }

    this.render();
  }

  restoreTerminal() {
    if (this.restored) return;
    this.restored = true;
    process.stdout.write('\x1b[?1006l\x1b[?1000l\x1b[?1l\x1b[?2004l\x1b[0m\x1b[?25h\x1b[?1049l');
  }

  quit() {
    for (const session of this.sessions) session.dispose();
    this.restoreTerminal();
    process.exit(0);
  }

  // ── sessions ───────────────────────────────────────────────────────────

  // A message from a later `mas` run in another tab (see ipc.js).
  handleMessage({ type, specs = [], names = [], env }) {
    if (type === 'close') return this.closeByName(names);
    if (type !== 'open') throw new Error(`Unknown request "${type}".`);
    const added = specs.map((spec) => this.addSession({ ...spec, baseEnv: env }));
    if (added.length) {
      this.activate(this.sessions.indexOf(added.at(-1)));
      if (!this.modal && !this.confirm) this.focus = 'pane';
      this.flash = `Added ${added.map((s) => s.name).join(', ')} from another tab`;
      this.ding();
    }
    return { names: added.map((s) => s.name) };
  }

  // `baseEnv` is the environment of the tab that asked for the session, so its
  // PATH, nvm version and so on apply. MAS_TAB makes a mas:<agent> run inside
  // the session join this mas.
  addSession({ agent, cwd, name, args = [], commandLine, baseEnv }) {
    const def = commandLine ? shellCommand(commandLine) : resolveAgent(this.config, agent);
    if (!def) throw new Error(`"${agent}" is not a configured agent or a command on your PATH.`);
    const dir = resolve(expandHome(cwd || process.cwd()));
    const label = commandLine ? commandLine.split(/\s+/)[0] : agent;
    const session = new Session({
      id: this.nextId++,
      name: this.uniqueName(name || basename(dir), label),
      agent: label,
      command: def.command,
      args: [...(def.args || []), ...args],
      cwd: dir,
      env: { ...baseEnv, ...def.env, MAS_TAB: this.tab },
      ...this.paneSize,
    });

    session.on('render', () => {
      if (session === this.active) this.scheduleRender();
    });
    session.on('exit', () => this.scheduleRender());
    session.on('status', (before, after) => {
      if (session !== this.active && NOTIFY_STATES.has(after?.state) && after.state !== before?.state) this.ding();
      this.scheduleRender();
    });

    this.sessions.push(session);
    this.lastDir = dir;
    return session;
  }

  // "shop", then "shop:claude", then "shop:claude 2", …
  uniqueName(name, agent) {
    const taken = new Set(this.sessions.map((s) => s.name));
    if (!taken.has(name)) return name;
    const base = `${name}:${agent}`;
    let candidate = base;
    for (let n = 2; taken.has(candidate); n++) candidate = `${base} ${n}`;
    return candidate;
  }

  activate(index) {
    if (index < 0 || index >= this.sessions.length) return;
    this.activeIndex = index;
    this.scheduleRender();
  }

  // Keeps the same session active unless it's the one going away.
  removeSession(session) {
    if (!this.sessions.includes(session)) return;
    const active = this.active;
    session.dispose();
    this.sessions = this.sessions.filter((s) => s !== session);
    const kept = this.sessions.indexOf(active);
    this.activeIndex = kept !== -1 ? kept : Math.min(this.activeIndex, this.sessions.length - 1);
    if (this.confirm?.session === session) this.confirm = null;
    if (!this.active) this.focus = 'sidebar';
    this.scheduleRender();
  }

  // `mas --close <name>…` from another tab. Closes nothing unless every name matches.
  closeByName(names) {
    if (!names.length) throw new Error('Name a session to close.');
    const found = names.map((name) => this.sessions.find((s) => s.name === name));
    const missing = names.filter((_, i) => !found[i]);
    if (missing.length) {
      const open = this.sessions.map((s) => `"${s.name}"`).join(', ') || 'none';
      throw new Error(`No session named ${missing.map((n) => `"${n}"`).join(', ')} (open: ${open}).`);
    }
    for (const session of found) this.removeSession(session);
    this.flash = `Closed ${names.join(', ')} from another tab`;
    return { names };
  }

  // Ask before killing `session`; 1-9 retargets the question to that session.
  confirmClose(session) {
    this.confirm = {
      session,
      message: `Kill "${session.name}"? y/n`,
      hint: 'or 1-9 to pick another',
      onYes: () => this.removeSession(session),
      onKey: (key) => {
        const other = /^[1-9]$/.test(key) && this.sessions[Number(key) - 1];
        if (other) this.confirmClose(other);
      },
    };
  }

  // Ring the terminal bell, at most once every few seconds.
  ding() {
    if (!this.config.bell || Date.now() - (this.lastBell || 0) < BELL_INTERVAL_MS) return;
    this.lastBell = Date.now();
    process.stdout.write('\x07');
  }

  // ── input ──────────────────────────────────────────────────────────────

  onInput(data) {
    if (data.includes('\x1b[<')) {
      data = data.replace(MOUSE_REPORT, (_, button, x, y, kind) => {
        this.onMouse(Number(button), Number(x), Number(y), kind === 'm');
        return '';
      });
      this.scheduleRender();
      if (!data) return;
    }
    if (this.confirm) {
      const { onYes, onKey } = this.confirm;
      this.confirm = null;
      if (data === 'y' || data === 'Y') onYes();
      else onKey?.(data);
      this.scheduleRender();
      return;
    }
    this.flash = null;
    if (this.modal) this.modalInput(data);
    else if (this.focus === 'pane') this.paneInput(data);
    else this.sidebarInput(data);
    this.scheduleRender();
  }

  paneInput(data) {
    const session = this.active;
    const prefixAt = data.indexOf(PREFIX);
    if (prefixAt !== -1) {
      if (prefixAt > 0) session?.write(data.slice(0, prefixAt));
      this.focus = 'sidebar';
      const rest = data.slice(prefixAt + 1);
      if (rest) this.sidebarInput(rest);
      return;
    }
    if (!session) return;

    const page = Math.max(1, Math.floor(session.rows / 2));
    if (is(data, 'scrollUp')) return session.scroll(page);
    if (is(data, 'scrollDown')) return session.scroll(-page);
    if (!session.pty) {
      if (data === 'r') session.restart();
      return;
    }
    session.write(data);
  }

  // `x` and `y` are 1-based screen cells. The wheel scrolls the pane's
  // scrollback, unless the program there handles the mouse itself or is
  // full-screen (vim, less…), which gets arrow keys the way a terminal would.
  onMouse(button, x, y, release) {
    if (this.modal || this.confirm) return;
    const wheel = button & 64 ? (button & 1 ? 1 : -1) : 0; // 1 down, -1 up
    const press = !wheel && !release && (button & 3) === 0;

    if (x <= SIDEBAR_WIDTH) {
      if (wheel) return this.activate(this.activeIndex + wheel);
      if (!press) return;
      this.focus = 'sidebar';
      const line = y - 1 - SIDEBAR_HEADER_ROWS;
      const index = this.sidebarFirst + Math.floor(line / 3);
      if (y > SIDEBAR_HEADER_ROWS && index < this.sessions.length) {
        // The × at the end of the name row.
        if (line % 3 === 0 && x >= SIDEBAR_WIDTH - CLOSE_BUTTON.length) return this.confirmClose(this.sessions[index]);
        this.activate(index);
        this.focus = 'pane';
      }
      return;
    }

    const session = this.active;
    if (!session) return;
    if (press) this.focus = 'pane';
    const col = x - SIDEBAR_WIDTH;
    const { term } = session;
    if (session.pty && term.modes.mouseTrackingMode !== 'none') {
      if (term.modes.mouseTrackingMode === 'x10' && (wheel || release)) return;
      session.scrollOffset = 0;
      if (term._core?.coreMouseService?.activeEncoding === 'SGR') {
        session.pty.write(`\x1b[<${button};${col};${y}${release ? 'm' : 'M'}`);
      } else if (col < 224 && y < 224) {
        session.pty.write('\x1b[M' + String.fromCharCode(32 + (release ? 3 : button), 32 + col, 32 + y));
      }
      return;
    }
    if (!wheel) return;
    if (term.buffer.active.type === 'alternate') {
      if (!session.pty) return;
      const arrow = (term.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b[') + (wheel < 0 ? 'A' : 'B');
      session.pty.write(arrow.repeat(WHEEL_LINES));
      return;
    }
    session.scroll(-wheel * WHEEL_LINES);
  }

  sidebarInput(key) {
    const session = this.active;
    if (is(key, 'up')) return this.activate(this.activeIndex - 1);
    if (is(key, 'down')) return this.activate(this.activeIndex + 1);
    if (/^[1-9]$/.test(key)) {
      const index = Number(key) - 1;
      if (index < this.sessions.length) {
        this.activate(index);
        this.focus = 'pane';
      }
      return;
    }
    if (is(key, 'enter') || key === PREFIX || key === '\x1b' || key === '\t' || key === 'l' || key === '\x1b[C') {
      if (session) this.focus = 'pane';
      return;
    }
    switch (key) {
      case 'n':
      case 'c':
        return this.openNewSession();
      case 'r':
        if (session) session.restart();
        return;
      case 'x':
        if (session) this.confirmClose(session);
        return;
      case 'q':
      case '\x03': {
        const running = this.sessions.filter((s) => s.pty).length;
        if (!running) return this.quit();
        this.confirm = { message: `Quit and stop ${running} session${running > 1 ? 's' : ''}? y/n`, onYes: () => this.quit() };
        return;
      }
    }
  }

  // ── new-session dialog ─────────────────────────────────────────────────

  openNewSession() {
    const firstAvailable = this.agentNames.findIndex((name) => this.config.agents[name].available);
    this.modal = { step: 'agent', agentIndex: Math.max(0, firstAvailable), value: '', matches: [], error: '' };
  }

  modalInput(data) {
    const modal = this.modal;
    if (data === '\x1b' || data === '\x03') {
      this.modal = null;
      return;
    }

    if (modal.step === 'agent') {
      const count = this.agentNames.length + 1; // last entry: custom command
      if (is(data, 'up')) return (modal.agentIndex = (modal.agentIndex - 1 + count) % count);
      if (is(data, 'down')) return (modal.agentIndex = (modal.agentIndex + 1) % count);
      if (/^[1-9]$/.test(data) && Number(data) <= count) modal.agentIndex = Number(data) - 1;
      else if (!is(data, 'enter')) return;

      modal.error = '';
      if (modal.agentIndex === this.agentNames.length) {
        modal.step = 'command';
        modal.value = '';
        return;
      }
      const agent = this.config.agents[this.agentNames[modal.agentIndex]];
      if (!agent.available) {
        modal.error = `"${agent.command}" is not on your PATH.`;
        return;
      }
      modal.step = 'dir';
      modal.value = tildify(this.lastDir) + '/';
      return;
    }

    // Text steps: walk the chunk key by key so pastes and fast typing that
    // arrive together (text + Tab/Enter/Ctrl+U) still behave.
    for (const ch of data.replace(/\x1b\[20[01]~/g, '').replace(/\x1b(\[[\d;]*[A-Za-z~]|O[A-Z])/g, '')) {
      if (this.modal !== modal) return;
      if (ch === '\t' && modal.step === 'dir') {
        this.completeDir();
        continue;
      }
      modal.matches = [];
      modal.error = '';
      if (is(ch, 'enter')) this.modalSubmit();
      else if (ch === '\x7f' || ch === '\b') modal.value = [...modal.value].slice(0, -1).join('');
      else if (ch === '\x15') modal.value = '';
      else if (ch === '\x17') modal.value = modal.value.replace(/[^/\s]+\/?$/, '');
      else if (ch >= ' ') modal.value += ch;
    }
  }

  modalSubmit() {
    const modal = this.modal;
    if (modal.step === 'command') {
      if (!modal.value.trim()) {
        modal.error = 'Type a command to run.';
        return;
      }
      modal.commandLine = modal.value.trim();
      modal.step = 'dir';
      modal.value = tildify(this.lastDir) + '/';
      return;
    }
    if (modal.step === 'dir') {
      const dir = resolve(expandHome(modal.value.trim() || '.'));
      let ok = false;
      try {
        ok = statSync(dir).isDirectory();
      } catch {
        // missing
      }
      if (!ok) {
        modal.error = 'Not a directory.';
        return;
      }
      modal.dir = dir;
      modal.step = 'name';
      modal.value = basename(dir);
      modal.matches = [];
      return;
    }

    const agent = this.agentNames[modal.agentIndex];
    this.modal = null;
    try {
      this.addSession({
        agent,
        commandLine: modal.commandLine,
        cwd: modal.dir,
        name: modal.value.trim() || basename(modal.dir),
      });
      this.activate(this.sessions.length - 1);
      this.focus = 'pane';
    } catch (err) {
      this.flash = err.message;
    }
  }

  completeDir() {
    const modal = this.modal;
    const typed = modal.value;
    const full = expandHome(typed);
    const parent = full.endsWith('/') ? full : dirname(full);
    const partial = full.endsWith('/') ? '' : basename(full);

    let names = [];
    try {
      names = readdirSync(parent, { withFileTypes: true })
        .filter((entry) => {
          if (!entry.name.startsWith(partial)) return false;
          if (entry.name.startsWith('.') && !partial.startsWith('.')) return false;
          if (entry.isDirectory()) return true;
          if (!entry.isSymbolicLink()) return false;
          try {
            return statSync(join(parent, entry.name)).isDirectory();
          } catch {
            return false;
          }
        })
        .map((entry) => entry.name)
        .sort();
    } catch {
      // unreadable or missing parent
    }
    if (!names.length) {
      modal.error = 'No matching folders.';
      return;
    }

    let common = names[0];
    for (const name of names) while (!name.startsWith(common)) common = common.slice(0, -1);
    const completed = join(parent, common) + (names.length === 1 ? '/' : '');
    modal.value = typed.startsWith('~') ? tildify(completed) : completed;
    modal.matches = names.length > 1 ? names : [];
  }

  // ── layout & drawing ───────────────────────────────────────────────────

  onResize() {
    const { cols, rows } = this.paneSize;
    for (const session of this.sessions) session.resize(cols, rows);
    this.drawn = { side: [], pane: [] };
    process.stdout.write('\x1b[2J');
    this.render();
  }

  // Draw on the next tick when nothing was drawn lately, so a keystroke's echo
  // shows at once; under a stream of output, at most one frame per FRAME_MS.
  scheduleRender(delay = Math.max(0, FRAME_MS - (performance.now() - this.lastRender))) {
    if (this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      this.render();
    }, delay);
  }

  // The active program is partway through a frame it marked with synchronized
  // output (mode 2026, which Claude Code uses): keep showing its last complete
  // frame until it finishes, or until it has taken too long.
  holdingPane() {
    const session = this.active;
    if (this.modal || !session?.pty || !session.term.modes.synchronizedOutputMode) {
      this.syncSince = null;
      return false;
    }
    const now = performance.now();
    this.syncSince ??= now;
    if (now - this.syncSince >= SYNC_TIMEOUT_MS) return false;
    // Ending the frame triggers a redraw anyway; this one is for a program that never does.
    setTimeout(() => this.scheduleRender(), SYNC_TIMEOUT_MS - (now - this.syncSince));
    return this.drawn.pane.length > 0;
  }

  render() {
    if (this.restored) return;
    const { cols, rows } = this.paneSize;
    const side = this.sidebarLines(rows);
    const holding = this.holdingPane();
    const pane = holding ? this.drawn.pane : this.modal ? this.modalLines(rows, cols) : this.paneLines(rows, cols);

    // Synchronized output, so the terminal shows the whole frame at once.
    const start = '\x1b[?2026h\x1b[?25l';
    let out = start;
    // New output scrolled the pane: have the terminal scroll the screen and
    // repaint only what's new, instead of every row.
    const shift = process.stdout.rows === rows ? this.scrollShift(pane) : 0;
    if (shift) {
      out += `\x1b[0m\x1b[${shift}S`;
      const up = (lines) => [...lines.slice(shift), ...Array(shift).fill(null)];
      this.drawn = { side: up(this.drawn.side), pane: up(this.drawn.pane) };
    }
    for (let y = 0; y < rows; y++) {
      if (side[y] !== this.drawn.side[y]) out += `\x1b[${y + 1};1H${side[y]}`;
      if (pane[y] !== this.drawn.pane[y]) out += `\x1b[${y + 1};${SIDEBAR_WIDTH + 1}H${pane[y]}`;
    }
    // Only a frame that changed something counts against FRAME_MS: a keystroke
    // redraws before its echo is back, and the echo shouldn't wait for that.
    if (out.length > start.length) this.lastRender = performance.now();
    this.drawn = { side, pane };

    const session = this.active;
    if (this.modal && this.modal.step !== 'agent') {
      out += `\x1b[${this.modal.cursorRow + 1};${SIDEBAR_WIDTH + this.modal.cursorCol + 1}H\x1b[?25h`;
    } else if (this.focus === 'pane' && session?.pty && !holding && !session.cursorHidden && !session.scrollOffset) {
      const buffer = session.term.buffer.active;
      out += `\x1b[${buffer.cursorY + 1};${SIDEBAR_WIDTH + buffer.cursorX + 1}H\x1b[?25h`;
    }

    // Arrow keys and pastes must be encoded the way the focused program expects.
    const typing = this.focus === 'pane' && !this.modal && session?.pty;
    out += this.syncMode('?1', Boolean(typing && session.term.modes.applicationCursorKeysMode));
    out += this.syncMode('?2004', Boolean(typing && session.term.modes.bracketedPasteMode));

    const waiting = this.sessions.filter((s) => s.pty && NOTIFY_STATES.has(s.status?.state)).length;
    const title = ['mas', this.tab, session?.name, waiting && `${waiting} waiting`].filter(Boolean).join(' · ');
    if (title !== this.title) {
      this.title = title;
      out += `\x1b]0;${title}\x07`;
    }

    process.stdout.write(out + '\x1b[?2026l');
  }

  // How many rows the pane's content moved up since the last frame, when
  // scrolling by that much leaves more rows already right than not scrolling.
  // The sidebar scrolls too, but its mostly blank rows still line up.
  scrollShift(pane) {
    const old = this.drawn.pane;
    if (old.length !== pane.length) return 0;
    let best = 0;
    let bestKept = pane.filter((line, y) => line === old[y]).length;
    for (let shift = 1; shift < pane.length; shift++) {
      let kept = 0;
      for (let y = 0; y + shift < pane.length; y++) if (pane[y] === old[y + shift]) kept++;
      if (kept > bestKept) [best, bestKept] = [shift, kept];
    }
    return best;
  }

  syncMode(mode, on) {
    if (this.terminalModes[mode] === on) return '';
    this.terminalModes[mode] = on;
    return `\x1b[${mode}${on ? 'h' : 'l'}`;
  }

  // What the sidebar shows: the program's own OSC 7501 report, or just the
  // agent name for programs that don't speak the protocol.
  sessionStatus(session) {
    if (!session.pty) return { icon: '○', label: `exited ${session.exitCode}`, dot: COLORS.error, text: COLORS.muted };
    const report = session.status;
    switch (report?.state) {
      case 'working': {
        const progress = report.progress === undefined ? '' : ` ${report.progress}%`;
        return { icon: '●', label: 'working' + progress, dot: COLORS.working, text: COLORS.working };
      }
      case 'blocked':
        return { icon: '◉', label: 'blocked', dot: COLORS.blocked, text: COLORS.blocked };
      case 'done':
        return { icon: '●', label: 'done', dot: COLORS.done, text: COLORS.done };
      case 'error':
        return { icon: '●', label: 'error', dot: COLORS.error, text: COLORS.error };
      case 'idle':
        return { icon: '○', label: 'idle', dot: COLORS.idle, text: COLORS.muted };
      default:
        return { icon: '○', label: '', dot: COLORS.muted, text: COLORS.muted };
    }
  }

  sidebarLines(rows) {
    const inner = SIDEBAR_WIDTH - 1;
    const focused = this.focus === 'sidebar' && !this.modal;
    const border = sgr(focused ? '36' : '90', '│');
    const lines = [];
    const push = (text, codes = '') => lines.push((codes ? sgr(codes, fit(text, inner)) : fit(text, inner)) + border);
    // A row of [text, codes] segments padded to the sidebar width, all on `bg`,
    // with `right` pinned to its end.
    const row = (segments, bg = '', [rightText, rightCodes] = ['', '']) => {
      const room = inner - width(rightText);
      const paint = (text, codes) => sgr([bg, codes].filter(Boolean).join(';') || '0', text);
      let out = '';
      let used = 0;
      for (const [text, codes] of segments) {
        const part = fit(text, Math.min(width(text), room - used));
        out += paint(part, codes);
        used += width(part);
      }
      lines.push(out + paint(' '.repeat(room - used)) + (rightText ? paint(rightText, rightCodes) : '') + border);
    };

    const count = this.sessions.length;
    const header = ' mas';
    const meta = `${count} session${count === 1 ? '' : 's'} `;
    const tab = this.tab ? fit(` ${this.tab}`, inner - width(header) - width(meta) - 1).trimEnd() : '';
    lines.push(
      sgr('1;36', header) + sgr('36', tab) + sgr('90', fit('', inner - width(header) - width(tab) - width(meta)) + meta) + border
    );
    push('─'.repeat(inner), '90');

    // Each session takes 3 lines (name, status, gap); scroll the list so the
    // active one is visible.
    const footer = this.sidebarFooter();
    const listRows = rows - lines.length - footer.length;
    const perSession = 3;
    const visible = Math.max(1, Math.floor(listRows / perSession));
    const first = Math.max(0, Math.min(this.activeIndex - visible + 1, count - visible));
    this.sidebarFirst = first; // for mapping clicks to sessions

    if (!count) {
      push('');
      push('  No sessions yet.', '90');
      push('  Press n to start one.', '90');
    }
    this.sessions.slice(first, first + visible).forEach((session, i) => {
      const isActive = first + i === this.activeIndex;
      const bg = isActive ? COLORS.activeBg : '';
      const status = this.sessionStatus(session);
      row([[' ' + status.icon + ' ', status.dot], [session.name, `1;${COLORS.name}`]], bg, [CLOSE_BUTTON, COLORS.muted]);
      row([['   '], [[status.label, session.agent].filter(Boolean).join(' · '), status.text]], bg);
      push('');
    });

    while (lines.length < rows - footer.length) push('');
    for (const [text, codes] of footer) push(text, codes);
    return lines.slice(0, rows);
  }

  sidebarFooter() {
    if (this.confirm) {
      const lines = [['', ''], [' ' + this.confirm.message, '1;33']];
      if (this.confirm.hint) lines.push([' ' + this.confirm.hint, '90']);
      return lines;
    }
    if (this.flash) return [['', ''], [' ' + this.flash, '31']];
    const lines = [['─'.repeat(SIDEBAR_WIDTH - 1), '90']];
    if (this.modal) lines.push([' esc cancel', '90']);
    else if (this.focus === 'pane') lines.push([' Ctrl+] sidebar', '90'], [' wheel or Shift+PgUp/Dn scroll', '90']);
    else {
      lines.push(
        [' ↑↓ switch  ⏎ open  1-9 jump', '90'],
        [' n new  x kill  r restart', '90'],
        [' q quit', '90']
      );
    }
    return lines;
  }

  paneLines(rows, cols) {
    const session = this.active;
    if (!session) return this.welcomeLines(rows, cols);

    const lines = [];
    for (let y = 0; y < rows; y++) lines.push(renderRow(session.term, y, cols, session.scrollOffset));

    const banner = (y, text, codes) => (lines[y] = sgr(codes, fit(text, cols)));
    if (session.scrollOffset) {
      banner(0, ` ↑ ${session.scrollOffset} lines up · Shift+PgDn to go back, or just type`, '7;33');
    }
    if (!session.pty) {
      banner(rows - 1, ` ${session.agent} exited with code ${session.exitCode} · r restart · Ctrl+] then x to remove`, '7;31');
    }
    return lines;
  }

  welcomeLines(rows, cols) {
    const text = [
      sgr('1', 'Run several coding agents side by side.'),
      '',
      `Press ${sgr('1;36', 'n')} to start a session: pick an agent, then a project folder.`,
      `Inside a session, press ${sgr('1;36', 'Ctrl+]')} to jump to the sidebar.`,
      '',
      sgr('90', 'Start straight from the shell:  mas claude:~/sites/shop codex:~/sites/blog'),
    ];
    const top = Math.max(0, Math.floor((rows - text.length) / 2));
    const lines = Array.from({ length: rows }, () => '\x1b[K');
    text.forEach((line, i) => (lines[top + i] = '    ' + line + '\x1b[0m\x1b[K'));
    return lines;
  }

  modalLines(rows, cols) {
    const modal = this.modal;
    const lines = [];
    const add = (text = '') => lines.push('  ' + text + '\x1b[0m\x1b[K');
    const steps = modal.commandLine || modal.step === 'command' ? ['agent', 'command', 'dir', 'name'] : ['agent', 'dir', 'name'];

    add();
    add(sgr('1', 'New session') + sgr('90', `  step ${steps.indexOf(modal.step) + 1} of ${steps.length}`));
    add();

    if (modal.step === 'agent') {
      add('What should run?');
      add();
      const choices = this.agentNames.map((name) => ({ name, ...this.config.agents[name] }));
      choices.push({ name: 'custom', label: 'Any command — dev server, aider, htop…', available: true });
      choices.forEach((choice, i) => {
        const selected = i === modal.agentIndex;
        const row = fit(`${selected ? '▸' : ' '} ${i + 1}  ${choice.name}`, 14) + (choice.label || choice.command);
        const note = choice.available ? '' : '  (not installed)';
        add(sgr(selected ? '1;36' : choice.available ? '' : '90', row + note));
      });
      add();
      add(sgr('90', '↑↓ or 1-9 to choose · ⏎ next · esc cancel'));
    } else {
      if (modal.step !== 'command') {
        add(sgr('90', modal.commandLine ? 'run    ' : 'agent  ') + (modal.commandLine || this.agentNames[modal.agentIndex]));
      }
      if (modal.step === 'name') add(sgr('90', `folder `) + tildify(modal.dir));
      add();
      add({ command: 'Command to run (through your shell):', dir: 'Project folder:', name: 'Session name:' }[modal.step]);
      modal.cursorRow = lines.length;
      const max = cols - 6;
      const shown = width(modal.value) > max ? fitLeft(modal.value, max).trimEnd() : modal.value;
      modal.cursorCol = 4 + width(shown);
      add(sgr('36', '› ') + shown);
      add();
      const hints = {
        command: 'e.g. npm run dev · aider --model sonnet · ⏎ next · esc cancel',
        dir: 'tab complete · ⏎ next · esc cancel',
        name: '⏎ start · esc cancel',
      };
      add(sgr('90', hints[modal.step]));
      if (modal.matches.length) {
        add();
        const shownMatches = modal.matches.slice(0, Math.max(1, rows - lines.length - 3));
        for (const match of shownMatches) add(sgr('90', '  ' + match + '/'));
        if (modal.matches.length > shownMatches.length) add(sgr('90', `  …${modal.matches.length - shownMatches.length} more`));
      }
    }
    if (modal.error) {
      add();
      add(sgr('31', modal.error));
    }

    while (lines.length < rows) lines.push('\x1b[K');
    return lines.slice(0, rows);
  }
}
