// Terminal side of the Program Status Protocol (OSC 7501), revision 0.4:
// https://www.superlogical.com/rex/docs/build/program-status
//
//   ESC ] 7501 ; state=working:progress=40:msg=<base64> ST
//
// Programs report one record per `id` (no id = the root record); each report
// replaces its record. A program probes support with `OSC 7501 ; ? ST`.

const STATES = new Set(['idle', 'working', 'done', 'blocked', 'error']);
const KINDS = new Set(['permission', 'question', 'auth']);
const KEY = /^[a-z]+$/;
const VALUE = /^[A-Za-z0-9_.,+/=-]*$/;
const SEGMENT = /^[A-Za-z0-9_.+-]{1,32}$/;
const APP = /^[A-Za-z0-9_.+-]{1,32}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const MAX_SEQUENCE = 4096; // OSC through ST
const MAX_RECORDS = 256;
const TEXT_LIMITS = { msg: [2732, 2048], title: [256, 192] }; // [encoded, decoded] bytes

export const DETECTION_REPLY = '\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\';

// Which record wins when a session shows a single status.
const PRIORITY = { blocked: 5, error: 4, done: 3, working: 2, idle: 1 };

const utf8 = new TextDecoder('utf-8', { fatal: true });

function decodeText(encoded) {
  if (!BASE64.test(encoded) || encoded.replace(/=+$/, '').length % 4 === 1) return null;
  try {
    return utf8.decode(Buffer.from(encoded, 'base64'));
  } catch {
    return null;
  }
}

// `data` is the OSC payload after "7501;". Returns { query: true } for the
// detection probe, a report object, or null when the spec says to ignore it.
export function parseReport(data) {
  // OSC (2 bytes) + "7501;" (5) + ST (up to 2) wrap the payload.
  if (Buffer.byteLength(data) + 9 > MAX_SEQUENCE) return null;
  if (data.trim() === '?') return { query: true };

  const pairs = {};
  for (const raw of data.split(':')) {
    const eq = raw.indexOf('=');
    if (eq === -1) continue;
    const key = raw.slice(0, eq).trim();
    const value = raw.slice(eq + 1).trim();
    if (!key || key.length > 16 || !KEY.test(key) || !VALUE.test(value)) continue; // malformed pair: skip
    pairs[key] = value; // last one wins
  }

  const { state } = pairs;
  if (state !== 'clear' && !STATES.has(state)) return null;

  const report = { state, id: '' };
  if ('id' in pairs) {
    const segments = pairs.id.split('/');
    if (pairs.id.length > 128 || segments.length > 8 || !segments.every((s) => SEGMENT.test(s))) return null;
    report.id = pairs.id;
  }
  if (state === 'clear') return report;

  if (state === 'blocked' && KINDS.has(pairs.kind)) report.kind = pairs.kind;
  if ((state === 'working' || state === 'blocked') && /^\d{1,3}$/.test(pairs.progress ?? '')) {
    const progress = Number(pairs.progress);
    if (progress <= 100) report.progress = progress;
  }
  if (APP.test(pairs.app ?? '')) report.app = pairs.app;

  for (const [key, [encodedLimit, decodedLimit]] of Object.entries(TEXT_LIMITS)) {
    if (!(key in pairs)) continue;
    if (pairs[key].length > encodedLimit) return null;
    const text = decodeText(pairs[key]);
    if (text === null || Buffer.byteLength(text) > decodedLimit || CONTROL.test(text)) return null;
    report[key] = text;
  }
  return report;
}

// Strip bidi overrides and invisible formatting before showing program text.
export function displayText(text) {
  return text.replace(/[؜​-‏‪-‮⁠-⁩﻿]/g, '');
}

export class StatusRecords {
  constructor() {
    this.records = new Map(); // id → report, oldest update first
  }

  apply(report) {
    if (report.state === 'clear') {
      if (!report.id) return this.records.clear();
      for (const id of [...this.records.keys()]) {
        if (id === report.id || id.startsWith(report.id + '/')) this.records.delete(id);
      }
      return;
    }
    this.records.delete(report.id);
    this.records.set(report.id, report);
    if (this.records.size > MAX_RECORDS) this.records.delete(this.records.keys().next().value);
  }

  // The program exited or a new shell prompt began (OSC 133;A): anything
  // in progress is over. `done` and `error` stay until the user has seen them.
  endTurn() {
    this.drop(['working', 'blocked', 'idle']);
  }

  // The user came back and pressed a key.
  dismiss() {
    this.drop(['done', 'error']);
  }

  drop(states) {
    for (const [id, record] of this.records) if (states.includes(record.state)) this.records.delete(id);
  }

  clear() {
    this.records.clear();
  }

  // The single most important record, or null if the program never reported.
  get summary() {
    let best = null;
    for (const record of this.records.values()) {
      if (!best || PRIORITY[record.state] >= PRIORITY[best.state]) best = record;
    }
    return best;
  }
}
