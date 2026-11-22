// Antigravity CLI (agy): conversations, context, pane matching and /usage.
// All data here is synthetic, shaped like ~/.gemini/antigravity-cli.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { listAgyConversations, loadAgySession, agyConversationHeld, protoVarints } from '../src/agy/load.js';
import { matchPanes } from '../src/match.js';
import { parseAgyUsage, agyQuota } from '../src/quota/agy.js';
import { agyBest } from '../src/quota/index.js';
import { renderQuotas } from '../src/render.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hc-agy-'));

// ---- a minimal protobuf encoder for gen_metadata blobs ----
const varint = (n) => {
  const out = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n) b |= 128;
    out.push(b);
  } while (n);
  return Buffer.from(out);
};
/** fields: [[number, value]] with value a number (varint), string or nested field list */
const msg = (fields) => Buffer.concat(fields.map(([f, v]) => {
  if (typeof v === 'number') return Buffer.concat([varint(f * 8), varint(v)]);
  const body = typeof v === 'string' ? Buffer.from(v) : msg(v);
  return Buffer.concat([varint(f * 8 + 2), varint(body.length), body]);
}));
/** one model call: usage in 1.4, agy's context accounting in 1.9.10 (.1 tokens, .4 limit) */
const genBlob = (tokens, limit, prompt = 1000) => msg([[1, [[3, 1318], [4, [[2, prompt], [3, 200]]], [5, 'gemini-3.8-flash-high'], [9, [[10, [[1, tokens], [4, limit]]]]]]]]);

function agyHome() {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'conversations'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'presence'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'cache'), { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'conversation_summaries.db'));
  db.exec('CREATE TABLE conversation_summaries (conversation_id TEXT, title TEXT, preview TEXT, step_count INTEGER, last_modified_time datetime, workspace_uris TEXT, status TEXT, parent_conversation_id TEXT, nesting_depth INTEGER)');
  db.close();
  return dir;
}

/** a conversation: summary row, transcript, optional gen_metadata */
function conv(dir, id, { cwd, modified, steps = [], gen = null, parent = '', depth = 0 }) {
  const db = new DatabaseSync(path.join(dir, 'conversation_summaries.db'));
  db.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, `title ${id}`, 'preview', steps.length * 2, modified.replace('T', ' ').replace('Z', '+00:00'), JSON.stringify([pathToFileURL(cwd).href]), 'CASCADE_RUN_STATUS_IDLE', parent, depth);
  db.close();
  const logs = path.join(dir, 'brain', id, '.system_generated', 'logs');
  fs.mkdirSync(logs, { recursive: true });
  const lines = [];
  steps.forEach(([input, cacheRead, output], i) => {
    lines.push({ step_index: i * 2, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: modified, content: 'question' });
    lines.push({ step_index: i * 2 + 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: modified, model: 'gemini-3.8-flash-high', input_tokens: input, cache_read_tokens: cacheRead, output_tokens: output, content: 'answer' });
  });
  const f = path.join(logs, 'transcript.jsonl');
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  fs.utimesSync(f, new Date(modified), new Date(modified));
  if (gen) {
    const g = new DatabaseSync(path.join(dir, 'conversations', `${id}.db`));
    g.exec('CREATE TABLE gen_metadata (idx INTEGER, data BLOB, size INTEGER)');
    const add = g.prepare('INSERT INTO gen_metadata VALUES (?, ?, ?)');
    gen.forEach(([tokens, limit], i) => add.run(i, genBlob(tokens, limit), 0));
    g.close();
  }
  fs.writeFileSync(path.join(dir, 'presence', `${id}.lock`), '');
}

test('protobuf walk: nested varints by field path; strings are not mistaken for numbers', () => {
  const f = protoVarints(genBlob(27364, 256000));
  assert.deepEqual(f.get('1.9.10.1'), [27364]);
  assert.deepEqual(f.get('1.9.10.4'), [256000]);
  assert.deepEqual(f.get('1.4.2'), [1000]);
  assert.equal(protoVarints(Buffer.from([0xff, 0xff])).size, 0, 'junk');
});

test("agy conversation: agy's own context count and limit; transcript totals; sub-conversations left out", () => {
  const dir = agyHome();
  const W = path.join(tmp(), 'proj');
  conv(dir, 'c1', { cwd: W, modified: '2026-11-22T09:28:40Z', steps: [[12335, 0, 2088], [3381, 12518, 1794], [3127, 16116, 2845]], gen: [[18414, 256000], [23036, 256000], [27364, 256000]] });
  conv(dir, 'nogen', { cwd: W, modified: '2026-11-22T08:00:00Z', steps: [[5000, 1000, 100]] });
  conv(dir, 'child', { cwd: W, modified: '2026-11-22T10:00:00Z', steps: [[1, 0, 1]], parent: 'c1', depth: 1 });
  const list = listAgyConversations(dir);
  assert.deepEqual(list.map((c) => c.id), ['c1', 'nogen']);
  assert.equal(path.resolve(list[0].cwd), path.resolve(W));

  const s = loadAgySession(list[0]);
  assert.equal(s.agent, 'agy');
  assert.equal(s.model, 'gemini-3.8-flash-high');
  assert.equal(s.requestCount, 3);
  assert.deepEqual([s.context.tokens, s.context.window, s.context.windowSource], [27364, 256000, 'agy']);
  assert.equal(Math.round(s.context.percent * 1000), 107);
  assert.deepEqual(s.trend, [18414, 23036, 27364]);
  assert.deepEqual([s.totals.input, s.totals.cacheRead, s.totals.output], [18843, 28634, 6727]);

  // no gen_metadata: the last request's prompt, window unknown
  const n = loadAgySession(list[1]);
  assert.deepEqual([n.context.tokens, n.context.window, n.context.percent], [6000, null, null]);
});

test('agy makeup, files and tools: tool calls (JSON-text args), tool results, API errors left out', () => {
  const dir = agyHome();
  const W = path.join(tmp(), 'proj');
  conv(dir, 't', { cwd: W, modified: '2026-11-22T13:27:14Z', steps: [] });
  const P = (f) => JSON.stringify(path.join(W, f).replace(/\\/g, '/'));
  const at = '2026-11-22T13:27:00Z';
  const lines = [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: at, content: '<USER_REQUEST>\nfix app.js\n</USER_REQUEST>\n<ADDITIONAL_METADATA>x</ADDITIONAL_METADATA>' },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: at, model: 'gemini-3.8-flash-high', input_tokens: 10000, cache_read_tokens: 0, output_tokens: 400, thinking: 'hmm',
      tool_calls: [{ name: 'read_file', args: { Path: P('app.js') } }, { name: 'read_file', args: { Path: P('notes.txt') } }] },
    { step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: at, content: 'x'.repeat(4000) },
    { step_index: 3, source: 'SYSTEM', type: 'ERROR_MESSAGE', status: 'DONE', created_at: at, error: 'API error (attempt 1): UNAVAILABLE (code 503)' },
    { step_index: 4, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: at, model: 'gemini-3.8-flash-high', input_tokens: 2000, cache_read_tokens: 9000, output_tokens: 300,
      tool_calls: [{ name: 'edit_file', args: { Path: P('app.js'), Target: '"a - b"', Replacement: '"a + b"' } }, { name: 'write_file', args: { Path: P('summary.txt'), Content: '"alpha"' } }] },
    { step_index: 5, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: at, model: 'gemini-3.8-flash-high', input_tokens: 500, cache_read_tokens: 11000, output_tokens: 50,
      tool_calls: [{ name: 'run_command', args: { CommandLine: '"Get-ChildItem -Name"' } }] },
    { step_index: 6, source: 'MODEL', type: 'GENERIC', status: 'ERROR', created_at: at, error: 'permission check failed', content: 'denied' },
  ];
  fs.writeFileSync(listAgyConversations(dir)[0].transcript, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const s = loadAgySession(listAgyConversations(dir)[0]);
  assert.equal(s.requestCount, 3, 'the API error is not a request');
  assert.deepEqual(s.tools, { read_file: 2, edit_file: 1, write_file: 1, run_command: 1 });
  assert.deepEqual(s.files.map((f) => [f.path, f.read, f.edit, f.write]), [['app.js', 1, 1, 0], ['summary.txt', 0, 0, 1], ['notes.txt', 1, 0, 0]]);
  const c = s.composition;
  assert.equal(c.total, 11500, 'no gen_metadata: the last prompt (500 + 11000)');
  assert.equal(c.parts.reduce((n, p) => n + p.tokens, 0), c.total);
  const by = Object.fromEntries(c.parts.map((p) => [p.category, p.tokens]));
  assert.ok(by.systemAndTools > 9000 && by.systemAndTools < 10000, 'first prompt minus the user message');
  assert.ok(by.toolResult > by.toolUse && by.toolUse > 0 && by.user > 0);
});

test('agy panes: the conversation a running agy holds open ("live"), else its last one in the folder, else the newest', () => {
  const dir = agyHome();
  const base = tmp();
  const W = path.join(base, 'proj');
  conv(dir, 'old', { cwd: W, modified: '2026-11-22T09:00:00Z', steps: [[100, 0, 1]] });
  conv(dir, 'open', { cwd: W, modified: '2026-11-22T08:00:00Z', steps: [[200, 0, 1]] });
  conv(dir, 'elsewhere', { cwd: path.join(base, 'other'), modified: '2026-11-22T10:00:00Z', steps: [[1, 0, 1]] });
  const env = { XDG_CACHE_HOME: tmp() };
  const run = (panes, held) => matchPanes(panes, { env, projectsDir: tmp(), home: tmp(), agyHome: dir, agyHeld: (id) => held.includes(id) })
    .map((r) => [r.pane, r.how, r.session?.sessionId, r.others]);

  assert.deepEqual(run([{ pane: 'a', agent: 'agy', cwd: W, title: '' }], ['open']), [['a', 'live', 'open', 0]]);
  // nothing held: agy's last conversation for the folder, as a guess
  fs.writeFileSync(path.join(dir, 'cache', 'last_conversations.json'), JSON.stringify({ [W]: 'open' }));
  assert.deepEqual(run([{ pane: 'a', agent: 'agy', cwd: W, title: '' }], []), [['a', 'folder', 'open', 1]]);
  fs.rmSync(path.join(dir, 'cache', 'last_conversations.json'));
  assert.deepEqual(run([{ pane: 'a', agent: 'agy', cwd: W, title: '' }], []), [['a', 'folder', 'old', 1]]);
  // two agy panes in one folder can't be told apart: each gets one, flagged
  const two = run([{ pane: 'a', agent: 'agy', cwd: W }, { pane: 'b', agent: 'agy', cwd: W }], ['open', 'old']);
  assert.deepEqual(two.map((x) => x[1]), ['folder', 'folder']);
  assert.deepEqual(new Set(two.map((x) => x[2])), new Set(['open', 'old']));
  const r = matchPanes([{ pane: 'a', agent: 'agy', cwd: W }], { env, projectsDir: tmp(), home: tmp(), agyHome: dir, agyHeld: () => true })[0];
  assert.match(r.diag, /agy: 3 conversations, 2 here, 2 open/);
});

test('agy presence lock: a file held open without sharing counts as open (Windows)', { skip: process.platform !== 'win32' }, () => {
  const dir = agyHome();
  conv(dir, 'x', { cwd: tmp(), modified: '2026-11-22T09:00:00Z', steps: [] });
  assert.equal(agyConversationHeld(dir, 'x'), false);
  assert.equal(agyConversationHeld(dir, 'missing'), false);
  const fd = fs.openSync(path.join(dir, 'presence', 'x.lock'), fs.constants.O_RDONLY | 0x10000000);
  try {
    assert.equal(agyConversationHeld(dir, 'x'), true);
  } finally {
    fs.closeSync(fd);
  }
});

const USAGE_JSON = JSON.stringify({
  conversation_id: '', status: 'SUCCESS', response: 'Gemini Models\tWeekly Limit Remaining\t97%\t2026-11-29T09:26:23Z\n', num_turns: 0,
  usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  command: { name: 'usage', data: { groups: [
    { name: 'Gemini Models', buckets: [{ id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0.9725, reset_time: '2026-11-29T09:26:23Z' }] },
    { name: 'Claude and GPT models', buckets: [{ id: '3p-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 1, reset_time: '2026-11-29T12:57:53Z' }] },
  ] } },
});

test('agy /usage: JSON groups, else the tab-separated text', () => {
  const j = parseAgyUsage(USAGE_JSON);
  assert.deepEqual(j.windows.map((w) => [w.id, w.label, w.usedPercent, w.windowMinutes]), [
    ['gemini-weekly', 'Gemini week', 2.75, 10080],
    ['3p-weekly', 'Claude/GPT week', 0, 10080],
  ]);
  assert.equal(j.windows[0].resetsAt, '2026-11-29T09:26:23.000Z');
  const t = parseAgyUsage('Gemini Models\tWeekly Limit Remaining\t97%\t2026-11-29T09:26:23Z\nClaude and GPT models\tWeekly Limit Remaining\t100%\t2026-11-29T12:57:10Z\n');
  assert.deepEqual(t.windows.map((w) => [w.label, w.usedPercent]), [['Gemini week', 3], ['Claude/GPT week', 0]]);
  assert.equal(parseAgyUsage('Please sign in'), null);
});

test('agy quota: runs `agy -p /usage` in its own empty folder, caches 10 min; passive never runs it', () => {
  const env = { XDG_CACHE_HOME: tmp() };
  const NOW = Date.parse('2026-11-22T13:00:00Z');
  const calls = [];
  const run = (cmd, args, o) => (calls.push([cmd, args.join(' '), o.cwd]), { ok: true, stdout: USAGE_JSON, stderr: '' });
  const q = agyQuota({ run, env, now: NOW });
  assert.deepEqual([q.provider, q.status, q.windows.length], ['agy', 'ok', 2]);
  assert.deepEqual(calls[0].slice(0, 2), ['agy', '-p /usage --output-format json']);
  assert.match(calls[0][2], /agy-probe$/);
  assert.equal(agyQuota({ run, env, now: NOW + 60e3 }).source, 'agy /usage (cached)');
  assert.equal(calls.length, 1);
  assert.equal(agyQuota({ run: () => ({ notFound: true }), env: { XDG_CACHE_HOME: tmp() }, now: NOW, exists: () => false }).status, 'not_found');
  // not on PATH (a program started before agy was installed): its install folder
  const seen = [];
  const local = agyQuota({
    run: (cmd) => (seen.push(cmd), cmd === 'agy' ? { notFound: true } : { ok: true, stdout: USAGE_JSON, stderr: '' }),
    env: { XDG_CACHE_HOME: tmp(), LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, now: NOW, platform: 'win32', exists: () => true,
  });
  assert.deepEqual([local.status, seen], ['ok', ['agy', 'C:\\Users\\u\\AppData\\Local\\agy\\bin\\agy.exe']]);
  // a failed check keeps the last reading and says why
  const failed = agyQuota({ run: () => ({ ok: false, stdout: '{"status":"ERROR","error":"Eligibility check failed: EOF","num_turns":0}', stderr: '' }), env, now: NOW + 3600e3, refresh: true });
  assert.deepEqual([failed.status, failed.windows.length, failed.source], ['ok', 2, 'agy /usage (last reading)']);
  assert.match(failed.message, /now: could not read agy \/usage output: Eligibility check failed: EOF/);
  assert.equal(agyQuota({ run: () => ({ ok: false, stdout: '', stderr: 'boom' }), env: { XDG_CACHE_HOME: tmp() }, now: NOW }).status, 'error');
  // passive: an earlier reading, never a new run
  assert.equal(agyBest({ active: false, env, now: NOW + 86400e3, agy: { run: () => assert.fail('ran agy') } }).status, 'ok');
  assert.equal(agyBest({ active: false, env: { XDG_CACHE_HOME: tmp() }, now: NOW }), null);
  assert.match(renderQuotas({ providers: [q] }), /agy +Gemini week +\S+ +3% used/);
});
