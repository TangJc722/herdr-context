// OPT-IN "direct" mode: read Claude Code's own OAuth access token (read-only)
// and ask Anthropic's usage endpoint, the way CodexBar and quota-axi do.
//
// Rules this module keeps:
// - Read-only: never writes, moves or rewrites Claude Code's credentials.
// - Never refreshes: an expired token is reported as expired, and the caller
//   falls back to sources that let Claude Code renew its own login. (Refreshing
//   here could rotate the refresh token out from under Claude Code.)
// - The token goes to api.anthropic.com only, in the Authorization header.
//
// Credential sources, in order:
//   CLAUDE_CODE_OAUTH_TOKEN (what a live session would use)
//   $CLAUDE_CONFIG_DIR/.credentials.json or ~/.claude/.credentials.json → claudeAiOauth
//   macOS Keychain item "Claude Code-credentials" (macOS may ask for permission)
// Endpoint: GET https://api.anthropic.com/api/oauth/usage
//   headers: Authorization: Bearer <token>, anthropic-beta: oauth-2025-04-20
//   body: {five_hour:{utilization,resets_at}, seven_day:{...}, seven_day_opus, seven_day_sonnet, ...}
//   (utilization = percent used). Not a documented public API.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { quota, runCommand, toIso, isExpired } from './common.js';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

function fromOauthObject(o, source) {
  if (!o || typeof o.accessToken !== 'string' || !o.accessToken) return null;
  return {
    token: o.accessToken,
    expiresAt: typeof o.expiresAt === 'number' ? o.expiresAt : null,
    scopes: Array.isArray(o.scopes) ? o.scopes : null,
    plan: o.subscriptionType ?? null,
    source,
  };
}

/** Finds a usable credential without changing anything. */
export function readClaudeCredential({ env = process.env, platform = process.platform, run = runCommand, readFile = fs.readFileSync } = {}) {
  if (env.CLAUDE_CODE_OAUTH_TOKEN) {
    return { token: env.CLAUDE_CODE_OAUTH_TOKEN, expiresAt: null, scopes: null, plan: null, source: 'CLAUDE_CODE_OAUTH_TOKEN' };
  }
  const dir = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  try {
    const c = fromOauthObject(JSON.parse(readFile(path.join(dir, '.credentials.json'), 'utf8')).claudeAiOauth, 'credentials file');
    if (c) return c;
  } catch {}
  if (platform === 'darwin') {
    const r = run('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], { timeoutMs: 15000, env });
    if (r.ok) {
      try {
        const c = fromOauthObject(JSON.parse(r.stdout.trim()).claudeAiOauth, 'macOS Keychain');
        if (c) return c;
      } catch {}
      return { error: 'the Keychain item has no Claude login (only MCP state?)' };
    }
  }
  return { error: 'no Claude Code login found on this machine' };
}

const WINDOWS = [
  ['five_hour', null, 'five_hour', '5h', 300],
  ['seven_day', 'seven_day_oauth_apps', 'seven_day', 'week', 10080],
  ['seven_day_sonnet', null, 'seven_day_sonnet', 'Sonnet week', 10080],
  ['seven_day_opus', null, 'seven_day_opus', 'Opus week', 10080],
];

export function mapClaudeUsage(body, { now = Date.now(), plan = null } = {}) {
  const windows = [];
  for (const [key, fallback, id, label, minutes] of WINDOWS) {
    const w = body?.[key] ?? (fallback ? body?.[fallback] : null);
    if (!w || typeof w.utilization !== 'number') continue;
    const win = { id, label, usedPercent: w.utilization, resetsAt: toIso(w.resets_at), windowMinutes: minutes };
    if (!isExpired(win, now)) windows.push(win);
  }
  const extra = body?.extra_usage;
  return quota('claude', 'claude oauth (direct)', {
    status: windows.length ? 'ok' : 'not_found',
    plan,
    observedAt: new Date(now).toISOString(),
    windows,
    credits: extra && typeof extra === 'object' ? { extraUsage: extra } : null,
    message: windows.length ? null : 'usage endpoint returned no windows',
  });
}

export async function claudeDirectQuota({ fetchFn = globalThis.fetch, now = Date.now(), timeoutMs = 10000, ...credOpts } = {}) {
  const fail = (status, message) => quota('claude', 'claude oauth (direct)', { status, message });
  const cred = readClaudeCredential(credOpts);
  if (cred.error) return fail('not_found', cred.error);
  if (cred.expiresAt != null && cred.expiresAt - now < 60_000) {
    return fail('error', 'access token expired; not refreshing it (Claude Code renews it the next time it runs)');
  }
  if (cred.scopes && !cred.scopes.includes('user:profile')) {
    return fail('error', 'this login lacks the user:profile scope needed to read usage');
  }
  let res;
  try {
    res = await fetchFn(USAGE_URL, {
      headers: { Authorization: `Bearer ${cred.token}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'herdr-context' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return fail('error', `usage request failed: ${e.name === 'TimeoutError' ? 'timed out' : e.message}`);
  }
  if (res.status === 401) return fail('error', 'token rejected (401); sign in to Claude Code again');
  if (res.status === 429) return fail('error', 'usage endpoint rate-limited (429); try again later');
  if (!res.ok) return fail('error', `usage endpoint answered HTTP ${res.status}`);
  let body;
  try {
    body = await res.json();
  } catch {
    return fail('error', 'usage endpoint returned non-JSON');
  }
  const q = mapClaudeUsage(body, { now, plan: cred.plan });
  q.message = [q.message, `credential: ${cred.source}`].filter(Boolean).join(' · ');
  return q;
}
