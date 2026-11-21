// Fresh Codex limits from Codex itself: `codex -s read-only -a never app-server`,
// the JSON-RPC interface Codex's IDE extensions use. Codex reads (and if needed
// renews) its own login; we never touch credentials. Same approach as CodexBar's
// "CLI RPC" source and quota-axi's Codex fallback.
//
// Wire format (codex-rs/app-server-protocol): one JSON object per line, JSON-RPC
// shape without the "jsonrpc" field.
//   → {"id":1,"method":"initialize","params":{"clientInfo":{name,title,version}}}
//   ← {"id":1,"result":{...}}
//   → {"method":"initialized"}
//   → {"id":2,"method":"account/rateLimits/read","params":{"excludeResetCreditDetails":true}}
//   ← {"id":2,"result":{"rateLimits":{...},"rateLimitsByLimitId":{...},"ordinaryUsageAllowed":...}}
// RateLimitSnapshot: {limitId, limitName, primary, secondary, credits, planType}
// RateLimitWindow:   {usedPercent, windowDurationMins, resetsAt (epoch s)}
import { spawn } from 'node:child_process';
import { quota, toIso, windowLabel, isExpired } from './common.js';

const VERSION = '0.1.0';

/**
 * Talks to a codex app-server child. Resolves {result} or {error, notFound?, timedOut?}.
 * @param {object} o
 * @param {string} [o.bin] codex executable
 * @param {number} [o.timeoutMs] whole exchange, including startup
 * @param {Function} [o.spawnFn] injectable for tests
 */
export function readCodexRateLimits({ bin = process.env.HERDR_CONTEXT_CODEX_BIN || 'codex', timeoutMs = 15000, spawnFn = spawn, env = process.env } = {}) {
  return new Promise((resolve) => {
    let child;
    let done = false;
    let buf = '';
    let stderr = '';
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child?.stdin?.end(); } catch {}
      try { child?.kill('SIGTERM'); } catch {}
      const k = setTimeout(() => { try { child?.kill('SIGKILL'); } catch {} }, 1000);
      k.unref?.();
      resolve(value);
    };
    const send = (msg) => {
      try { child.stdin.write(JSON.stringify(msg) + '\n'); } catch {}
    };
    const timer = setTimeout(() => finish({ error: 'codex app-server did not answer in time', timedOut: true }), timeoutMs);

    try {
      child = spawnFn(bin, ['-s', 'read-only', '-a', 'never', 'app-server'], { stdio: ['pipe', 'pipe', 'pipe'], env });
    } catch (e) {
      return finish({ error: e.message, notFound: e.code === 'ENOENT' });
    }
    child.on('error', (e) => finish({ error: e.message, notFound: e.code === 'ENOENT' }));
    child.on('close', (code) => finish({ error: `codex app-server exited (${code})${stderr ? `: ${stderr.trim().slice(0, 200)}` : ''}` }));
    child.stderr?.on('data', (d) => { stderr += d; });
    child.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          if (msg.error) return finish({ error: `initialize failed: ${msg.error.message ?? 'unknown'}` });
          send({ method: 'initialized' });
          send({ id: 2, method: 'account/rateLimits/read', params: { excludeResetCreditDetails: true } });
        } else if (msg.id === 2) {
          return finish(msg.error ? { error: msg.error.message ?? 'account/rateLimits/read failed' } : { result: msg.result });
        }
        // anything else (notifications, server requests) is ignored
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'herdr-context', title: 'herdr-context', version: VERSION } } });
  });
}

/** Maps a GetAccountRateLimitsResponse to a ProviderQuota. */
export function mapCodexRateLimits(result, { now = Date.now(), observedAt = new Date(now).toISOString() } = {}) {
  const byId = result?.rateLimitsByLimitId && Object.keys(result.rateLimitsByLimitId).length
    ? result.rateLimitsByLimitId
    : { [result?.rateLimits?.limitId ?? 'codex']: result?.rateLimits };
  const ordered = Object.entries(byId).filter(([, s]) => s).sort(([a], [b]) => (a === 'codex' ? -1 : b === 'codex' ? 1 : 0));
  const windows = [];
  let plan = null;
  let credits = null;
  let expired = 0;
  for (const [limitId, s] of ordered) {
    plan = plan ?? s.planType ?? null;
    credits = credits ?? s.credits ?? null;
    const prefix = limitId === 'codex' ? '' : `${s.limitName || limitId} `;
    for (const slot of ['primary', 'secondary']) {
      const w = s[slot];
      if (!w || typeof w.usedPercent !== 'number') continue;
      const minutes = typeof w.windowDurationMins === 'number' ? w.windowDurationMins : null;
      const win = {
        id: limitId === 'codex' ? slot : `${limitId}:${slot}`,
        label: prefix + (windowLabel(minutes) ?? slot),
        usedPercent: w.usedPercent,
        resetsAt: toIso(w.resetsAt),
        windowMinutes: minutes,
      };
      if (isExpired(win, now)) expired++;
      else windows.push(win);
    }
  }
  const blocked = result?.ordinaryUsageAllowed === false;
  return quota('codex', 'codex app-server', {
    status: windows.length ? 'ok' : expired ? 'stale' : 'not_found',
    plan,
    credits,
    observedAt,
    windows,
    message: blocked ? 'Codex reports usage is currently blocked for this account' : windows.length ? null : 'app-server returned no limit windows',
  });
}

export async function codexRpcQuota(opts = {}) {
  const r = await readCodexRateLimits(opts);
  if (r.result) return mapCodexRateLimits(r.result, opts);
  const signedOut = !r.notFound && /authentication required|not logged in|login/i.test(r.error || '');
  return quota('codex', 'codex app-server', {
    status: r.notFound || signedOut ? 'not_found' : 'error',
    message: r.notFound ? 'codex CLI not installed' : signedOut ? 'Codex is not signed in (run `codex login`)' : r.error,
  });
}
