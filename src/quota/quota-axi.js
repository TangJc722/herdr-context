// Other providers (Cursor, GitHub Copilot, Grok, Kimi, ...) through quota-axi
// (github.com/kunchenguid/quota-axi) when it is installed: `quota-axi --json`.
// quota-axi reads each CLI's own sign-in and asks the provider; we only map
// its normalized output (schemaVersion 5: providers[].windows[].percentRemaining).
import { quota, runCommand, toIso } from './common.js';

export function mapQuotaAxi(json) {
  const out = [];
  for (const p of Array.isArray(json?.providers) ? json.providers : []) {
    if (!p?.provider) continue;
    const windows = (Array.isArray(p.windows) ? p.windows : [])
      .filter((w) => typeof w?.percentRemaining === 'number')
      .map((w) => ({
        id: String(w.id ?? w.kind ?? 'window'),
        label: w.label ?? w.kind ?? String(w.id),
        usedPercent: 100 - w.percentRemaining,
        resetsAt: toIso(w.resetsAt),
        windowMinutes: null,
      }));
    const st = p.state || {};
    let status = windows.length ? 'ok' : 'not_found';
    if (windows.length && st.stale) status = 'stale';
    out.push(
      quota(p.provider, 'quota-axi', {
        status,
        plan: p.plan ?? null,
        observedAt: toIso(st.refreshedAt) ?? toIso(json.generatedAt),
        windows,
        message: windows.length ? null : (st.status ?? 'no windows reported'),
      }),
    );
  }
  return out;
}

/** @returns {{available:boolean, providers:object[], message?:string}} */
export function quotaAxi({ run = runCommand, env = process.env } = {}) {
  const r = run('quota-axi', ['--json'], { timeoutMs: 30000, env });
  if (r.notFound) return { available: false, providers: [], message: 'quota-axi not installed (npm i -g quota-axi) — needed for Cursor, Copilot and others' };
  let json;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    return { available: true, providers: [], message: `quota-axi gave no JSON${r.timedOut ? ' (timed out)' : ''}` };
  }
  return { available: true, providers: mapQuotaAxi(json) };
}
