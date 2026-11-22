// Shared shape for subscription usage, whatever the provider.
//
// ProviderQuota = {
//   provider: 'claude' | 'codex' | 'kiro' | 'agy' | <quota-axi provider id>,
//   source:   where the numbers came from (shown to the user),
//   status:   'ok' | 'stale' | 'not_found' | 'error',
//   plan:     string | null,
//   observedAt: ISO time the numbers were true, or null,
//   windows:  [{ id, label, usedPercent, resetsAt (ISO|null), windowMinutes|null, detail? }],
//   credits:  provider-specific extras or null,
//   message:  why not ok (not_found / error), or a caveat
// }
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function quotaCacheDir(env = process.env) {
  const base = env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, 'herdr-context', 'quota');
}

/** A cached ProviderQuota younger than ttlMs, or null. */
export function readCache(name, ttlMs, { env = process.env, now = Date.now() } = {}) {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(quotaCacheDir(env), `${name}.json`), 'utf8'));
    if (now - Date.parse(c.cachedAt) < ttlMs) return c.value;
  } catch {}
  return null;
}

export function writeCache(name, value, { env = process.env, now = Date.now() } = {}) {
  try {
    const dir = quotaCacheDir(env);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({ cachedAt: new Date(now).toISOString(), value }));
  } catch {}
}

/** Data observed less than maxAgeMs ago. */
export function isFresh(q, maxAgeMs, now = Date.now()) {
  return q?.status === 'ok' && q.observedAt != null && now - Date.parse(q.observedAt) < maxAgeMs;
}

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

// ---------- starting programs on Windows ----------
// Node starts .exe files by name, but npm installs CLIs (claude, codex,
// quota-axi) as .cmd shims, which Node can only start through a shell; by
// name alone they look "not installed". So on Windows we search PATH with
// PATHEXT ourselves: .exe/.com run directly; an npm shim runs its JavaScript
// entry with this Node (no shell, no quoting); any other .cmd/.bat goes
// through cmd.exe with cross-spawn-style escaping.

const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

/** The script an npm .cmd shim runs, e.g. `"%dp0%\node_modules\@openai\codex\bin\codex.js" %*`. */
export function npmShimTarget(shimPath, readFile = (p) => fs.readFileSync(p, 'utf8')) {
  let text;
  try {
    text = readFile(shimPath);
  } catch {
    return null;
  }
  const m = String(text).match(/"%~?dp0%?\\?([^"%]+?\.(?:js|cjs|mjs))"/i);
  return m ? path.win32.join(path.win32.dirname(shimPath), m[1]) : null;
}

function escapeCmdArg(arg, double) {
  let s = String(arg).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
  s = `"${s}"`;
  s = s.replace(/([()\][%!^"`<>&|;, *?])/g, '^$1');
  return double ? s.replace(/([()\][%!^"`<>&|;, *?])/g, '^$1') : s;
}

/**
 * How to start `cmd args` here: {file, args, windowsVerbatimArguments?}.
 * Options are injectable so the Windows logic is testable anywhere.
 */
export function commandLine(cmd, args = [], { platform = process.platform, env = process.env, exists = isFile, readFile, node = process.execPath } = {}) {
  if (platform !== 'win32') return { file: cmd, args };
  const w = path.win32;
  const exts = (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase());
  const dirs = /[\\/]/.test(cmd) ? [''] : (env.PATH ?? env.Path ?? '').split(';').filter(Boolean);
  const names = w.extname(cmd) ? [cmd] : exts.map((e) => cmd + e);
  for (const d of dirs) {
    for (const n of names) {
      const full = d ? w.join(d, n) : n;
      if (!exists(full)) continue;
      const ext = w.extname(full).toLowerCase();
      if (ext === '.cmd' || ext === '.bat') {
        const js = npmShimTarget(full, readFile);
        if (js && exists(js)) return { file: node, args: [js, ...args] };
        const line = [escapeCmdArg(full, false), ...args.map((a) => escapeCmdArg(a, true))].join(' ');
        return { file: env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], windowsVerbatimArguments: true };
      }
      return { file: full, args };
    }
  }
  return { file: cmd, args }; // not found: let spawn report ENOENT
}

/**
 * Runs a command without a shell. Returns {ok, stdout, stderr, notFound, timedOut}.
 * Injected into providers so tests can fake it.
 */
export function runCommand(cmd, args, { timeoutMs = 20000, env = process.env, cwd } = {}) {
  const c = commandLine(cmd, args, { env });
  const r = spawnSync(c.file, c.args, { encoding: 'utf8', timeout: timeoutMs, env, cwd, maxBuffer: 16 * 1024 * 1024, windowsVerbatimArguments: c.windowsVerbatimArguments });
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
