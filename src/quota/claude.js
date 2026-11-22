// Claude subscription limits from the statusLine payloads saved by
// bin/claude-statusline-collector.js. No credentials, no network.
//
// Limits are per account, but each session only knows the figures from *its*
// last API response, so an idle session holds an older reading. Within one
// window (identified by its reset time) usage only rises, so the highest
// reading for the latest reset time is the most recent truth.
//
// The plan name comes from Claude Code's global config (claudePlan below),
// since neither the statusLine payload nor `/usage` carries it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cacheDir, normalizeStatusline } from '../claude/statusline.js';
import { quota, toIso, isExpired } from './common.js';

const WINDOWS = [
  ['fiveHour', 'five_hour', '5h', 300],
  ['sevenDay', 'seven_day', 'week', 10080],
];

export function claudeQuota({ dir = cacheDir(), now = Date.now() } = {}) {
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {}
  const readings = [];
  for (const f of files) {
    try {
      const saved = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const n = normalizeStatusline(saved.payload, saved.receivedAt ?? null);
      if (n?.rateLimits) readings.push(n);
    } catch {}
  }
  if (!readings.length) {
    return quota('claude', 'claude-statusline', {
      status: 'not_found',
      message: 'no statusLine readings yet: register bin/claude-statusline-collector.js as Claude Code\'s statusLine (subscription plans only)',
    });
  }

  const windows = [];
  let expired = 0;
  let observedAt = null;
  for (const [key, id, label, minutes] of WINDOWS) {
    let best = null;
    for (const r of readings) {
      const w = r.rateLimits[key];
      if (w?.usedPercent == null) continue;
      const cand = { id, label, usedPercent: w.usedPercent, resetsAt: toIso(w.resetsAt), windowMinutes: minutes, at: r.receivedAt };
      if (
        !best ||
        (cand.resetsAt ?? '') > (best.resetsAt ?? '') ||
        (cand.resetsAt === best.resetsAt && cand.usedPercent > best.usedPercent)
      ) best = cand;
    }
    if (!best) continue;
    if (isExpired(best, now)) {
      expired++;
      continue;
    }
    if (best.at && (!observedAt || best.at > observedAt)) observedAt = best.at;
    delete best.at;
    windows.push(best);
  }

  if (!windows.length) {
    return quota('claude', 'claude-statusline', {
      status: 'stale',
      message: expired ? 'last readings are from windows that have since reset; use Claude Code once to refresh' : 'statusLine payloads carry no rate limits (API-key login?)',
    });
  }
  return quota('claude', 'claude-statusline', { observedAt, windows });
}

/**
 * The signed-in plan ("pro", "max", ...) from Claude Code's global config,
 * $CLAUDE_CONFIG_DIR/.claude.json or ~/.claude.json: oauthAccount.organizationType
 * ("claude_pro"). That file holds no credentials. null when unknown.
 */
export function claudePlan({ env = process.env, file } = {}) {
  const f = file ?? path.join(env.CLAUDE_CONFIG_DIR || os.homedir(), '.claude.json');
  try {
    const t = JSON.parse(fs.readFileSync(f, 'utf8'))?.oauthAccount?.organizationType;
    if (typeof t !== 'string') return null;
    return t.replace(/^claude_/, '').replace(/_/g, ' ').trim() || null;
  } catch {
    return null;
  }
}
