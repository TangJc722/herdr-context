import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { claudeQuota } from '../src/quota/claude.js';
import { codexQuota, lastRateLimits } from '../src/quota/codex.js';
import { parseKiroUsage, kiroQuota } from '../src/quota/kiro.js';
import { mapQuotaAxi, quotaAxi } from '../src/quota/quota-axi.js';
import { collectQuotas } from '../src/quota/index.js';
import { writeStatusline } from '../src/claude/statusline.js';
import { toIso, windowLabel, stripAnsi } from '../src/quota/common.js';
import { renderQuotas } from '../src/render.js';

const NOW = Date.parse('2026-11-21T12:00:00Z');
const S = (h) => Math.floor(NOW / 1000) + h * 3600; // epoch seconds, h hours from NOW
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hcq-'));
const fake = (map) => (cmd, args) => {
  const key = [cmd, ...args].join(' ');
  for (const [k, v] of Object.entries(map)) if (key.startsWith(k)) return { ok: true, stdout: '', stderr: '', notFound: false, timedOut: false, ...v };
  return { ok: false, stdout: '', stderr: '', notFound: true, timedOut: false };
};

// ---------- common ----------
test('toIso / windowLabel / stripAnsi', () => {
  const iso = new Date(NOW).toISOString();
  assert.equal(toIso(NOW / 1000), iso); // epoch seconds
  assert.equal(toIso(NOW), iso); // epoch ms
  assert.equal(toIso(String(NOW / 1000)), iso);
  assert.equal(toIso(iso), iso);
  assert.equal(toIso('nope'), null);
  assert.equal(windowLabel(300), '5h');
  assert.equal(windowLabel(10080), 'week');
  assert.equal(windowLabel(43200), 'month');
  assert.equal(stripAnsi('\x1b[1;32mKIRO\x1b[0m'), 'KIRO');
});

// ---------- claude ----------
test('claude: highest reading of the current window across sessions wins', () => {
  const dir = tmp();
  writeStatusline({ session_id: 'old', rate_limits: { five_hour: { used_percentage: 20, resets_at: S(2) }, seven_day: { used_percentage: 40, resets_at: S(50) } } }, dir, new Date(NOW - 60e3));
  writeStatusline({ session_id: 'new', rate_limits: { five_hour: { used_percentage: 35, resets_at: S(2) }, seven_day: { used_percentage: 41, resets_at: S(50) } } }, dir, new Date(NOW));
  writeStatusline({ session_id: 'expired', rate_limits: { five_hour: { used_percentage: 99, resets_at: S(-3) } } }, dir, new Date(NOW - 6 * 3600e3));
  const q = claudeQuota({ dir, now: NOW });
  assert.equal(q.status, 'ok');
  assert.deepEqual(q.windows.map((w) => [w.label, w.usedPercent]), [['5h', 35], ['week', 41]]);
  assert.equal(q.windows[0].resetsAt, new Date(S(2) * 1000).toISOString());
});

test('claude: nothing collected / only expired readings', () => {
  assert.equal(claudeQuota({ dir: tmp(), now: NOW }).status, 'not_found');
  const dir = tmp();
  writeStatusline({ session_id: 'x', rate_limits: { five_hour: { used_percentage: 80, resets_at: S(-1) } } }, dir);
  assert.equal(claudeQuota({ dir, now: NOW }).status, 'stale');
});

// ---------- codex ----------
function rollout(lines) {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}
const tc = (ts, rl) => ({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1 } }, rate_limits: rl } });

function codexHomeWith(files) {
  const home = tmp();
  for (const [rel, body, mtime] of files) {
    const p = path.join(home, 'sessions', rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
    if (mtime) fs.utimesSync(p, mtime / 1000, mtime / 1000);
  }
  return home;
}

test('codex: last rate-limit snapshot per limit, null snapshots ignored', () => {
  const text = rollout([
    { timestamp: 't0', type: 'session_meta', payload: { id: 'abc' } },
    tc('t1', { limit_id: 'codex', primary: { used_percent: 10, window_minutes: 300, resets_at: S(4) }, secondary: { used_percent: 30, window_minutes: 10080, resets_at: S(90) }, plan_type: 'plus' }),
    tc('t2', null),
    { timestamp: 't3', type: 'response_item', payload: { type: 'message', content: 'mentions "token_count" and rate_limits' } },
    tc('t4', { limit_id: 'codex', primary: { used_percent: 12.5, window_minutes: 300, resets_at: S(4) }, secondary: { used_percent: 31, window_minutes: 10080, resets_at: S(90) }, plan_type: 'plus' }),
    tc('t5', { limit_id: 'codex_bengalfox', limit_name: 'GPT-5.5-Codex', primary: { used_percent: 50, window_minutes: 10080, resets_at: S(90) } }),
  ]);
  const snaps = lastRateLimits(text + '{"broken json');
  assert.equal(snaps.size, 2);
  assert.equal(snaps.get('codex').at, 't4');
  assert.equal(snaps.get('codex').rl.primary.used_percent, 12.5);
});

test('codex: newest session wins; compressed .zst logs are read', () => {
  const older = rollout([tc('2026-11-20T08:00:00Z', { limit_id: 'codex', primary: { used_percent: 5, window_minutes: 300, resets_at: S(1) } })]);
  const newer = rollout([
    tc('2026-11-21T11:00:00Z', { limit_id: 'codex', primary: { used_percent: 22, window_minutes: 300, resets_at: S(3) }, secondary: { used_percent: 61, window_minutes: 10080, resets_at: S(80) }, plan_type: 'pro', credits: { has_credits: true, unlimited: false, balance: '12.50' } }),
    tc('2026-11-21T11:00:01Z', { limit_id: 'codex_bengalfox', limit_name: 'GPT-5.5-Codex', primary: { used_percent: 50, window_minutes: 10080, resets_at: S(80) } }),
  ]);
  const home = codexHomeWith([
    ['2026/11/20/rollout-2026-11-20T08-00-00-aaa.jsonl.zst', zlib.zstdCompressSync(Buffer.from(older)), NOW - 864e5],
    ['2026/11/21/rollout-2026-11-21T11-00-00-bbb.jsonl', newer, NOW - 60e3],
  ]);
  const q = codexQuota({ home, now: NOW });
  assert.equal(q.status, 'ok');
  assert.equal(q.plan, 'pro');
  assert.deepEqual(q.credits, { has_credits: true, unlimited: false, balance: '12.50' });
  assert.deepEqual(q.windows.map((w) => [w.label, w.usedPercent]), [['5h', 22], ['week', 61], ['GPT-5.5-Codex week', 50]]);

  // only the compressed file: still readable
  const zhome = codexHomeWith([['2026/11/20/rollout-x.jsonl.zst', zlib.zstdCompressSync(Buffer.from(rollout([tc('t', { primary: { used_percent: 7, window_minutes: 300, resets_at: S(1) } })])))]]);
  assert.equal(codexQuota({ home: zhome, now: NOW }).windows[0].usedPercent, 7);
});

test('codex: missing, empty and expired', () => {
  assert.equal(codexQuota({ home: tmp(), now: NOW }).status, 'not_found');
  const empty = codexHomeWith([['2026/11/21/rollout-a.jsonl', rollout([tc('t', null)])]]);
  assert.equal(codexQuota({ home: empty, now: NOW }).status, 'not_found');
  const exp = codexHomeWith([['2026/11/21/rollout-a.jsonl', rollout([tc('t', { primary: { used_percent: 90, window_minutes: 300, resets_at: S(-1) } })])]]);
  assert.equal(codexQuota({ home: exp, now: NOW }).status, 'stale');
});

// ---------- kiro ----------
// The free-plan report as documented in CodexBar's docs/kiro.md, with ANSI colour added.
const KIRO_FREE = `\x1b[1m┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓\x1b[0m
┃                                         | \x1b[32mKIRO FREE\x1b[0m      ┃
┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┫
┃ Monthly credits:                                  ┃
┃ ████████████████████████████████ 100% (resets on 01/01) ┃
┃                    (0.00 of 50 covered in plan)    ┃
┃ Bonus credits:                                    ┃
┃ 0.00/100 credits used, expires in 88 days         ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛`;

test('kiro: free-plan report (numbers win over the ambiguous bar)', () => {
  const r = parseKiroUsage(KIRO_FREE, NOW);
  assert.equal(r.plan, 'KIRO FREE');
  assert.equal(r.caveat, null);
  const [month, bonus] = r.windows;
  assert.equal(month.usedPercent, 0); // 0.00 of 50, although the bar says 100%
  assert.equal(month.detail, '0 of 50 credits');
  assert.equal(month.resetsAt, new Date(2027, 0, 1).toISOString());
  assert.equal(bonus.usedPercent, 0);
  assert.equal(bonus.resetsAt, new Date(NOW + 88 * 864e5).toISOString());
});

test('kiro: paid report with usage, bar-only report, plan-only summary, junk', () => {
  // Synthetic: same layout, different numbers.
  const pro = KIRO_FREE.replace('KIRO FREE', 'KIRO PRO+').replace('100% (resets on 01/01)', '41% (resets on 12/01)').replace('0.00 of 50', '820.50 of 2,000').replace(/Bonus credits:[\s\S]*?days/, '');
  const r = parseKiroUsage(pro, NOW);
  assert.equal(r.plan, 'KIRO PRO+');
  assert.equal(r.windows.length, 1);
  assert.equal(Math.round(r.windows[0].usedPercent * 100) / 100, 41.03);
  assert.equal(r.windows[0].resetsAt, new Date(2026, 11, 1).toISOString());

  const barOnly = parseKiroUsage('| KIRO PRO\n████ 37% (resets on 12/05)', NOW);
  assert.equal(barOnly.windows[0].usedPercent, 37);
  assert.match(barOnly.caveat, /unverified/);

  const planOnly = parseKiroUsage('Plan: KIRO PRO MAX | 1 usage breakdowns', NOW);
  assert.equal(planOnly.plan, 'KIRO PRO MAX');
  assert.equal(planOnly.windows.length, 0);

  assert.equal(parseKiroUsage('Error: not logged in', NOW), null);
});

test('kiro: CLI handling — not installed, --v2 fallback, cache, login hint', () => {
  const env = { XDG_CACHE_HOME: tmp() };
  assert.equal(kiroQuota({ run: fake({}), env, now: NOW }).status, 'not_found');

  const calls = [];
  const run = (cmd, args) => {
    calls.push(args.join(' '));
    if (args.includes('--v2')) return { ok: false, stdout: '', stderr: "error: unexpected argument '--v2' found", notFound: false, timedOut: false };
    return { ok: true, stdout: KIRO_FREE, stderr: '', notFound: false, timedOut: false };
  };
  const q = kiroQuota({ run, env, now: NOW });
  assert.equal(q.status, 'ok');
  assert.deepEqual(calls, ['chat --no-interactive /usage --v2', 'chat --no-interactive /usage']);

  const cached = kiroQuota({ run: () => assert.fail('should use cache'), env, now: NOW + 60e3 });
  assert.equal(cached.source, 'kiro-cli (cached)');
  assert.equal(cached.plan, 'KIRO FREE');
  assert.equal(kiroQuota({ run, env, now: NOW + 11 * 60e3 }).source, 'kiro-cli'); // cache expired

  const login = kiroQuota({ run: fake({ 'kiro-cli': { ok: false, stderr: 'Please log in first' } }), env: { XDG_CACHE_HOME: tmp() }, now: NOW });
  assert.equal(login.status, 'error');
  assert.match(login.message, /kiro-cli login/);
});

// ---------- quota-axi ----------
const AXI = {
  generatedAt: '2026-11-21T11:59:00.000Z',
  schemaVersion: 5,
  providers: [
    { provider: 'claude', plan: 'max', windows: [{ id: 'five_hour', label: 'session', kind: 'session', percentRemaining: 82, resetsAt: '2026-11-21T15:00:00.000Z' }], state: { status: 'fresh', stale: false } },
    { provider: 'cursor', plan: 'pro', windows: [{ id: 'monthly', label: 'month', kind: 'monthly', percentRemaining: 30, resetsAt: '2026-12-01T00:00:00.000Z' }], state: { status: 'fresh', stale: false } },
    { provider: 'copilot', windows: [], state: { status: 'signed_out' } },
  ],
};

test('quota-axi: windows mapped to % used; missing tool reported', () => {
  const m = mapQuotaAxi(AXI);
  assert.deepEqual(m.map((p) => [p.provider, p.status]), [['claude', 'ok'], ['cursor', 'ok'], ['copilot', 'not_found']]);
  assert.equal(m[1].windows[0].usedPercent, 70);
  assert.equal(m[2].message, 'signed_out');
  assert.equal(quotaAxi({ run: fake({}) }).available, false);
  assert.equal(quotaAxi({ run: fake({ 'quota-axi': { stdout: JSON.stringify(AXI) } }) }).providers.length, 3);
});

// ---------- all together ----------
test('collectQuotas: local sources first, quota-axi fills gaps and adds providers', () => {
  const sl = tmp();
  writeStatusline({ session_id: 's', rate_limits: { five_hour: { used_percentage: 40, resets_at: S(2) } } }, sl);
  const axiRun = fake({ 'quota-axi': { stdout: JSON.stringify(AXI) } });
  const r = collectQuotas({
    claude: { dir: sl, now: NOW },
    codex: { home: tmp(), now: NOW }, // no local Codex data
    kiro: { run: fake({ 'kiro-cli': { stdout: KIRO_FREE } }), env: { XDG_CACHE_HOME: tmp() }, now: NOW },
    quotaAxi: { run: axiRun },
  });
  const by = Object.fromEntries(r.providers.map((p) => [p.provider, p]));
  assert.equal(by.claude.source, 'claude-statusline'); // local beats quota-axi
  assert.equal(by.claude.windows[0].usedPercent, 40);
  assert.equal(by.codex.status, 'not_found'); // quota-axi had no codex either
  assert.equal(by.kiro.plan, 'KIRO FREE');
  assert.equal(by.cursor.source, 'quota-axi');
  assert.ok(by.copilot);

  const text = renderQuotas(r);
  assert.match(text, /cursor .*month .* 70% used/);
  assert.match(text, /kiro .*KIRO FREE/);

  const noAxi = collectQuotas({ claude: { dir: sl, now: NOW }, codex: { home: tmp() }, kiro: { run: fake({}), env: { XDG_CACHE_HOME: tmp() } }, axi: false });
  assert.deepEqual(noAxi.providers.map((p) => p.provider), ['claude', 'codex', 'kiro']);
});
