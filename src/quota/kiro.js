// Kiro credits via its own CLI: `kiro-cli chat --no-interactive "/usage"`.
// There is no documented quota API, so this parses the human-readable report.
// Format reference: CodexBar's Kiro notes (docs/kiro.md), e.g.
//
//   ┃                                     | KIRO FREE      ┃
//   ┃ Monthly credits:                                    ┃
//   ┃ ████████████████ 100% (resets on 01/01)             ┃
//   ┃              (0.00 of 50 covered in plan)           ┃
//   ┃ Bonus credits:                                      ┃
//   ┃ 0.00/100 credits used, expires in 88 days           ┃
//
// Caveats: each run starts a (non-interactive) chat session, takes seconds,
// and the CLI saves an empty session for it. Results are therefore cached.
// Kiro CLI v3 may send slash commands to the model, so `--v2` is passed and
// dropped only if the CLI rejects it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { quota, runCommand, stripAnsi } from './common.js';

const CACHE_TTL_MS = 10 * 60 * 1000;

function cacheFile(env = process.env) {
  const base = env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, 'herdr-context', 'quota', 'kiro.json');
}

/** "MM/DD" → the next such date at local midnight, as ISO. */
function nextDate(mm, dd, now) {
  const today = new Date(now);
  let d = new Date(today.getFullYear(), mm - 1, dd);
  if (d.getTime() <= now - 24 * 3600 * 1000) d = new Date(today.getFullYear() + 1, mm - 1, dd);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Parses the /usage report. Returns null when nothing recognisable is found. */
export function parseKiroUsage(raw, now = Date.now()) {
  const text = stripAnsi(raw).replace(/[┃│]/g, ' ');
  const planMatch = text.match(/\|\s*(KIRO[^\n|]*?)\s*(?:\n|$)/i) || text.match(/Plan:\s*(KIRO[^|\n]*)/i);
  const plan = planMatch ? planMatch[1].trim().replace(/\s{2,}/g, ' ') : null;

  const windows = [];
  const credits = {};
  let caveat = null;

  const covered = text.match(/\(?\s*([\d.,]+)\s+of\s+([\d.,]+)\s+covered in plan/i);
  const barPct = text.match(/[█▓▒░■□]+\s*([\d.]+)%(?:\s*\(resets on (\d{1,2})\/(\d{1,2})\))?/);
  const resetOnly = text.match(/resets on (\d{1,2})\/(\d{1,2})/i);
  const reset = barPct?.[2] ? [barPct[2], barPct[3]] : resetOnly ? [resetOnly[1], resetOnly[2]] : null;
  const resetsAt = reset ? nextDate(Number(reset[0]), Number(reset[1]), now) : null;

  if (covered) {
    const used = Number(covered[1].replace(/,/g, ''));
    const limit = Number(covered[2].replace(/,/g, ''));
    if (limit > 0) {
      windows.push({ id: 'monthly', label: 'month', usedPercent: (used / limit) * 100, resetsAt, windowMinutes: 43200, detail: `${used} of ${limit} credits` });
      credits.plan = { used, limit };
    }
  } else if (barPct) {
    // Without the "X of Y" line we cannot tell whether the bar shows used or left.
    windows.push({ id: 'monthly', label: 'month', usedPercent: Number(barPct[1]), resetsAt, windowMinutes: 43200 });
    caveat = 'monthly % read from the bar only; unverified whether Kiro shows used or remaining';
  }

  const bonus = text.match(/([\d.,]+)\s*\/\s*([\d.,]+)\s+credits used(?:,\s*expires in (\d+) days?)?/i);
  if (bonus && /bonus/i.test(text)) {
    const used = Number(bonus[1].replace(/,/g, ''));
    const limit = Number(bonus[2].replace(/,/g, ''));
    if (limit > 0) {
      const expires = bonus[3] ? new Date(now + Number(bonus[3]) * 864e5).toISOString() : null;
      windows.push({ id: 'bonus', label: 'bonus', usedPercent: (used / limit) * 100, resetsAt: expires, windowMinutes: null, detail: `${used} of ${limit} bonus credits` });
      credits.bonus = { used, limit, expiresAt: expires };
    }
  }

  if (!plan && !windows.length) return null;
  return { plan, windows, credits: Object.keys(credits).length ? credits : null, caveat };
}

export function kiroQuota({ run = runCommand, env = process.env, now = Date.now(), refresh = false } = {}) {
  const file = cacheFile(env);
  if (!refresh) {
    try {
      const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (now - Date.parse(cached.observedAt) < CACHE_TTL_MS) return { ...cached, source: 'kiro-cli (cached)' };
    } catch {}
  }

  let r = run('kiro-cli', ['chat', '--no-interactive', '/usage', '--v2'], { timeoutMs: 20000, env });
  if (r.notFound) return quota('kiro', 'kiro-cli', { status: 'not_found', message: 'kiro-cli is not installed' });
  if (!r.ok && /unexpected argument|unknown (option|flag)|--v2/i.test(r.stderr)) {
    r = run('kiro-cli', ['chat', '--no-interactive', '/usage'], { timeoutMs: 20000, env });
  }
  if (r.timedOut) return quota('kiro', 'kiro-cli', { status: 'error', message: 'kiro-cli /usage timed out' });

  const parsed = parseKiroUsage(`${r.stdout}\n${r.stderr}`, now);
  if (!parsed) {
    const hint = /log ?in|sign ?in|auth/i.test(r.stderr + r.stdout) ? ' (logged in? run `kiro-cli login`)' : '';
    return quota('kiro', 'kiro-cli', { status: 'error', message: `could not read kiro-cli /usage output${hint}` });
  }
  const result = quota('kiro', 'kiro-cli', {
    plan: parsed.plan,
    observedAt: new Date(now).toISOString(),
    windows: parsed.windows,
    credits: parsed.credits,
    message: parsed.caveat,
    status: parsed.windows.length ? 'ok' : 'stale',
  });
  if (!parsed.windows.length) result.message = 'plan found but no credit figures (managed / organization account?)';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(result));
  } catch {}
  return result;
}
