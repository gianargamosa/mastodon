import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';

export const DEFAULT_AGENTS = {
  claude: { command: 'claude', label: 'Claude Code' },
  codex: { command: 'codex', label: 'OpenAI Codex' },
  gemini: { command: 'gemini', label: 'Gemini CLI' },
  shell: { command: process.env.SHELL || '/bin/zsh', args: ['-l'], label: 'Shell (dev server, git…)' },
};

export const CONFIG_PATHS = [
  join(homedir(), '.config', 'mas', 'config.json'),
  resolve('mas.config.json'),
];

export function expandHome(p) {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

export function tildify(p) {
  const home = homedir();
  if (p === home) return '~';
  if (p.startsWith(home + '/')) return '~' + p.slice(home.length);
  return p;
}

export function commandExists(command) {
  const candidates = command.includes('/')
    ? [command]
    : (process.env.PATH || '').split(delimiter).filter(Boolean).map((dir) => join(dir, command));
  return candidates.some((file) => {
    try {
      accessSync(file, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

// A configured agent, or — since anything that runs in a terminal can be a
// session — any command on the PATH under its own name.
export function resolveAgent(config, name) {
  if (config.agents[name]) return config.agents[name];
  if (name && commandExists(name)) return { command: name, label: name, available: true };
  return null;
}

// A free-form command line (pipes, env vars, aliases) run through your shell.
export function shellCommand(commandLine) {
  return { command: process.env.SHELL || '/bin/zsh', args: ['-lc', commandLine], label: commandLine, available: true };
}

// Global config first, then the project-local mas.config.json. Agents merge by
// name; preset sessions from both files are started.
export function loadConfig() {
  const config = { agents: structuredClone(DEFAULT_AGENTS), sessions: [], bell: true };

  for (const file of CONFIG_PATHS) {
    if (!existsSync(file)) continue;
    let data;
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`Could not parse ${file}: ${err.message}`);
    }
    for (const [name, agent] of Object.entries(data.agents || {})) {
      config.agents[name] = { ...config.agents[name], ...agent };
    }
    for (const session of data.sessions || []) {
      config.sessions.push({ ...session, cwd: resolve(dirname(file), expandHome(session.cwd || '.')) });
    }
    if (typeof data.bell === 'boolean') config.bell = data.bell;
  }

  for (const agent of Object.values(config.agents)) {
    agent.available = commandExists(agent.command);
  }
  return config;
}
