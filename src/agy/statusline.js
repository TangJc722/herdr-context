// agy passes a JSON payload to a custom statusLine command (interactive sessions
// only, not -p). Of it we keep the plan tier, which nothing else agy prints names
// ("plan_tier": "Antigravity Starter Quota"; agy 1.5.17), plus the version and the
// quota buckets. Never the account e-mail, which the payload carries too.
//
// In ~/.gemini/antigravity-cli/settings.json:
//   "statusLine": { "type": "command", "command": "node <...>/agy-statusline-collector.js", "stack_with_default": true }
// agy runs the command through cmd.exe on Windows and escapes double quotes on
// the way, so a quoted path with spaces does not work: use `node` from PATH.
import fs from 'node:fs';
import path from 'node:path';
import { quotaCacheDir } from '../quota/common.js';

export const agyStatuslineFile = (env = process.env) => path.join(quotaCacheDir(env), 'agy-statusline.json');

/** Saves what we use of a payload. Returns the written path, or null if unusable. */
export function writeAgyStatusline(payload, { env = process.env, now = new Date() } = {}) {
  if (!payload || typeof payload !== 'object' || payload.product && payload.product !== 'antigravity') return null;
  const planTier = typeof payload.plan_tier === 'string' && payload.plan_tier.trim() ? payload.plan_tier.trim() : null;
  const quota = payload.quota && typeof payload.quota === 'object' ? payload.quota : null;
  if (!planTier && !quota) return null;
  const file = agyStatuslineFile(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ receivedAt: now.toISOString(), planTier, version: payload.version ?? null, quota }));
  fs.renameSync(tmp, file);
  return file;
}

/** {receivedAt, planTier, version, quota} from the last payload, or null. */
export function readAgyStatusline({ env = process.env } = {}) {
  try {
    return JSON.parse(fs.readFileSync(agyStatuslineFile(env), 'utf8'));
  } catch {
    return null;
  }
}

/** "Antigravity Starter Quota" → "Starter", "Google AI Pro" → "AI Pro": short enough for a badge. */
export function shortPlan(tier) {
  const s = String(tier ?? '').trim().replace(/^(antigravity|google)\s+/i, '').replace(/\s+(quota|tier|plan)$/i, '').trim();
  return s || null;
}
