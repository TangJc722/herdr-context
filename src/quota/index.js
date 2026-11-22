// All subscription usage on this machine in one list.
//
// Per provider, cheapest source first:
//   Claude: [direct OAuth, opt-in] → statusLine readings (if < 5 min old)
//           → `claude -p /usage` (cached 5 min) → statusLine readings (older)
//   Codex:  session logs (if < 5 min old) → `codex app-server` (cached 3 min)
//           → session logs (older)
//   Kiro:   `kiro-cli /usage` (cached 10 min)
//   others: quota-axi, which also stands in when a source above has nothing.
// `active: false` (CLI --passive) never starts claude/codex processes.
// `refresh: true` skips freshness checks and caches.
import { claudeQuota, claudePlan } from './claude.js';
import { claudeDirectQuota } from './claude-direct.js';
import { claudeCliQuota } from './claude-cli.js';
import { codexQuota } from './codex.js';
import { codexRpcQuota } from './codex-rpc.js';
import { kiroQuota } from './kiro.js';
import { quotaAxi } from './quota-axi.js';
import { readCache, writeCache, isFresh } from './common.js';

const GOOD = new Set(['ok', 'stale']);
const FRESH_MS = 5 * 60 * 1000;

function withNote(q, note) {
  if (!note) return q;
  return { ...q, message: [q.message, note].filter(Boolean).join(' · ') };
}

/** Cached run of an active probe; only successful results are cached. */
async function cached(name, ttlMs, probe, { refresh, env, now }) {
  if (!refresh) {
    const c = readCache(name, ttlMs, { env, now });
    if (c) return { ...c, source: `${c.source} (cached)` };
  }
  const q = await probe();
  if (GOOD.has(q.status)) writeCache(name, q, { env, now });
  return q;
}

export async function claudeBest(o = {}) {
  const q = await claudeSources(o);
  // only the direct source knows the plan; the others get it from Claude Code's config
  return q.plan ? q : { ...q, plan: claudePlan({ env: o.env ?? process.env, ...o.account }) };
}

async function claudeSources(o) {
  const { refresh = false, active = true, direct = false, now = Date.now(), env = process.env } = o;
  const notes = [];
  if (direct) {
    const d = await cached('claude-direct', 2 * 60 * 1000, () => claudeDirectQuota({ now, env, ...o.directOpts }), { refresh, env, now });
    if (GOOD.has(d.status)) return d;
    notes.push(`direct: ${d.message}`);
  }
  const local = claudeQuota({ now, ...o.statusline });
  if (!refresh && isFresh(local, FRESH_MS, now)) return withNote(local, notes.join('; '));
  if (active) {
    const cli = await cached('claude-cli', 5 * 60 * 1000, () => claudeCliQuota({ now, env, ...o.cli }), { refresh, env, now });
    if (GOOD.has(cli.status)) return withNote(cli, notes.join('; '));
    notes.push(`/usage: ${cli.message}`);
  }
  return withNote(local, notes.join('; '));
}

export async function codexBest(o = {}) {
  const { refresh = false, active = true, now = Date.now(), env = process.env } = o;
  const local = codexQuota({ now, ...o.logs });
  if (!active || (!refresh && isFresh(local, FRESH_MS, now))) return local;
  const rpc = await cached('codex-rpc', 3 * 60 * 1000, () => codexRpcQuota({ now, env, ...o.rpc }), { refresh, env, now });
  if (GOOD.has(rpc.status)) return rpc;
  return GOOD.has(local.status) || rpc.status === 'not_found' && local.status === 'not_found'
    ? withNote(local, `app-server: ${rpc.message}`)
    : rpc;
}

export async function collectQuotas(opts = {}) {
  const common = { refresh: opts.refresh, active: opts.active, now: opts.now, env: opts.env };
  const own = [
    await claudeBest({ ...common, direct: !!opts.direct, directOpts: opts.claudeDirect, statusline: opts.claude, cli: opts.claudeCli, account: opts.claudeAccount }),
    await codexBest({ ...common, logs: opts.codex, rpc: opts.codexRpc }),
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
