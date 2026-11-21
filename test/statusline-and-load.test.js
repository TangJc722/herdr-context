import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeStatusline, readStatusline, writeStatusline } from '../src/claude/statusline.js';
import { resolveContextWindow, loadClaudeSession } from '../src/claude/load.js';
import { listClaudeSessions } from '../src/claude/discover.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'test', 'fixtures', 'claude');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hc-'));

test('normalizeStatusline tolerates missing and null fields', () => {
  assert.equal(normalizeStatusline(null), null);
  const n = normalizeStatusline({ session_id: 's', context_window: { used_percentage: null }, rate_limits: { five_hour: { used_percentage: 40, resets_at: 1 } } });
  assert.equal(n.contextUsedPercent, null);
  assert.equal(n.contextWindowSize, null);
  assert.deepEqual(n.rateLimits.fiveHour, { usedPercent: 40, resetsAt: 1 });
  assert.equal(n.rateLimits.sevenDay, null);
});

test('writeStatusline refuses ids that could escape the cache dir', () => {
  const dir = tmp();
  assert.equal(writeStatusline({ session_id: '../evil' }, dir), null);
  assert.equal(writeStatusline({}, dir), null);
  assert.equal(readStatusline('../evil', dir), null);
  assert.ok(writeStatusline({ session_id: 'ok' }, dir));
  assert.equal(readStatusline('ok', dir).sessionId, 'ok');
});

test('collector saves the payload, chains, and never breaks on bad input', () => {
  const cache = tmp();
  const env = { ...process.env, XDG_CACHE_HOME: cache };
  const bin = path.join(ROOT, 'bin', 'claude-statusline-collector.js');
  const payload = JSON.stringify({ session_id: 'abc', context_window: { context_window_size: 1000 } });
  const r = spawnSync(process.execPath, [bin, '--then', 'cat'], { input: payload, env, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, payload); // chained command got the same stdin
  const saved = readStatusline('abc', path.join(cache, 'herdr-context', 'claude-statusline'));
  assert.equal(saved.contextWindowSize, 1000);
  const bad = spawnSync(process.execPath, [bin], { input: 'not json', env, encoding: 'utf8' });
  assert.equal(bad.status, 0);
  assert.equal(bad.stdout, '');
});

test('context window: env > statusline > unknown', () => {
  assert.deepEqual(resolveContextWindow(null, {}), { size: null, source: 'unknown' });
  assert.deepEqual(resolveContextWindow({ contextWindowSize: 5000 }, {}), { size: 5000, source: 'statusline' });
  assert.deepEqual(resolveContextWindow({ contextWindowSize: 5000 }, { HERDR_CONTEXT_WINDOW: '9000' }), { size: 9000, source: 'env' });
  assert.deepEqual(resolveContextWindow(null, { HERDR_CONTEXT_WINDOW: 'junk' }), { size: null, source: 'unknown' });
});

test('discovery + load: sub-agents, statusline merge, percent', () => {
  const projects = tmp();
  const proj = path.join(projects, '-p');
  fs.mkdirSync(path.join(proj, 's-basic', 'subagents'), { recursive: true });
  fs.copyFileSync(path.join(FIX, 'basic.jsonl'), path.join(proj, 's-basic.jsonl'));
  fs.copyFileSync(path.join(FIX, 'compaction.jsonl'), path.join(proj, 's-basic', 'subagents', 'agent-x1.jsonl'));

  const entries = listClaudeSessions(projects);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].subagents.length, 1);

  const sl = tmp();
  writeStatusline({ session_id: 's-basic', context_window: { context_window_size: 2610, used_percentage: 50 }, rate_limits: { seven_day: { used_percentage: 12 } } }, sl);
  const snap = loadClaudeSession(entries[0], { statuslineDir: sl, env: {} });
  assert.equal(snap.context.tokens, 1305);
  assert.equal(snap.context.window, 2610);
  assert.equal(snap.context.percent, 0.5);
  assert.equal(snap.context.officialPercent, 50);
  assert.equal(snap.rateLimits.sevenDay.usedPercent, 12);
  assert.equal(snap.subagents[0].id, 'agent-x1');
  assert.equal(snap.subagents[0].requestCount, 3);
  assert.equal(snap.subagents[0].peakContextTokens, 8000);
  assert.equal(snap.parseIssues.malformedLines, 1);

  const noSl = loadClaudeSession(entries[0], { statuslineDir: tmp(), env: {} });
  assert.equal(noSl.context.percent, null);
});
