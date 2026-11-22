import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadCodexSession } from '../src/codex/load.js';
import { patchFiles, readFiles, shellCommand } from '../src/codex/session.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (n) => path.join(here, 'fixtures', 'codex', n);

test('codex rollout: context, window and totals come from token_count', () => {
  const s = loadCodexSession({ file: fx('rollout-basic.jsonl') });
  assert.equal(s.agent, 'codex');
  assert.equal(s.sessionId, '0199aaaa-bbbb-cccc-dddd-eeeeffff0001');
  assert.equal(s.cwd, '/work/app');
  assert.equal(s.gitBranch, 'main');
  assert.equal(s.model, 'gpt-5.5-codex');
  assert.equal(s.isSubagent, false);
  // the repeated token_count (same totals) is not a new request
  assert.equal(s.requestCount, 4);
  assert.deepEqual(s.trend, [9200, 21500, 21920, 10080]);
  assert.deepEqual(s.context, { tokens: 10080, window: 272000, windowSource: 'log', percent: 10080 / 272000, officialPercent: null });
  assert.equal(s.totals.cacheRead, 33000);
  assert.equal(s.totals.input, 29000);
  assert.equal(s.parseIssues.malformedLines, 1);
});

test('codex rollout: compaction, makeup and files', () => {
  const s = loadCodexSession({ file: fx('rollout-basic.jsonl') });
  assert.deepEqual(s.compactions.map((c) => [c.preTokens, c.postTokens]), [[21920, 10080]]);
  const c = s.composition;
  assert.equal(c.parts.reduce((n, p) => n + p.tokens, 0), c.total);
  const cats = c.parts.map((p) => p.category);
  assert.ok(cats.includes('compactSummary') && cats.includes('user') && cats.includes('systemAndTools'));
  assert.ok(!cats.includes('toolResult'), 'results from before the compaction are gone');
  const files = Object.fromEntries(s.files.map((f) => [f.path, [f.read, f.edit, f.write]]));
  assert.deepEqual(files, { 'src/lib.rs': [1, 1, 0], 'tests/add.rs': [0, 0, 1], 'Cargo.toml': [1, 0, 0] });
  assert.deepEqual(s.tools, { exec_command: 1, apply_patch: 1, shell: 1 });
});

test('codex sub-agent threads are flagged', () => {
  assert.equal(loadCodexSession({ file: fx('rollout-subagent.jsonl') }).isSubagent, true);
});

test('codex helpers: patches, shell commands, reads', () => {
  assert.deepEqual(patchFiles('*** Begin Patch\n*** Add File: a.txt\n+x\n*** Update File: b/c.rs\n*** Delete File: d\n*** End Patch'), [
    { path: 'a.txt', kind: 'write' }, { path: 'b/c.rs', kind: 'edit' }, { path: 'd', kind: 'edit' },
  ]);
  assert.equal(shellCommand('shell', JSON.stringify({ command: ['bash', '-lc', 'ls -la'] })), 'ls -la');
  assert.equal(shellCommand('exec_command', { cmd: 'cat x' }), 'cat x');
  assert.equal(shellCommand('shell', 'not json'), null);
  assert.deepEqual(readFiles("sed -n '1,80p' src/a.rs && nl -ba b.py | head -n 40; cat -n c"), ['src/a.rs', 'b.py']);
  assert.deepEqual(readFiles('rg foo src'), []);
});

test('CLI lists Claude and Codex sessions together and skips sub-agents', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-codex-'));
  const day = path.join(tmp, 'codex', 'sessions', '2026', '11', '20');
  fs.mkdirSync(day, { recursive: true });
  fs.copyFileSync(fx('rollout-basic.jsonl'), path.join(day, 'rollout-2026-11-20T10-00-00-0199aaaa.jsonl'));
  fs.copyFileSync(fx('rollout-subagent.jsonl'), path.join(day, 'rollout-2026-11-20T10-05-00-0199aaab.jsonl'));
  fs.mkdirSync(path.join(tmp, 'claude'));
  const cli = path.join(here, '..', 'bin', 'herdr-context.js');
  const env = { ...process.env, CODEX_HOME: path.join(tmp, 'codex') };
  const rows = JSON.parse(execFileSync(process.execPath, [cli, '--list', '--json', '--dir', path.join(tmp, 'claude')], { env }).toString());
  assert.deepEqual(rows.map((r) => [r.agent, r.sessionId]), [['codex', '0199aaaa-bbbb-cccc-dddd-eeeeffff0001']]);
  const none = JSON.parse(execFileSync(process.execPath, [cli, '--list', '--json', '--agent', 'claude', '--dir', path.join(tmp, 'claude')], { env }).toString() || '[]');
  assert.deepEqual(none, []);
  const text = execFileSync(process.execPath, [cli, '--dir', path.join(tmp, 'claude')], { env }).toString();
  assert.match(text, /^codex · 0199aaaa · \/work\/app \(main\) · gpt-5\.5-codex/);
  assert.match(text, /10k \/ 272k \(4%\)/);
});
