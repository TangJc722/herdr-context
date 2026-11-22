// Antigravity CLI (`agy`) conversations, in the same snapshot shape as the
// Claude Code and Codex sessions. Read-only.
//
// Where agy keeps things (~/.gemini/antigravity-cli, checked on agy 2026-11):
// - conversation_summaries.db (SQLite), table conversation_summaries:
//   conversation_id, title, workspace_uris (JSON array of file:/// URIs),
//   last_modified_time, parent_conversation_id, nesting_depth, ...
// - brain/<id>/.system_generated/logs/transcript.jsonl: one line per step,
//   {step_index, source: USER_EXPLICIT|MODEL|..., type, status, created_at,
//   model, input_tokens, cache_read_tokens, output_tokens, content, ...}.
//   input_tokens excludes the cached part, so a request's prompt is
//   input_tokens + cache_read_tokens.
// - conversations/<id>.db (SQLite), table gen_metadata: one protobuf blob per
//   model call. No schema is published; field 1.9.10 holds agy's own context
//   accounting: .1 = tokens in context, .4 = its context limit (256000 for
//   Gemini 3.8 Flash, below the model's 1M input). Decoded by field number,
//   so anything unexpected just leaves the window unknown.
// - presence/<id>.lock: held open (Windows: without sharing) by the agy
//   process that has the conversation open; left behind when it exits.
// - cache/last_conversations.json: {folder: conversation id} last opened there.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export function agyDir(env = process.env) {
  return env.AGY_DATA_DIR ? path.resolve(env.AGY_DATA_DIR) : path.join(os.homedir(), '.gemini', 'antigravity-cli');
}

function openDb(file) {
  const emit = process.emitWarning;
  try {
    process.emitWarning = () => {}; // node:sqlite announces itself as experimental on stderr
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    return new DatabaseSync(file, { readOnly: true });
  } finally {
    process.emitWarning = emit;
  }
}

function uriToPath(u) {
  if (typeof u !== 'string') return null;
  if (!u.startsWith('file:')) return u;
  try {
    return fileURLToPath(u);
  } catch {
    // a Windows file URI read on another OS (tests)
    return decodeURIComponent(u.replace(/^file:\/\/\/?/, '')).replace(/^\/([a-zA-Z]:)/, '$1');
  }
}

/** Top-level conversations: [{id, title, cwd, cwds, mtimeMs, transcript, db}], newest first. */
export function listAgyConversations(dir = agyDir()) {
  let db;
  const out = [];
  try {
    db = openDb(path.join(dir, 'conversation_summaries.db'));
    const rows = db.prepare('SELECT * FROM conversation_summaries').all();
    for (const r of rows) {
      if (!r.conversation_id) continue;
      if (r.parent_conversation_id || Number(r.nesting_depth) > 0) continue; // sub-agents
      let cwds = [];
      try {
        cwds = (JSON.parse(r.workspace_uris || '[]') || []).map(uriToPath).filter(Boolean);
      } catch {}
      const transcript = path.join(dir, 'brain', r.conversation_id, '.system_generated', 'logs', 'transcript.jsonl');
      let mtimeMs = Date.parse(String(r.last_modified_time ?? '').replace(' ', 'T')) || 0;
      try {
        mtimeMs = Math.max(mtimeMs, fs.statSync(transcript).mtimeMs);
      } catch {}
      out.push({
        agent: 'agy', id: r.conversation_id, title: r.title || null, cwd: cwds[0] ?? null, cwds, mtimeMs,
        transcript, db: path.join(dir, 'conversations', `${r.conversation_id}.db`),
      });
    }
  } catch {
    return [];
  } finally {
    try {
      db?.close();
    } catch {}
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// libuv's UV_FS_O_EXLOCK: open without sharing (Windows only; not in fs.constants)
const EXLOCK = 0x10000000;

/**
 * Whether a running agy holds the conversation open: true / false, or null
 * when this can't be told (no lock file, or not Windows).
 */
export function agyConversationHeld(dir, id, { platform = process.platform } = {}) {
  const lock = path.join(dir, 'presence', `${id}.lock`);
  if (!fs.existsSync(lock)) return false;
  if (platform !== 'win32') return null;
  try {
    // an exclusive open fails while agy has the file open; closed at once
    fs.closeSync(fs.openSync(lock, fs.constants.O_RDONLY | EXLOCK));
    return false;
  } catch (e) {
    return e.code === 'EBUSY' || e.code === 'EPERM' ? true : null;
  }
}

/** {folder (normalized by the caller): conversation id} from cache/last_conversations.json. */
export function agyLastConversations(dir) {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(dir, 'cache', 'last_conversations.json'), 'utf8'));
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}

// ---------- protobuf, just enough to walk field numbers ----------

/** Varint fields of a protobuf message by dotted field path ("1.9.10.4" → [values]). */
export function protoVarints(buf, prefix = '', out = new Map(), depth = 0) {
  let i = 0;
  const varint = () => {
    let x = 0;
    let mul = 1;
    for (;;) {
      if (i >= buf.length) throw new Error('truncated');
      const b = buf[i++];
      x += (b & 127) * mul;
      if (!(b & 128)) return x;
      mul *= 128;
      if (mul > 2 ** 63) throw new Error('varint too long');
    }
  };
  try {
    const found = new Map();
    while (i < buf.length) {
      const key = varint();
      const f = Math.floor(key / 8);
      const w = key % 8;
      if (f === 0) throw new Error('field 0');
      if (w === 0) {
        const k = prefix + f;
        if (!found.has(k)) found.set(k, []);
        found.get(k).push(varint());
      } else if (w === 1) i += 8;
      else if (w === 5) i += 4;
      else if (w === 2) {
        const n = varint();
        if (i + n > buf.length) throw new Error('truncated');
        const sub = buf.subarray(i, i + n);
        i += n;
        // a nested message if it parses as one; strings and bytes don't
        if (depth < 8) protoVarints(sub, `${prefix}${f}.`, found, depth + 1);
      } else throw new Error(`wire type ${w}`);
    }
    for (const [k, v] of found) out.set(k, [...(out.get(k) ?? []), ...v]);
  } catch {}
  return out;
}

/** agy's own context accounting per model call: [{tokens, limit}], oldest first. */
export function agyContextLog(dbFile) {
  let db;
  try {
    db = openDb(dbFile);
    return db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx').all().map((r) => {
      const f = protoVarints(Buffer.from(r.data ?? []));
      const one = (k) => {
        const v = f.get(k);
        return v && v.length === 1 && v[0] > 0 ? v[0] : null;
      };
      return { tokens: one('1.9.10.1'), limit: one('1.9.10.4') };
    });
  } catch {
    return [];
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

// ---------- the snapshot ----------

/** Snapshot of one agy conversation (same shape as loadClaudeSession's). */
export function loadAgySession(conv) {
  let text = '';
  try {
    text = fs.readFileSync(conv.transcript, 'utf8');
  } catch {}
  const requests = [];
  const totals = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, thinking: 0 };
  let model = null;
  let firstTs = null;
  let lastTs = null;
  let malformed = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      malformed++;
      continue;
    }
    if (r.created_at) {
      firstTs ??= r.created_at;
      lastTs = r.created_at;
    }
    if (typeof r.input_tokens !== 'number' && typeof r.cache_read_tokens !== 'number') continue;
    const input = r.input_tokens || 0;
    const cacheRead = r.cache_read_tokens || 0;
    totals.input += input;
    totals.cacheRead += cacheRead;
    totals.output += r.output_tokens || 0;
    if (r.model) model = r.model;
    requests.push({ prompt: input + cacheRead, ts: r.created_at ?? null });
  }
  const ctxLog = agyContextLog(conv.db);
  const ownLast = [...ctxLog].reverse().find((c) => c.tokens != null) ?? null;
  const limit = [...ctxLog].reverse().find((c) => c.limit != null)?.limit ?? null;
  // agy's own count (includes the last reply, which the next request carries);
  // else the last request's prompt
  const tokens = ownLast?.tokens ?? requests[requests.length - 1]?.prompt ?? null;
  const trend = ctxLog.length === requests.length && ctxLog.every((c) => c.tokens != null) ? ctxLog.map((c) => c.tokens) : requests.map((q) => q.prompt);
  const promptAll = totals.input + totals.cacheRead;
  return {
    agent: 'agy',
    sessionId: conv.id,
    file: conv.transcript,
    cwd: conv.cwd,
    title: conv.title ?? null,
    gitBranch: null,
    version: null,
    model,
    firstTs,
    lastTs,
    requestCount: requests.length,
    context: {
      tokens,
      window: limit,
      windowSource: limit ? 'agy' : 'unknown',
      percent: tokens != null && limit ? tokens / limit : null,
      officialPercent: null,
    },
    trend: trend.slice(-40),
    totals: { ...totals, cacheHitRate: promptAll ? totals.cacheRead / promptAll : null },
    compactions: [],
    composition: null,
    files: [],
    tools: {},
    cost: null,
    sidechain: { requests: 0, promptTokens: 0, outputTokens: 0 },
    subagents: [],
    rateLimits: null,
    parseIssues: { malformedLines: malformed, unknownTypes: {} },
  };
}
