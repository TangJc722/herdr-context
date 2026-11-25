// Antigravity (agy) model quota via its own CLI: `agy -p /usage --output-format json`.
// Print mode runs the /usage slash command locally: no model call (num_turns 0,
// zero tokens), no conversation saved, about 10 s. Uses agy's own Google login.
// Output (agy 2026-11):
//   {"status":"SUCCESS","num_turns":0,"command":{"name":"usage","data":{"groups":[
//     {"name":"Gemini Models","buckets":[{"id":"gemini-weekly","window":"weekly",
//       "remaining_fraction":0.97,"reset_time":"2026-11-29T09:26:23Z"}]},
//     {"name":"Claude and GPT models","buckets":[{"id":"3p-weekly", ...}]}]}}}
// The text form ("Gemini Models\tWeekly Limit Remaining\t97%\t<reset>") is the fallback.
import fs from 'node:fs';
import path from 'node:path';
import { quota, runCommand, stripAnsi, quotaCacheDir, toIso, readCache, writeCache } from './common.js';

const CACHE_TTL_MS = 10 * 60 * 1000;
const BLOCK_MS = 24 * 3600 * 1000;
const WINDOW_MINUTES = { weekly: 10080, daily: 1440, monthly: 43200, '5h': 300 };
const WINDOW_WORD = { weekly: 'week', daily: 'day', monthly: 'month', '5h': '5h' };

/** A reset time, or null for agy's "not started" (1970-01-01: the window has not been used). */
function resetTime(v) {
  const iso = toIso(v);
  return iso && Date.parse(iso) > 86400000 ? iso : null;
}

/** "Gemini Models" → "Gemini", "Claude and GPT models" → "Claude/GPT". */
function groupLabel(name) {
  return String(name ?? '').replace(/\s*models?\s*$/i, '').replace(/\s+and\s+/i, '/').trim() || 'agy';
}

function windowFrom(group, b) {
  const minutes = WINDOW_MINUTES[b.window] ?? null;
  const word = WINDOW_WORD[b.window] ?? b.window ?? '';
  const remaining = Number(b.remaining_fraction);
  if (!Number.isFinite(remaining)) return null;
  return {
    id: b.id || `${groupLabel(group)}-${b.window}`,
    label: `${groupLabel(group)} ${word}`.trim(),
    usedPercent: Math.round((1 - remaining) * 10000) / 100,
    resetsAt: resetTime(b.reset_time),
    windowMinutes: minutes,
  };
}

/** Windows from agy's /usage output (JSON, else the tab-separated text). null when unreadable. */
export function parseAgyUsage(raw) {
  const text = stripAnsi(String(raw ?? ''));
  const start = text.indexOf('{');
  if (start !== -1) {
    try {
      const o = JSON.parse(text.slice(start, text.lastIndexOf('}') + 1));
      const groups = o?.command?.data?.groups;
      if (Array.isArray(groups)) {
        const windows = groups.flatMap((g) => (g.buckets ?? []).map((b) => windowFrom(g.name, b))).filter(Boolean);
        return { windows };
      }
      if (typeof o?.response === 'string') return parseAgyUsage(o.response);
    } catch {}
  }
  const windows = [];
  for (const line of text.split('\n')) {
    const cols = line.split('\t').map((c) => c.trim());
    const pct = cols[2]?.match(/^([\d.]+)%$/);
    if (cols.length < 3 || !pct) continue;
    const kind = /week/i.test(cols[1]) ? 'weekly' : /five hour|5 ?h/i.test(cols[1]) ? '5h' : null;
    windows.push({
      id: `${groupLabel(cols[0])}-${kind ?? 'window'}`.toLowerCase(),
      label: `${groupLabel(cols[0])}${kind ? ` ${WINDOW_WORD[kind]}` : ''}`,
      usedPercent: Math.round((100 - Number(pct[1])) * 100) / 100,
      resetsAt: resetTime(cols[3]),
      windowMinutes: kind ? WINDOW_MINUTES[kind] : null,
    });
  }
  return windows.length ? { windows } : null;
}

/** Where agy runs for the probe: an empty folder of ours, so no project is touched. */
export function agyProbeDir(env = process.env) {
  return path.join(quotaCacheDir(env), 'agy-probe');
}

/**
 * Where agy's installer puts it, for when it is not on PATH: a program started
 * before agy was installed (Herdr, say) still has the old PATH.
 */
export function agyInstalled({ env = process.env, platform = process.platform, exists = fs.existsSync } = {}) {
  const local = env.LOCALAPPDATA;
  const f = platform === 'win32' && local ? path.win32.join(local, 'agy', 'bin', 'agy.exe') : null;
  return f && exists(f) ? f : null;
}

export function agyQuota({ run = runCommand, env = process.env, now = Date.now(), refresh = false, timeoutMs = 45000, platform = process.platform, exists } = {}) {
  if (!refresh) {
    const c = readCache('agy', CACHE_TTL_MS, { env, now });
    if (c) return { ...c, source: 'agy /usage (cached)' };
  }
  // a failed check (network, sign-in) keeps the last reading, with the reason
  const lastOr = (message) => {
    const c = readCache('agy', Infinity, { env, now });
    return c ? { ...c, source: 'agy /usage (last reading)', message: `now: ${message}` } : quota('agy', 'agy /usage', { status: 'error', message });
  };
  // /usage once went to the model instead (an agy without the command): don't spend quota again soon
  const blocked = readCache('agy-blocked', BLOCK_MS, { env, now });
  if (blocked && !refresh) return lastOr(blocked.message);
  const cwd = agyProbeDir(env);
  try {
    fs.mkdirSync(cwd, { recursive: true });
  } catch {}
  // its own log file: each run would otherwise add one to agy's log folder (144 a day)
  const args = ['-p', '/usage', '--output-format', 'json', '--log-file', path.join(cwd, 'agy.log')];
  let r = run('agy', args, { timeoutMs, env, cwd });
  const installed = r.notFound ? agyInstalled({ env, platform, exists }) : null;
  if (installed) r = run(installed, args, { timeoutMs, env, cwd });
  if (r.notFound) return quota('agy', 'agy /usage', { status: 'not_found', message: 'agy (Antigravity CLI) is not installed' });
  if (r.timedOut) return lastOr('agy /usage timed out');
  const turns = Number(`${r.stdout}`.match(/"num_turns":\s*(\d+)/)?.[1] ?? 0);
  if (turns > 0) {
    const message = 'agy answered /usage with the model, not the command: not asking again for a day (Refresh retries)';
    writeCache('agy-blocked', { message }, { env, now });
    return lastOr(message);
  }
  const parsed = parseAgyUsage(`${r.stdout}\n${r.stderr}`);
  if (!parsed || !parsed.windows.length) {
    const why = (r.stdout + r.stderr).match(/"error":"((?:[^"\\]|\\.)*)"/)?.[1] ?? r.stderr.split('\n')[0];
    const hint = /log ?in|sign ?in|auth/i.test(r.stderr + r.stdout) ? ' (signed in? run `agy` once)' : '';
    return lastOr(`could not read agy /usage output${hint}${why ? `: ${why.replace(/\\"/g, '"').slice(0, 160)}` : ''}`);
  }
  const result = quota('agy', 'agy /usage', { observedAt: new Date(now).toISOString(), windows: parsed.windows });
  writeCache('agy', result, { env, now });
  return result;
}
