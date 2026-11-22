// Plain-text rendering of a session snapshot, for the CLI.
const SPARK = '▁▂▃▄▅▆▇█';
const LABELS = {
  systemAndTools: 'system+tools',
  systemPrompt: 'system prompt',
  toolDefinitions: 'tool definitions',
  user: 'your messages',
  assistant: 'replies',
  toolUse: 'tool calls',
  toolResult: 'tool results',
  injected: 'injected',
  compactSummary: 'compact summary',
  unattributed: 'unattributed',
};

export function fmt(n) {
  if (n == null) return '—';
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);

export function sparkline(values) {
  if (!values.length) return '';
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  return values.map((v) => SPARK[Math.round(((v - min) / span) * (SPARK.length - 1))]).join('');
}

export function bar(fraction, width = 24) {
  const f = Math.max(0, Math.min(1, fraction ?? 0));
  const full = Math.round(f * width);
  return '█'.repeat(full) + '░'.repeat(width - full);
}

export function renderQuotas({ providers, notes }) {
  const L = ['Subscription usage'];
  const width = Math.max(6, ...providers.map((p) => p.provider.length));
  for (const p of providers) {
    const name = p.provider.padEnd(width);
    const plan = p.plan ? ` [${p.plan}]` : '';
    if (p.status === 'not_found' || p.status === 'error') {
      L.push(`  ${name}  — ${p.status === 'error' ? 'error: ' : ''}${p.message ?? 'no data'}`);
      continue;
    }
    if (!p.windows.length) {
      L.push(`  ${name}${plan}  ${p.message ?? 'no windows'}`);
      continue;
    }
    const lw = Math.max(6, ...p.windows.map((w) => String(w.label).length)); // aligned within a provider
    p.windows.forEach((w, i) => {
      const lead = i === 0 ? `  ${name}` : `  ${' '.repeat(width)}`;
      const u = Math.round(w.usedPercent);
      const warn = u >= 90 ? ' ‼' : u >= 70 ? ' !' : '';
      const detail = w.detail ? ` · ${w.detail}` : '';
      const when = w.id === 'bonus' ? resets(w.resetsAt).replace('resets', 'expires') : resets(w.resetsAt);
      L.push(`${lead}  ${String(w.label).padEnd(lw)} ${bar(w.usedPercent / 100, 12)} ${String(u).padStart(3)}% used${warn}${when}${detail}${i === 0 ? plan : ''}`);
    });
    const tail = [p.status === 'stale' ? 'stale' : null, `via ${p.source}`, p.observedAt ? `as of ${p.observedAt.replace('T', ' ').slice(0, 16)}Z` : null, p.message].filter(Boolean);
    L.push(`  ${' '.repeat(width)}  ${tail.join(' · ')}`);
  }
  for (const n of notes || []) L.push(`  note: ${n}`);
  return L.join('\n');
}

function resets(at) {
  if (at == null) return '';
  const ms = (typeof at === 'number' ? (at < 1e12 ? at * 1000 : at) : Date.parse(at)) - Date.now();
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return ' (reset due)';
  const h = Math.floor(ms / 3.6e6);
  const m = Math.round((ms % 3.6e6) / 6e4);
  return h >= 24 ? ` (resets in ${Math.floor(h / 24)}d ${h % 24}h)` : ` (resets in ${h}h ${m}m)`;
}

export function renderSession(s) {
  const L = [];
  const id = s.sessionId ? s.sessionId.slice(0, 8) : '?';
  L.push(`${s.agent ?? 'claude'} · ${id} · ${s.cwd ?? '?'}${s.gitBranch ? ` (${s.gitBranch})` : ''} · ${s.model ?? '?'}${s.version ? ` · v${s.version}` : ''}`);

  const c = s.context;
  if (c.window) {
    const src = { model: ' · window from the model table', observed: ' · 1M window (a prompt went past 200k)' }[c.windowSource] ?? '';
    L.push(`  Context   ${bar(c.percent)} ${fmt(c.tokens)} / ${fmt(c.window)} (${pct(c.percent)})${src}`);
  } else {
    L.push(`  Context   ${fmt(c.tokens)} tokens  (window size unknown for this model: set HERDR_CONTEXT_WINDOW or install the statusLine collector)`);
  }
  if (c.officialPercent != null) L.push(`            Claude Code reports ${Math.round(c.officialPercent)}% used`);
  if (s.trend.length) L.push(`  Trend     ${sparkline(s.trend)}  ${s.requestCount} requests`);

  const t = s.totals;
  L.push(`  Tokens    in ${fmt(t.input)} · cache read ${fmt(t.cacheRead)} · cache write ${fmt(t.cacheWrite)} · out ${fmt(t.output)} (thinking ${fmt(t.thinking)}) · cache hit ${pct(t.cacheHitRate)}`);

  if (s.cost?.totalUSD != null) {
    const lines = s.cost.linesAdded != null ? ` · +${s.cost.linesAdded}/-${s.cost.linesRemoved} lines` : '';
    L.push(`  Cost      $${s.cost.totalUSD.toFixed(2)} (Claude Code's last saved total, all models incl. background)${lines}`);
  }

  if (s.rateLimits) {
    const w = (name, x) => (x?.usedPercent != null ? `${name} ${Math.round(x.usedPercent)}%${resets(x.resetsAt)}` : null);
    const parts = [w('5h', s.rateLimits.fiveHour), w('7d', s.rateLimits.sevenDay)].filter(Boolean);
    if (parts.length) L.push(`  Limits    ${parts.join(' · ')}`);
  }

  if (s.compactions.length) {
    const list = s.compactions.map((k) => `${k.trigger ?? '?'} ${fmt(k.preTokens)}→${fmt(k.postTokens)}`).join(', ');
    L.push(`  Compacted ${s.compactions.length}×: ${list}`);
  } else {
    L.push('  Compacted never');
  }

  if (s.composition) {
    const total = s.composition.total || 1;
    const parts = s.composition.parts
      .slice()
      .sort((a, b) => b.tokens - a.tokens)
      .map((p) => `${LABELS[p.category] ?? p.category} ${pct(p.tokens / total)}`);
    L.push(`  Makeup    ${parts.join(' · ')}  (estimated split)`);
    const tt = s.composition.topTools;
    if (tt?.length) L.push(`  Heaviest tool definitions  ${tt.slice(0, 5).map((x) => `${x.name} ${fmt(x.tokens)}`).join(' · ')}`);
  }

  const edited = s.files.filter((f) => f.edit + f.write > 0);
  const read = s.files.filter((f) => f.read > 0);
  if (s.files.length) {
    const top = s.files.slice(0, 5).map((f) => `${f.path}${f.edit + f.write ? ` ✎${f.edit + f.write}` : ''}${f.read ? ` 👁${f.read}` : ''}`);
    L.push(`  Files     ${edited.length} changed, ${read.length} read — ${top.join(', ')}`);
  }
  const tools = Object.entries(s.tools).slice(0, 8).map(([k, v]) => `${k} ${v}`);
  if (tools.length) L.push(`  Tools     ${tools.join(' · ')}`);
  if (s.subagents?.length) {
    const subs = s.subagents.map((a) => `${a.id.replace(/^agent-/, '').slice(0, 8)} (${a.requestCount} req, peak ${fmt(a.peakContextTokens)})`);
    L.push(`  Subagents ${subs.join(', ')}`);
  }
  const issues = s.parseIssues;
  const unknown = Object.keys(issues.unknownTypes);
  if (issues.malformedLines || unknown.length) {
    L.push(`  Parse     ${issues.malformedLines} malformed lines${unknown.length ? `; unknown record types: ${unknown.join(', ')}` : ''}`);
  }
  return L.join('\n');
}
