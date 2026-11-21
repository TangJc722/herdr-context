import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonlTail } from '../src/jsonl-tail.js';
import { ClaudeSession } from '../src/claude/session.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'claude');

function load(name, opts) {
  const tail = new JsonlTail(path.join(FIX, name));
  const s = new ClaudeSession(opts);
  for (const r of tail.readNew()) s.apply(r);
  return { s, snap: s.snapshot(), malformed: tail.malformed };
}

const sum = (parts) => parts.reduce((n, p) => n + p.tokens, 0);

test('usage is counted once per request even when split across records', () => {
  const { snap } = load('basic.jsonl');
  assert.equal(snap.requestCount, 2);
  assert.equal(snap.totals.output, 60); // 50 + 10, not 3×50 + 10
  assert.equal(snap.totals.thinking, 20);
  assert.equal(snap.totals.cacheWrite, 1300);
});

test('context = latest prompt size (input + cache read + cache write)', () => {
  const { snap } = load('basic.jsonl');
  assert.equal(snap.trend.at(-1), 5 + 1000 + 300);
  assert.deepEqual(snap.trend, [1010, 1305]);
});

test('sidechain records stay out of the main context', () => {
  const { snap } = load('basic.jsonl');
  assert.deepEqual(snap.sidechain, { requests: 1, promptTokens: 401, outputTokens: 7 });
  const { snap: asMain } = load('basic.jsonl', { sidechainAsMain: true });
  assert.equal(asMain.requestCount, 3);
});

test('tools, file activity, cost and metadata', () => {
  const { snap } = load('basic.jsonl');
  assert.deepEqual(snap.tools, { Read: 1, Edit: 1 });
  assert.equal(snap.files[0].path, 'b.js'); // relative to cwd /p
  assert.equal(snap.files[0].edit, 1);
  assert.equal(snap.files.find((f) => f.path === 'a.js').read, 1);
  assert.equal(snap.cost.totalUSD, 0.5);
  assert.equal(snap.cost.linesAdded, 3);
  assert.equal(snap.model, 'claude-test-1');
  assert.equal(snap.cwd, '/p');
  assert.equal(snap.gitBranch, 'main');
});

test('bad and unknown records are reported, not fatal', () => {
  const { snap, malformed } = load('basic.jsonl');
  assert.equal(malformed, 1);
  assert.deepEqual(snap.unknownTypes, { 'brand-new-type': 1 });
});

test('composition: measured total, baseline split by prompt_snapshot', () => {
  const { s, snap } = load('basic.jsonl');
  const c = snap.composition;
  assert.equal(c.total, 1305);
  assert.equal(sum(c.parts), 1305);
  // baseline = first prompt (1010) - conversation before it ("hello" 2 + skill listing 100);
  // the environment and prompt_snapshot attachments are not model-visible text.
  assert.equal(s.baseline, 908);
  const base = c.parts.filter((p) => p.category === 'systemPrompt' || p.category === 'toolDefinitions');
  assert.equal(sum(base), 908);
  const tools = c.parts.find((p) => p.category === 'toolDefinitions').tokens;
  const sys = c.parts.find((p) => p.category === 'systemPrompt').tokens;
  assert.ok(tools > sys);
  assert.deepEqual(c.topTools.map((t) => t.name), ['Big', 'Small']);
  assert.ok(c.parts.some((p) => p.category === 'toolResult'));
});

test('compaction: boundary recorded, post-compaction size filled, segment reset', () => {
  const { snap } = load('compaction.jsonl');
  assert.deepEqual(snap.compactions, [
    { ts: '2026-11-21T10:00:03.000Z', trigger: 'auto', preTokens: 8000, postTokens: 3500 },
  ]);
  const c = snap.composition;
  assert.equal(c.total, 3500);
  assert.equal(sum(c.parts), 3500);
  const cats = c.parts.map((p) => p.category);
  assert.ok(cats.includes('compactSummary'));
  // the 4000-char reply from before compaction is no longer attributed
  const replies = c.parts.find((p) => p.category === 'assistant')?.tokens ?? 0;
  assert.ok(replies < 50, `replies=${replies}`);
  // no prompt_snapshot in this log: baseline shown as one block
  assert.ok(cats.includes('systemAndTools'));
});

test('prompt_snapshot with a system prompt but no tool list: no crash, no split', () => {
  // seen on a real Windows machine: snapshot carries systemPrompt only
  const { snap } = load('sysprompt-only.jsonl');
  const c = snap.composition;
  assert.equal(c.total, 2002);
  assert.equal(sum(c.parts), 2002);
  const cats = c.parts.map((p) => p.category);
  assert.ok(cats.includes('systemAndTools'), cats.join());
  assert.ok(!cats.includes('systemPrompt') && !cats.includes('toolDefinitions'));
  assert.equal(c.topTools, null);
});

test('empty session has no composition', () => {
  const s = new ClaudeSession();
  assert.equal(s.snapshot().composition, null);
  s.apply(null);
  s.apply({ type: 'assistant', message: {} });
  assert.equal(s.snapshot().requestCount, 0);
});
