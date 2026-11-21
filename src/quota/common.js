// Shared shape for subscription usage, whatever the provider.
//
// ProviderQuota = {
//   provider: 'claude' | 'codex' | 'kiro' | <quota-axi provider id>,
//   source:   where the numbers came from (shown to the user),
//   status:   'ok' | 'stale' | 'not_found' | 'error',
//   plan:     string | null,
//   observedAt: ISO time the numbers were true, or null,
//   windows:  [{ id, label, usedPercent, resetsAt (ISO|null), windowMinutes|null, detail? }],
//   credits:  provider-specific extras or null,
//   message:  why not ok (not_found / error), or a caveat
// }
import { spawnSync } from 'node:child_process';

export function quota(provider, source, fields = {}) {
  return { provider, source, status: 'ok', plan: null, observedAt: null, windows: [], credits: null, message: null, ...fields };
}

/** Epoch seconds, epoch ms, or an ISO string → ISO string (null if unusable). */
export function toIso(v) {
  if (v == null || v === '') return null;
  let ms;
  if (typeof v === 'number') ms = v < 1e12 ? v * 1000 : v;
  else if (/^\d+(\.\d+)?$/.test(String(v))) return toIso(Number(v));
  else ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function windowLabel(minutes) {
  if (!minutes) return null;
  if (minutes === 300) return '5h';
  if (minutes === 10080) return 'week';
  if (minutes >= 40320 && minutes <= 44640) return 'month';
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

/** A window whose reset time has passed says nothing about now. */
export function isExpired(w, now = Date.now()) {
  return w.resetsAt != null && Date.parse(w.resetsAt) <= now;
}

/**
 * Runs a command without a shell. Returns {ok, stdout, stderr, notFound, timedOut}.
 * Injected into providers so tests can fake it.
 */
export function runCommand(cmd, args, { timeoutMs = 20000, env = process.env } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs, env, maxBuffer: 16 * 1024 * 1024 });
  return {
    ok: !r.error && r.status === 0,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    notFound: r.error?.code === 'ENOENT',
    timedOut: r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGTERM',
  };
}

export function stripAnsi(s) {
  // CSI / OSC sequences and stray ESC codes
  return s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b./g, '');
}
