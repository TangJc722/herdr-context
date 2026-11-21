// Claude Code passes a JSON payload to its statusLine command on every refresh.
// The collector (bin/claude-statusline-collector.js) saves it per session;
// this module reads it back. It is the only *official* source for the
// context-window size and the 5-hour / 7-day subscription limits, and any of
// its fields may be missing or null (early in a session, on API-key auth, ...).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function cacheDir() {
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, 'herdr-context', 'claude-statusline');
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Normalizes a raw statusLine payload; unknown or missing fields become null. */
export function normalizeStatusline(raw, receivedAt = null) {
  if (!raw || typeof raw !== 'object') return null;
  const cw = raw.context_window || {};
  const window = (w) =>
    w && typeof w === 'object'
      ? { usedPercent: num(w.used_percentage), resetsAt: w.resets_at ?? null }
      : null;
  const rl = raw.rate_limits || {};
  return {
    sessionId: raw.session_id ?? null,
    receivedAt,
    model: raw.model?.id ?? null,
    contextWindowSize: num(cw.context_window_size),
    contextUsedPercent: num(cw.used_percentage),
    rateLimits: {
      fiveHour: window(rl.five_hour),
      sevenDay: window(rl.seven_day),
    },
    costUSD: num(raw.cost?.total_cost_usd),
  };
}

export function readStatusline(sessionId, dir = cacheDir()) {
  if (!sessionId || /[\\/]/.test(sessionId)) return null;
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(dir, `${sessionId}.json`), 'utf8'));
    return normalizeStatusline(saved.payload, saved.receivedAt ?? null);
  } catch {
    return null;
  }
}

/** Saves a payload atomically. Returns the written path, or null if unusable. */
export function writeStatusline(payload, dir = cacheDir(), now = new Date()) {
  const id = payload?.session_id;
  if (typeof id !== 'string' || !id || /[\\/]/.test(id)) return null;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ receivedAt: now.toISOString(), payload }));
  fs.renameSync(tmp, file);
  return file;
}
