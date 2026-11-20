import { EventEmitter } from 'node:events';
import pty from 'node-pty';
import xterm from '@xterm/headless';
import { DETECTION_REPLY, parseReport, StatusRecords } from './status.js';

const { Terminal } = xterm;

// One program running in its own pseudo-terminal. Its output is fed into a
// headless xterm so the app can draw the screen into the main pane at any time.
export class Session extends EventEmitter {
  constructor({ id, name, agent, command, args = [], cwd, env = {}, cols, rows }) {
    super();
    Object.assign(this, { id, name, agent, command, args, cwd, env, cols, rows });
    this.scrollOffset = 0;
    this.start();
  }

  start() {
    this.term?.dispose();
    this.term = new Terminal({ cols: this.cols, rows: this.rows, scrollback: 5000, allowProposedApi: true });
    this.records = new StatusRecords();

    // Answers to terminal queries (cursor position, device attributes, …) go
    // back to the program — CLIs like Codex wait for them on startup.
    this.term.onData((data) => this.pty?.write(data));
    this.term.onTitleChange((title) => {
      this.title = title;
      this.emit('update');
    });

    const { parser } = this.term;
    parser.registerOscHandler(7501, (data) => {
      const report = parseReport(data);
      if (report?.query) this.pty?.write(DETECTION_REPLY);
      else if (report) this.updateStatus(() => this.records.apply(report));
      return true;
    });
    parser.registerOscHandler(133, (data) => {
      if (data.startsWith('A')) this.updateStatus(() => this.records.endTurn());
      return false;
    });
    parser.registerEscHandler({ final: 'c' }, () => {
      this.updateStatus(() => this.records.clear()); // RIS
      return false;
    });

    this.title = '';
    this.exitCode = null;
    this.scrollOffset = 0;

    try {
      this.pty = pty.spawn(this.command, this.args, {
        name: 'xterm-256color',
        cols: this.cols,
        rows: this.rows,
        cwd: this.cwd,
        env: { ...process.env, ...this.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
      });
    } catch (err) {
      this.pty = null;
      this.exitCode = -1;
      this.term.write(`\x1b[31mCould not start ${this.command}: ${err.message}\x1b[0m\r\n`);
      return;
    }

    const proc = this.pty;
    proc.onData((data) => this.term.write(data, () => this.emit('render')));
    proc.onExit(({ exitCode }) => {
      if (this.pty !== proc) return; // replaced by a restart
      this.pty = null;
      this.exitCode = exitCode;
      this.records.endTurn();
      this.emit('exit');
    });
  }

  // Run `change` and emit 'status' with the summary before and after.
  updateStatus(change) {
    const before = this.status;
    change();
    const after = this.status;
    if (before !== after) this.emit('status', before, after);
  }

  // What the program last reported over OSC 7501, or null if it never did.
  get status() {
    return this.records.summary;
  }

  get cursorHidden() {
    return Boolean(this.term._core?.coreService?.isCursorHidden);
  }

  write(data) {
    if (!this.pty) return;
    this.scrollOffset = 0;
    this.updateStatus(() => this.records.dismiss());
    this.pty.write(data);
  }

  scroll(lines) {
    const max = this.term.buffer.active.baseY;
    this.scrollOffset = Math.max(0, Math.min(max, this.scrollOffset + lines));
  }

  resize(cols, rows) {
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    this.term.resize(cols, rows);
    this.pty?.resize(cols, rows);
  }

  restart() {
    this.kill();
    this.start();
  }

  kill() {
    const proc = this.pty;
    this.pty = null;
    try {
      proc?.kill();
    } catch {
      // already gone
    }
  }

  dispose() {
    this.kill();
    this.term.dispose();
  }
}
