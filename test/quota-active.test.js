// Active sources: codex app-server, Claude direct mode, claude /usage, and the
// order in which collectQuotas tries them. Nothing here starts the real claude
// or codex: the app-server is a fixture script, everything else is injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCodexRateLimits, codexRpcQuota, mapCodexRateLimits } from '../src/quota/codex-rpc.js';
import { readClaudeCredential, claudeDirectQuota, mapClaudeUsage } from '../src/quota/claude-direct.js';
import { parseClaudeUsage, claudeCliQuota, probeDir } from '../src/quota/claude-cli.js';
import { claudeBest, codexBest } from '../src/quota/index.js';
import { writeStatusline } from '../src/claude/statusline.js';

const FAKE_CODEX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-codex.js');
fs.chmodSync(FAKE_CODEX, 0o755);
const NOW = Date.now();
const S = (h) => Math.floor(NOW / 1000) + h * 3600;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hca-'));
const codexEnv = (mode) => ({ ...process.env, FAKE_CODEX_MODE: mode });

// ---------- codex app-server ----------
test('codex app-server: handshake, by-limit-id mapping, notifications ignored', async () => {
  const q = await codexRpcQuota({ bin: FAKE_CODEX, env: codexEnv('ok'), timeoutMs: 10000 });
  assert.equal(q.status, 'ok', q.message);
  assert.equal(q.source, 'codex app-server');
  assert.equal(q.plan, 'plus');
  assert.deepEqual(q.windows.map((w) => [w.label, w.usedPercent]), [['5h', 18], ['week', 47], ['GPT-5.5-Codex week', 60]]);
  assert.deepEqual(q.credits, { hasCredits: false, unlimited: false, balance: null });
});

test('codex app-server: signed out, crash, silence, missing binary', async () => {
  const out = await codexRpcQuota({ bin: FAKE_CODEX, env: codexEnv('signed_out') });
  assert.equal(out.status, 'not_found');
  assert.match(out.message, /not signed in/);

  const crash = await codexRpcQuota({ bin: FAKE_CODEX, env: codexEnv('crash') });
  assert.equal(crash.status, 'error');
  assert.match(crash.message, /exited \(1\): boom/);

  const t0 = Date.now();
  const silent = await readCodexRateLimits({ bin: FAKE_CODEX, env: codexEnv('silent'), timeoutMs: 400 });
  assert.equal(silent.timedOut, true);
  assert.ok(Date.now() - t0 < 3000);

  const missing = await codexRpcQuota({ bin: path.join(tmp(), 'no-codex') });
  assert.equal(missing.status, 'not_found');
  assert.equal(missing.message, 'codex CLI not installed');
});

test('codex app-server mapping: single bucket, expired windows, blocked usage', () => {
  const single = mapCodexRateLimits({ rateLimits: { primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: S(1) } } }, { now: NOW });
  assert.deepEqual(single.windows.map((w) => w.label), ['5h']);
  const expired = mapCodexRateLimits({ rateLimits: { primary: { usedPercent: 99, windowDurationMins: 300, resetsAt: S(-1) } } }, { now: NOW });
  assert.equal(expired.status, 'stale');
  const blocked = mapCodexRateLimits({ ordinaryUsageAllowed: false, rateLimits: { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: S(1) } } }, { now: NOW });
  assert.match(blocked.message, /blocked/);
});

// ---------- Claude direct ----------
function credDir(oauth) {
  const d = tmp();
  fs.writeFileSync(path.join(d, '.credentials.json'), JSON.stringify({ claudeAiOauth: oauth }));
  return d;
}
const GOOD_OAUTH = { accessToken: 'tok-123', refreshToken: 'ref-456', expiresAt: NOW + 3600e3, scopes: ['user:inference', 'user:profile'], subscriptionType: 'max' };

test('claude credential lookup: env token, credentials file, macOS keychain, none', () => {
  const noKeychain = () => assert.fail('keychain must not be read off macOS');
  assert.equal(readClaudeCredential({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'envtok' }, platform: 'linux', run: noKeychain }).source, 'CLAUDE_CODE_OAUTH_TOKEN');

  const file = readClaudeCredential({ env: { CLAUDE_CONFIG_DIR: credDir(GOOD_OAUTH) }, platform: 'linux', run: noKeychain });
  assert.equal(file.token, 'tok-123');
  assert.equal(file.plan, 'max');

  const calls = [];
  const kc = readClaudeCredential({
    env: { CLAUDE_CONFIG_DIR: tmp() },
    platform: 'darwin',
    run: (cmd, args) => {
      calls.push([cmd, ...args].join(' '));
      return { ok: true, stdout: JSON.stringify({ claudeAiOauth: GOOD_OAUTH }) + '\n', stderr: '' };
    },
  });
  assert.equal(kc.source, 'macOS Keychain');
  assert.deepEqual(calls, ['security find-generic-password -s Claude Code-credentials -w']);

  const mcpOnly = readClaudeCredential({ env: { CLAUDE_CONFIG_DIR: tmp() }, platform: 'darwin', run: () => ({ ok: true, stdout: '{"mcpOAuth":{}}', stderr: '' }) });
  assert.match(mcpOnly.error, /no Claude login/);
  assert.match(readClaudeCredential({ env: { CLAUDE_CONFIG_DIR: tmp() }, platform: 'linux' }).error, /no Claude Code login/);
});

test('claude direct: request shape, mapping, credentials left untouched', async () => {
  const dir = credDir(GOOD_OAUTH);
  const credFile = path.join(dir, '.credentials.json');
  const before = fs.readFileSync(credFile, 'utf8');
  let seen;
  const fetchFn = async (url, init) => {
    seen = { url, init };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        five_hour: { utilization: 31, resets_at: new Date(NOW + 2 * 3600e3).toISOString() },
        seven_day: null,
        seven_day_oauth_apps: { utilization: 12, resets_at: new Date(NOW + 90 * 3600e3).toISOString() },
        seven_day_opus: { utilization: 7, resets_at: new Date(NOW + 90 * 3600e3).toISOString() },
        extra_usage: { is_enabled: false },
      }),
    };
  };
  const q = await claudeDirectQuota({ fetchFn, now: NOW, env: { CLAUDE_CONFIG_DIR: dir }, platform: 'linux' });
  assert.equal(seen.url, 'https://api.anthropic.com/api/oauth/usage');
  assert.equal(seen.init.headers.Authorization, 'Bearer tok-123');
  assert.equal(seen.init.headers['anthropic-beta'], 'oauth-2025-04-20');
  assert.equal(q.status, 'ok');
  assert.equal(q.plan, 'max');
  assert.deepEqual(q.windows.map((w) => [w.label, w.usedPercent]), [['5h', 31], ['week', 12], ['Opus week', 7]]);
  assert.match(q.message, /credential: credentials file/);
  assert.ok(!JSON.stringify(q).includes('tok-123'), 'token must not leak into output');
  assert.equal(fs.readFileSync(credFile, 'utf8'), before);
});

test('claude direct: never refreshes an expired token; scope and HTTP errors', async () => {
  const noFetch = async () => assert.fail('must not call the endpoint');
  const expired = await claudeDirectQuota({ fetchFn: noFetch, now: NOW, env: { CLAUDE_CONFIG_DIR: credDir({ ...GOOD_OAUTH, expiresAt: NOW - 1 }) }, platform: 'linux' });
  assert.equal(expired.status, 'error');
  assert.match(expired.message, /expired; not refreshing/);

  const noScope = await claudeDirectQuota({ fetchFn: noFetch, now: NOW, env: { CLAUDE_CONFIG_DIR: credDir({ ...GOOD_OAUTH, scopes: ['user:inference'] }) }, platform: 'linux' });
  assert.match(noScope.message, /user:profile/);

  const env = { CLAUDE_CONFIG_DIR: credDir(GOOD_OAUTH) };
  for (const [status, re] of [[401, /rejected/], [429, /rate-limited/], [500, /HTTP 500/]]) {
    const q = await claudeDirectQuota({ fetchFn: async () => ({ ok: false, status }), now: NOW, env, platform: 'linux' });
    assert.match(q.message, re);
  }
  const thrown = await claudeDirectQuota({ fetchFn: async () => { throw new Error('ECONNRESET'); }, now: NOW, env, platform: 'linux' });
  assert.match(thrown.message, /ECONNRESET/);
  assert.equal(mapClaudeUsage({}, { now: NOW }).status, 'not_found');
});

// ---------- claude /usage ----------
// Synthetic, following CodexBar's description of the report (not a captured one).
const USAGE_REPORT = `\x1b[1mSettings: Usage\x1b[0m
 Current session
 ██████████▌                                        21% used
 Resets 3pm (America/Los_Angeles)

 Current week (all models)
 ███████████████████████▌                           47% used
 Resets Nov 25, 9am (America/Los_Angeles)

 Current week (Sonnet only)
 ███                                                92% left
 Resets Nov 25, 9am (America/Los_Angeles)

 What's contributing to your limits usage?
 Current week (Bash tool)  80% used
`;

test('claude /usage parser: blocks, used/left, resets text, insights ignored', () => {
  const w = parseClaudeUsage(USAGE_REPORT);
  assert.deepEqual(w.map((x) => [x.id, x.label, x.usedPercent]), [
    ['five_hour', '5h', 21],
    ['seven_day', 'week', 47],
    ['seven_day_sonnet', 'Sonnet week', 8],
  ]);
  assert.equal(w[0].detail, 'resets 3pm (America/Los_Angeles)');
  // What a login without a subscription prints (captured in this project's dev environment):
  const noPlan = 'Estimated cost:        $0.0000\nTotal duration (API):  0s\nUsage:                 0 input, 0 output, 0 cache read, 0 cache write\n';
  assert.deepEqual(parseClaudeUsage(noPlan), []);
});

test('claude /usage probe: hardened command in an isolated directory', () => {
  const env = { XDG_CACHE_HOME: tmp() };
  let call;
  const q = claudeCliQuota({ env, now: NOW, run: (cmd, args, o) => { call = { cmd, args, o }; return { ok: true, stdout: USAGE_REPORT, stderr: '' }; } });
  assert.equal(call.cmd, 'claude');
  assert.deepEqual(call.args.slice(0, 2), ['-p', '/usage']);
  for (const flag of ['--no-session-persistence', '--strict-mcp-config']) assert.ok(call.args.includes(flag), flag);
  assert.equal(call.args[call.args.indexOf('--tools') + 1], '');
  assert.deepEqual(JSON.parse(call.args[call.args.indexOf('--settings') + 1]), { disableAllHooks: true, remoteControlAtStartup: false });
  assert.equal(call.o.cwd, probeDir(env));
  assert.ok(fs.statSync(probeDir(env)).isDirectory());
  assert.equal(q.status, 'ok');
  assert.equal(q.windows.length, 3);

  assert.equal(claudeCliQuota({ env, run: () => ({ ok: false, notFound: true, stdout: '', stderr: '' }) }).status, 'not_found');
  assert.match(claudeCliQuota({ env, run: () => ({ ok: true, stdout: 'Estimated cost: $0', stderr: '' }) }).message, /no plan limits/);
});

// ---------- source order ----------
function counter(result) {
  const f = (...a) => { f.calls++; return typeof result === 'function' ? result(...a) : result; };
  f.calls = 0;
  return f;
}
const usageOk = { ok: true, stdout: USAGE_REPORT, stderr: '' };

test('claudeBest: fresh statusLine wins; stale → /usage (cached); passive; refresh', async () => {
  const env = { XDG_CACHE_HOME: tmp() };
  const sl = tmp();
  writeStatusline({ session_id: 'a', rate_limits: { five_hour: { used_percentage: 40, resets_at: S(2) } } }, sl, new Date(NOW - 60e3));
  const run = counter(usageOk);
  const fresh = await claudeBest({ now: NOW, env, statusline: { dir: sl, now: NOW }, cli: { run } });
  assert.equal(fresh.source, 'claude-statusline');
  assert.equal(run.calls, 0);

  const later = NOW + 20 * 60e3; // statusLine reading now 21 min old
  const a = await claudeBest({ now: later, env, statusline: { dir: sl, now: later }, cli: { run } });
  assert.equal(a.source, 'claude /usage');
  const b = await claudeBest({ now: later + 60e3, env, statusline: { dir: sl, now: later }, cli: { run } });
  assert.equal(b.source, 'claude /usage (cached)');
  assert.equal(run.calls, 1);
  await claudeBest({ now: later + 60e3, env, refresh: true, statusline: { dir: sl, now: later }, cli: { run } });
  assert.equal(run.calls, 2);

  const passive = await claudeBest({ now: later, env: { XDG_CACHE_HOME: tmp() }, active: false, statusline: { dir: sl, now: later }, cli: { run } });
  assert.equal(passive.source, 'claude-statusline');
  assert.equal(run.calls, 2);
});

test('claudeBest: direct is opt-in, used first, falls back with a note', async () => {
  const sl = tmp();
  writeStatusline({ session_id: 'a', rate_limits: { five_hour: { used_percentage: 40, resets_at: S(2) } } }, sl, new Date(NOW));
  const fetchFn = counter(async () => ({ ok: true, status: 200, json: async () => ({ five_hour: { utilization: 55, resets_at: new Date(NOW + 3600e3).toISOString() } }) }));
  const directOpts = { fetchFn, env: { CLAUDE_CONFIG_DIR: credDir(GOOD_OAUTH) }, platform: 'linux' };

  const off = await claudeBest({ now: NOW, env: { XDG_CACHE_HOME: tmp() }, statusline: { dir: sl, now: NOW }, directOpts });
  assert.equal(off.source, 'claude-statusline');
  assert.equal(fetchFn.calls, 0);

  const on = await claudeBest({ now: NOW, env: { XDG_CACHE_HOME: tmp() }, direct: true, statusline: { dir: sl, now: NOW }, directOpts });
  assert.equal(on.source, 'claude oauth (direct)');
  assert.equal(on.windows[0].usedPercent, 55);

  const expiredOpts = { fetchFn, env: { CLAUDE_CONFIG_DIR: credDir({ ...GOOD_OAUTH, expiresAt: NOW - 1 }) }, platform: 'linux' };
  const fb = await claudeBest({ now: NOW, env: { XDG_CACHE_HOME: tmp() }, direct: true, statusline: { dir: sl, now: NOW }, directOpts: expiredOpts });
  assert.equal(fb.source, 'claude-statusline');
  assert.match(fb.message, /direct: access token expired/);
});

test('codexBest: fresh logs win; otherwise app-server; failures keep log data', async () => {
  const home = tmp();
  const d = path.join(home, 'sessions', '2026', '11', '21');
  fs.mkdirSync(d, { recursive: true });
  const line = (ts) => JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', rate_limits: { limit_id: 'codex', primary: { used_percent: 9, window_minutes: 300, resets_at: S(2) } } } }) + '\n';

  fs.writeFileSync(path.join(d, 'rollout-a.jsonl'), line(new Date(NOW - 60e3).toISOString()));
  const fresh = await codexBest({ now: NOW, env: { XDG_CACHE_HOME: tmp() }, logs: { home, now: NOW }, rpc: { bin: path.join(tmp(), 'must-not-run') } });
  assert.equal(fresh.source, 'codex-rollout');

  fs.writeFileSync(path.join(d, 'rollout-a.jsonl'), line(new Date(NOW - 30 * 60e3).toISOString()));
  const viaRpc = await codexBest({ now: NOW, env: { ...codexEnv('ok'), XDG_CACHE_HOME: tmp() }, logs: { home, now: NOW }, rpc: { bin: FAKE_CODEX } });
  assert.equal(viaRpc.source, 'codex app-server');
  assert.equal(viaRpc.windows[0].usedPercent, 18);

  const signedOut = await codexBest({ now: NOW, env: { ...codexEnv('signed_out'), XDG_CACHE_HOME: tmp() }, logs: { home, now: NOW }, rpc: { bin: FAKE_CODEX } });
  assert.equal(signedOut.source, 'codex-rollout');
  assert.match(signedOut.message, /app-server: Codex is not signed in/);

  const passive = await codexBest({ now: NOW, active: false, logs: { home, now: NOW }, rpc: { bin: FAKE_CODEX } });
  assert.equal(passive.source, 'codex-rollout');
});
