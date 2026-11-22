// Antigravity CLI (`agy`) conversations, in the same snapshot shape as the
// Claude Code and Codex sessions. Read-only.
//
// Where agy keeps things (~/.gemini/antigravity-cli, checked on agy 2026-11):
// - conversation_summaries.db (SQLite), table conversation_summaries:
//   conversation_id, title, workspace_uris (JSON array of file:/// URIs),
//   last_modified_time, parent_conversation_id, nesting_depth, ...
// - brain/<id>/.system_generated/logs/transcript.jsonl: one line per step,
//   {step_index, source, type, status, created_at, content, ...}:
//     USER_EXPLICIT / USER_INPUT     the user's message (wrapped in <USER_REQUEST>)
//     MODEL / PLANNER_RESPONSE       a model call: model, input_tokens,
//                                    cache_read_tokens, output_tokens, content,
//                                    thinking, tool_calls [{name, args}] (each arg
//                                    value is itself JSON text: "\"C:/x/a.js\"")
//     MODEL / GENERIC                a tool's result (status ERROR + error when it failed)
//     SYSTEM / ERROR_MESSAGE         API errors (retries): not context
//   input_tokens excludes the cached part, so a request's prompt is
//   input_tokens + cache_read_tokens. Tools seen: read_file, write_file,
//   edit_file, run_command.
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
import { estimateTokens, IMAGE_TOKENS_ESTIMATE } from '../estimate.js';

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

const CATEGORIES = ['user', 'assistant', 'toolUse', 'toolResult'];
const PATH_ARGS = ['Path', 'AbsolutePath', 'TargetFile', 'FilePath', 'File', 'path', 'file_path'];

/** A tool argument's value: agy writes each one as JSON text ("\"C:/x\""). */
export function agyArg(v) {
  if (typeof v !== 'string') return v;
  const s = v.trim();
  if (!/^["{[]/.test(s)) return v;
  try {
    return JSON.parse(s);
  } catch {
    return v;
  }
}

/** What a tool call did to a file: "read" | "write" | "edit" | null. */
export function agyFileKind(name) {
  const n = String(name ?? '').toLowerCase();
  if (/(^|_)(write|create)(_|$)/.test(n)) return 'write';
  if (/(^|_)(edit|replace|patch|modify)(_|$)/.test(n)) return 'edit';
  if (/(^|_)(read|view|open)(_|$)/.test(n)) return 'read';
  return null;
}

const userText = (s) => String(s ?? '').replace(/^\s*<USER_REQUEST>\s*/, '').replace(/\s*<\/USER_REQUEST>[\s\S]*$/, '');

/** The context split into categories: measured total, estimated split (as for Codex). */
export function agyComposition(total, baseline, segment) {
  if (!total) return null;
  const fixed = Math.min(baseline ?? 0, total);
  const rest = total - fixed;
  const estSum = CATEGORIES.reduce((n, c) => n + segment[c], 0);
  const parts = [{ category: 'systemAndTools', tokens: fixed }];
  if (!estSum) {
    parts.push({ category: 'unattributed', tokens: rest });
  } else {
    const raw = CATEGORIES.map((c) => (rest * segment[c]) / estSum);
    const whole = raw.map(Math.floor);
    let left = rest - whole.reduce((a, b) => a + b, 0);
    raw.map((x, i) => [x - whole[i], i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => {
      if (left > 0) {
        whole[i]++;
        left--;
      }
    });
    CATEGORIES.forEach((c, i) => parts.push({ category: c, tokens: whole[i] }));
  }
  return { total, estimated: true, parts: parts.filter((p) => p.tokens > 0), topTools: null };
}

/** Snapshot of one agy conversation (same shape as loadClaudeSession's). */
export function loadAgySession(conv) {
  let text = '';
  try {
    text = fs.readFileSync(conv.transcript, 'utf8');
  } catch {}
  const requests = [];
  const totals = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, thinking: 0 };
  const segment = Object.fromEntries(CATEGORIES.map((c) => [c, 0])); // estimated, all steps so far
  const tools = new Map();
  const files = new Map();
  let baseline = null;
  let model = null;
  let firstTs = null;
  let lastTs = null;
  let malformed = 0;
  const touch = (p, kind, ts) => {
    const f = files.get(p) || { read: 0, edit: 0, write: 0, lastTs: null };
    f[kind]++;
    f.lastTs = ts || f.lastTs;
    files.set(p, f);
  };
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
    if (r.source === 'SYSTEM') continue; // API errors and retries: never sent as context
    if (r.type === 'USER_INPUT') {
      segment.user += estimateTokens(userText(r.content)) + (Array.isArray(r.media) ? r.media.length * IMAGE_TOKENS_ESTIMATE : 0);
      continue;
    }
    if (r.type === 'PLANNER_RESPONSE' || typeof r.input_tokens === 'number') {
      const input = r.input_tokens || 0;
      const cacheRead = r.cache_read_tokens || 0;
      const prompt = input + cacheRead;
      // the first prompt minus the conversation so far is agy's fixed part (system prompt + tools)
      if (baseline === null && prompt) baseline = Math.max(0, prompt - CATEGORIES.reduce((n, c) => n + segment[c], 0));
      totals.input += input;
      totals.cacheRead += cacheRead;
      totals.output += r.output_tokens || 0;
      if (r.model) model = r.model;
      if (prompt) requests.push({ prompt, ts: r.created_at ?? null });
      segment.assistant += estimateTokens(r.content);
      for (const call of Array.isArray(r.tool_calls) ? r.tool_calls : []) {
        const name = String(call?.name ?? 'tool');
        tools.set(name, (tools.get(name) ?? 0) + 1);
        segment.toolUse += estimateTokens(name) + estimateTokens(call?.args ?? '');
        const kind = agyFileKind(name);
        const args = call?.args && typeof call.args === 'object' ? call.args : {};
        const key = PATH_ARGS.find((k) => args[k] != null);
        const p = key ? agyArg(args[key]) : null;
        if (kind && typeof p === 'string' && p) touch(p, kind, r.created_at);
      }
      continue;
    }
    // a tool's result (MODEL / GENERIC), or an error it returned
    segment.toolResult += estimateTokens(r.content ?? '') + estimateTokens(r.error ?? '');
  }
  const ctxLog = agyContextLog(conv.db);
  const ownLast = [...ctxLog].reverse().find((c) => c.tokens != null) ?? null;
  const limit = [...ctxLog].reverse().find((c) => c.limit != null)?.limit ?? null;
  // agy's own count (includes the last reply, which the next request carries);
  // else the last request's prompt
  const tokens = ownLast?.tokens ?? requests[requests.length - 1]?.prompt ?? null;
  const trend = ctxLog.length === requests.length && ctxLog.every((c) => c.tokens != null) ? ctxLog.map((c) => c.tokens) : requests.map((q) => q.prompt);
  const promptAll = totals.input + totals.cacheRead;
  const cwd = conv.cwd ? String(conv.cwd).replace(/\\/g, '/').replace(/\/+$/, '') : null;
  const rel = (p) => {
    const s = String(p).replace(/\\/g, '/');
    return cwd && s.toLowerCase().startsWith(cwd.toLowerCase() + '/') ? s.slice(cwd.length + 1) : p;
  };
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
    composition: agyComposition(tokens, baseline, segment),
    files: [...files.entries()]
      .map(([p, f]) => ({ path: rel(p), ...f }))
      .sort((a, b) => b.edit + b.write - (a.edit + a.write) || b.read - a.read),
    tools: Object.fromEntries([...tools.entries()].sort((a, b) => b[1] - a[1])),
    cost: null,
    sidechain: { requests: 0, promptTokens: 0, outputTokens: 0 },
    subagents: [],
    rateLimits: null,
    parseIssues: { malformedLines: malformed, unknownTypes: {} },
  };
}
