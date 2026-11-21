// Codex subscription limits from its own session logs. No credentials, no network.
//
// $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl[.zst]
// Each line: {"timestamp", "type": "event_msg", "payload": {"type": "token_count",
//   "info": {...}, "rate_limits": {"limit_id", "primary": {"used_percent",
//   "window_minutes", "resets_at"}, "secondary": {...}, "credits", "plan_type"}}}
// (from codex-rs/protocol TokenCountEvent / RateLimitSnapshot and
//  codex-rs/history RolloutItemWire). Cold files are compressed to .jsonl.zst.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { quota, toIso, windowLabel, isExpired } from './common.js';

export function codexHome(env = process.env) {
  return env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

/** Newest rollout files first. Walks only the most recent day folders. */
export function listRollouts(sessionsDir, { maxFiles = 8 } = {}) {
  const out = [];
  const dirs = (d) => {
    try {
      return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse();
    } catch {
      return [];
    }
  };
  for (const y of dirs(sessionsDir)) {
    for (const m of dirs(path.join(sessionsDir, y))) {
      for (const d of dirs(path.join(sessionsDir, y, m))) {
        const dir = path.join(sessionsDir, y, m, d);
        for (const f of fs.readdirSync(dir)) {
          if (/^rollout-.*\.jsonl(\.zst)?$/.test(f)) {
            const p = path.join(dir, f);
            out.push({ path: p, mtimeMs: fs.statSync(p).mtimeMs });
          }
        }
        if (out.length >= maxFiles) return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
      }
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function readRollout(p) {
  const buf = fs.readFileSync(p);
  if (!p.endsWith('.zst')) return buf.toString('utf8');
  if (typeof zlib.zstdDecompressSync !== 'function') throw new Error('this Node has no zstd support (needs Node 22.15+)');
  return zlib.zstdDecompressSync(buf).toString('utf8');
}

/** Last rate-limit snapshot per limit id in one rollout's text. */
export function lastRateLimits(text) {
  const byLimit = new Map();
  for (const line of text.split('\n')) {
    if (!line.includes('"token_count"') || !line.includes('rate_limits')) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const p = rec.type === 'event_msg' ? rec.payload : null;
    if (p?.type !== 'token_count' || !p.rate_limits) continue;
    byLimit.set(p.rate_limits.limit_id ?? 'codex', { at: rec.timestamp ?? null, rl: p.rate_limits });
  }
  return byLimit;
}

function toWindow(id, w) {
  if (!w || typeof w.used_percent !== 'number') return null;
  const minutes = typeof w.window_minutes === 'number' ? w.window_minutes : null;
  return { id, label: windowLabel(minutes) ?? id, usedPercent: w.used_percent, resetsAt: toIso(w.resets_at), windowMinutes: minutes };
}

export function codexQuota({ home = codexHome(), now = Date.now() } = {}) {
  const files = listRollouts(path.join(home, 'sessions'));
  if (!files.length) {
    return quota('codex', 'codex-rollout', { status: 'not_found', message: `no Codex session logs under ${path.join(home, 'sessions')}` });
  }
  const errors = [];
  for (const f of files) {
    let snaps;
    try {
      snaps = lastRateLimits(readRollout(f.path));
    } catch (e) {
      errors.push(`${path.basename(f.path)}: ${e.message}`);
      continue;
    }
    if (!snaps.size) continue;

    // The main Codex limit first, then any per-model limits.
    const ordered = [...snaps.entries()].sort(([a], [b]) => (a === 'codex' ? -1 : b === 'codex' ? 1 : 0));
    const windows = [];
    let plan = null;
    let credits = null;
    let observedAt = null;
    let expired = 0;
    for (const [limitId, { at, rl }] of ordered) {
      plan = plan ?? rl.plan_type ?? null;
      credits = credits ?? rl.credits ?? null;
      if (at && (!observedAt || at > observedAt)) observedAt = at;
      const prefix = limitId === 'codex' ? '' : `${rl.limit_name || limitId} `;
      for (const [slot, w] of [['primary', rl.primary], ['secondary', rl.secondary]]) {
        const win = toWindow(limitId === 'codex' ? slot : `${limitId}:${slot}`, w);
        if (!win) continue;
        win.label = prefix + win.label;
        if (isExpired(win, now)) expired++;
        else windows.push(win);
      }
    }
    if (!windows.length) {
      return quota('codex', 'codex-rollout', { status: 'stale', plan, credits, observedAt, message: expired ? 'last readings are from windows that have since reset; use Codex once to refresh' : 'no usable windows' });
    }
    return quota('codex', 'codex-rollout', { plan, credits, observedAt, windows });
  }
  return quota('codex', 'codex-rollout', {
    status: errors.length ? 'error' : 'not_found',
    message: errors.length ? errors.join('; ') : 'recent Codex sessions carry no rate-limit events yet',
  });
}
