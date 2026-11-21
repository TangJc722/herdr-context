// All subscription usage on this machine in one list.
// Local sources first (Claude statusLine, Codex logs, Kiro CLI); quota-axi
// fills in every other provider and stands in when a local source has nothing.
import { claudeQuota } from './claude.js';
import { codexQuota } from './codex.js';
import { kiroQuota } from './kiro.js';
import { quotaAxi } from './quota-axi.js';

const GOOD = new Set(['ok', 'stale']);

export function collectQuotas(opts = {}) {
  const own = [
    claudeQuota(opts.claude),
    codexQuota(opts.codex),
    kiroQuota({ refresh: opts.refresh, ...opts.kiro }),
  ];
  const notes = [];
  let axi = { available: false, providers: [] };
  if (opts.axi !== false) {
    axi = quotaAxi(opts.quotaAxi);
    if (axi.message) notes.push(axi.message);
  }

  const result = [];
  for (const q of own) {
    const alt = axi.providers.find((p) => p.provider === q.provider);
    result.push(!GOOD.has(q.status) && alt && GOOD.has(alt.status) ? alt : q);
  }
  for (const p of axi.providers) {
    if (!result.some((q) => q.provider === p.provider)) result.push(p);
  }
  return { generatedAt: new Date().toISOString(), providers: result, notes };
}
