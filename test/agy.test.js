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
  assert.equal(agyQuota({ run: () => ({ notFound: true }), env: { XDG_CACHE_HOME: tmp() }, now: NOW }).status, 'not_found');
  // passive: an earlier reading, never a new run
  assert.equal(agyBest({ active: false, env, now: NOW + 86400e3, agy: { run: () => assert.fail('ran agy') } }).status, 'ok');
  assert.equal(agyBest({ active: false, env: { XDG_CACHE_HOME: tmp() }, now: NOW }), null);
  assert.match(renderQuotas({ providers: [q] }), /agy +Gemini week +\S+ +3% used/);
});
