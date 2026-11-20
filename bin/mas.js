#!/usr/bin/env node
import { existsSync, lstatSync, realpathSync, symlinkSync } from 'node:fs';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { App } from '../src/app.js';
import { CONFIG_PATHS, expandHome, loadConfig, resolveAgent } from '../src/config.js';
import { listen, sendToRunning, socketPath } from '../src/ipc.js';

const HELP = `mas — run several coding agents side by side in one terminal

Usage
  mas                              open with an empty sidebar
  mas <agent>[:<dir>[:<name>]] …   start sessions right away
  mas:<agent> [agent args…]        one session in this folder (mas:claude, mas:codex …)
  mas -- <command…>                run any command as a session in this folder
  mas --tab <name> …               join the mas named <name>, or start it if none is running
  mas --new …                      start a separate mas instead of joining the running one
  mas --close <name>…              close sessions in the running mas (with --tab: in that one)
  mas --install-shortcuts [dir]    create the mas:<agent> commands (next to mas by default)

  <agent> is a configured agent or any command on your PATH (vim, htop, aider…)

Examples
  mas claude:~/sites/shop codex:~/sites/blog
  mas claude:. shell:.:dev-server
  mas claude:. -- npm run dev

One window
  If mas is already running in another tab, mas:<agent> (and mas <agent>:<dir>) add
  their session to it and exit, so everything collects in one place.
  --tab <name> gives a mas its own name, so several can run in different tabs:
    mas --tab work               (in one tab)
    mas:claude --tab work        (from anywhere: lands in the "work" mas)
  Sessions inside a named mas get MAS_TAB=<name>, so mas:<agent> run from
  them joins the same one. Set MAS_TAB yourself to pick a default.

Status
  Programs that speak OSC 7501 (Program Status Protocol) show working / needs you /
  done / error in the sidebar. Others run normally without a status.

Keys
  Ctrl+]            jump between the session and the sidebar
  sidebar  ↑↓ / j k switch session      ⏎ / esc  back into the session
           1-9      jump to session     n        new session
           r        restart session     x        kill session (then 1-9 to pick another)
           q        quit                click ×  kill that session
  session  mouse wheel, Shift+PgUp / Shift+PgDn   scroll back through output
           drag                                   select and copy text

Config (optional, merged in order)
  ${CONFIG_PATHS.join('\n  ')}
`;

function parseSpec(spec) {
  const [agent, ...rest] = spec.split(':');
  const name = rest.length > 1 ? rest.pop() : undefined;
  return { agent, cwd: rest.join(':') || '.', name };
}

const argv = process.argv.slice(2);
if (argv.includes('-h') || argv.includes('--help')) {
  process.stdout.write(HELP);
  process.exit(0);
}

// Link `mas:<agent>` for every configured agent next to `mas` on the PATH.
// npm can't do this from package.json: it turns a `mas:claude` bin into plain
// `claude`, clobbering the real one.
if (argv[0] === '--install-shortcuts') {
  const masOnPath = (process.env.PATH || '')
    .split(delimiter)
    .map((dir) => join(dir, 'mas'))
    .find((file) => existsSync(file));
  const dir = argv[1] || (masOnPath && dirname(masOnPath));
  if (!dir) {
    process.stderr.write('mas: `mas` is not on your PATH yet — run `npm link` first, or pass a folder.\n');
    process.exit(1);
  }
  const script = realpathSync(process.argv[1]);
  for (const agent of Object.keys(loadConfig().agents)) {
    const link = join(dir, `mas:${agent}`);
    let existing = null;
    try {
      existing = lstatSync(link);
    } catch {
      // not there yet
    }
    if (existing && !(existing.isSymbolicLink() && realpathSync(link) === script)) {
      process.stdout.write(`skip    ${link} (something else is already there)\n`);
      continue;
    }
    if (!existing) symlinkSync(script, link);
    process.stdout.write(`linked  ${link}\n`);
  }
  process.exit(0);
}

// Invoked as `mas:<agent>` (e.g. mas:claude): one session in the current folder,
// with any arguments passed straight to the agent.
const shortcut = basename(process.argv[1] || '').match(/^mas:(.+?)(\.js)?$/);

try {
  // mas's own flags come first; for mas:<agent> everything after them goes to
  // the agent. `--new` starts a separate mas instead of joining the running one;
  // `--tab <name>` picks which running mas to join (or names the new one).
  let separate = false;
  let tab = process.env.MAS_TAB || '';
  while (argv.length) {
    const [flag] = argv;
    if (flag === '--new') separate = true;
    else if (flag.startsWith('--tab=')) tab = flag.slice('--tab='.length);
    else if (flag === '--tab' || flag === '-t') {
      argv.shift();
      if (!argv.length) throw new Error(`${flag} needs a name, e.g. ${flag} work`);
      tab = argv[0];
    } else break;
    argv.shift();
  }
  const socket = socketPath(tab);
  const which = tab ? `the "${tab}" mas` : 'the mas';

  // `mas --close <name>…`: close sessions in the running mas.
  if (!shortcut && argv[0] === '--close') {
    const names = argv.slice(1);
    if (!names.length) throw new Error('--close needs a session name, e.g. --close shop');
    const reply = await sendToRunning({ type: 'close', names }, socket);
    if (!reply) throw new Error(`${which} isn't running${tab ? '' : ' (pass --tab <name> for a named one)'}.`);
    if (!reply.ok) throw new Error(reply.error);
    process.stdout.write(`mas: closed ${reply.names.map((name) => `"${name}"`).join(', ')} in ${which}.\n`);
    process.exit(0);
  }

  const config = loadConfig();
  // `mas -- npm run dev`: anything after -- is one command run in this folder.
  const dashes = argv.indexOf('--');
  const commandLine = dashes === -1 ? '' : argv.slice(dashes + 1).join(' ');
  const specArgs = dashes === -1 ? argv : argv.slice(0, dashes);
  const requested = shortcut
    ? [{ agent: shortcut[1], cwd: process.cwd(), args: argv }]
    : specArgs.map(parseSpec);
  if (commandLine) requested.push({ commandLine, cwd: process.cwd() });
  for (const spec of requested) {
    if (!spec.commandLine && !resolveAgent(config, spec.agent)) {
      throw new Error(`"${spec.agent}" is not a configured agent (${Object.keys(config.agents).join(', ')}) or a command on your PATH.`);
    }
    spec.cwd = resolve(expandHome(spec.cwd));
  }

  // Already running in another tab? Hand the sessions over and stop here.
  if (!separate) {
    const reply = await sendToRunning({ type: 'open', specs: requested, env: process.env }, socket);
    if (reply && !reply.ok) throw new Error(reply.error);
    if (reply) {
      process.stdout.write(
        reply.names.length
          ? `mas: added ${reply.names.map((name) => `"${name}"`).join(', ')} to ${which} running in your other tab.\n`
          : `mas: ${which} is already running in another tab. Use mas:<agent> here to add a session, mas --tab <name> for another named one, or mas --new for a separate one.\n`
      );
      process.exit(0);
    }
  }

  // A --new mas isn't reachable by name, so it doesn't claim one.
  const app = new App(config, { tab: separate ? '' : tab });
  app.start(shortcut ? requested : [...config.sessions, ...requested]);
  if (!separate) listen((message) => app.handleMessage(message), socket);
} catch (err) {
  process.stderr.write(`mas: ${err.message}\n`);
  process.exit(1);
}
