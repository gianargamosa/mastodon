// The first mas to start listens on a Unix socket; later `mas:<agent>` runs (from
// any tab or folder) hand their sessions to it instead of opening a second mas.
// Messages are one line of JSON each way.

import { chmodSync, unlinkSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_SOCKET = process.env.MAS_SOCKET || join(tmpdir(), `mas-${process.getuid?.() ?? 'user'}.sock`);
const TAB_NAME = /^[A-Za-z0-9_.-]{1,32}$/;

// Each named mas (`--tab work`) listens on its own socket next to the default
// one, so several can run at once: mas-501.sock, mas-501-work.sock, …
export function socketPath(tab = '') {
  if (!tab) return DEFAULT_SOCKET;
  if (!TAB_NAME.test(tab)) throw new Error(`"${tab}" is not a usable tab name (letters, digits, . _ -, up to 32).`);
  return DEFAULT_SOCKET.replace(/(\.sock)?$/, `-${tab}$1`);
}

// Resolves with the running instance's reply, or null if none is running.
export function sendToRunning(message, path = DEFAULT_SOCKET) {
  return new Promise((resolve) => {
    const socket = net.connect(path);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(JSON.stringify(message) + '\n'));
    socket.on('data', (chunk) => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end === -1) return;
      socket.end();
      try {
        resolve(JSON.parse(buffer.slice(0, end)));
      } catch {
        resolve({ ok: false, error: 'Unreadable reply from the running mas.' });
      }
    });
    socket.on('error', () => resolve(null)); // nothing listening (or a stale socket)
  });
}

// Only call after sendToRunning() came back null: any socket file left is stale.
export function listen(onMessage, path = DEFAULT_SOCKET) {
  try {
    unlinkSync(path);
  } catch {
    // none left behind
  }

  const server = net.createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.on('data', async (chunk) => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end === -1) return;
      let reply;
      try {
        reply = { ok: true, ...(await onMessage(JSON.parse(buffer.slice(0, end)))) };
      } catch (err) {
        reply = { ok: false, error: err.message };
      }
      socket.end(JSON.stringify(reply) + '\n');
    });
  });

  server.on('error', () => {}); // another mas won the race; run standalone
  server.listen(path, () => {
    chmodSync(path, 0o600);
    process.on('exit', () => {
      try {
        unlinkSync(path);
      } catch {
        // already removed
      }
    });
  });
  return server;
}
