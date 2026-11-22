// Reads one Claude Code session (main log + sub-agent logs) into a snapshot,
// enriched with the statusLine payload when the collector has saved one.
import path from 'node:path';
import { JsonlTail } from '../jsonl-tail.js';
import { ClaudeSession } from './session.js';
import { readStatusline } from './statusline.js';
import { modelWindow, canExtendTo1M } from './models.js';

/**
 * Context window size. The log does not record it, so, most reliable first:
 *   env        HERDR_CONTEXT_WINDOW
 *   statusline Claude Code's own number, when the collector is installed
 *   observed   a prompt above 200k proves a 1M window
 *   model      Claude Code's model table (200k models can run at 1M with the
 *              "[1m]" suffix, which only the two sources above can see)
 * @param {{model?:string, peakTokens?:number}} [seen] what the log shows
 */
export function resolveContextWindow(statusline, env = process.env, seen = {}) {
  const override = Number(env.HERDR_CONTEXT_WINDOW);
  if (Number.isFinite(override) && override > 0) return { size: override, source: 'env' };
  if (statusline?.contextWindowSize) return { size: statusline.contextWindowSize, source: 'statusline' };
  const byModel = modelWindow(seen.model);
  if (byModel && byModel < 1_000_000 && (seen.peakTokens ?? 0) > byModel && canExtendTo1M(seen.model)) {
    return { size: 1_000_000, source: 'observed' };
  }
  if (byModel) return { size: byModel, source: 'model' };
  return { size: null, source: 'unknown' };
}

function parseFile(file, opts) {
  const session = new ClaudeSession({ file, ...opts });
  const tail = new JsonlTail(file);
  for (const rec of tail.readNew()) session.apply(rec);
  return { session, malformed: tail.malformed };
}

/**
 * @param {{file:string, subagents?:string[]}} entry from listClaudeSessions()
 * @param {{statuslineDir?:string, env?:object}} [opts]
 */
export function loadClaudeSession(entry, opts = {}) {
  const { session, malformed } = parseFile(entry.file);
  const snap = session.snapshot();

  snap.subagents = (entry.subagents || []).map((f) => {
    const { session: s } = parseFile(f, { sidechainAsMain: true });
    const r = s.snapshot({ trendLength: 0 });
    return {
      id: path.basename(f, '.jsonl'),
      model: r.model,
      requestCount: r.requestCount,
      peakContextTokens: Math.max(0, ...s.requests.map((q) => q.prompt)),
      outputTokens: r.totals.output,
      tools: r.tools,
    };
  });

  const statusline = readStatusline(snap.sessionId, opts.statuslineDir);
  // only the current model's requests: a session can switch models
  const peakTokens = Math.max(0, ...session.requests.filter((q) => q.model === snap.model).map((q) => q.prompt));
  const window = resolveContextWindow(statusline, opts.env, { model: snap.model, peakTokens });
  snap.context = {
    tokens: snap.contextTokens,
    window: window.size,
    windowSource: window.source,
    percent: snap.contextTokens == null || !window.size ? null : snap.contextTokens / window.size,
    officialPercent: statusline?.contextUsedPercent ?? null,
  };
  snap.rateLimits = statusline?.rateLimits ?? null;
  snap.statuslineAt = statusline?.receivedAt ?? null;
  snap.parseIssues = { malformedLines: malformed, unknownTypes: snap.unknownTypes };
  delete snap.unknownTypes;
  delete snap.contextTokens;
  return snap;
}
