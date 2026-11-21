// Reads one Claude Code session (main log + sub-agent logs) into a snapshot,
// enriched with the statusLine payload when the collector has saved one.
import path from 'node:path';
import { JsonlTail } from '../jsonl-tail.js';
import { ClaudeSession } from './session.js';
import { readStatusline } from './statusline.js';

/**
 * Context window size: env override > statusLine payload > unknown.
 * The logs do not record it, and guessing from the model name gives wrong
 * percentages, so without a source we show token counts only.
 */
export function resolveContextWindow(statusline, env = process.env) {
  const override = Number(env.HERDR_CONTEXT_WINDOW);
  if (Number.isFinite(override) && override > 0) return { size: override, source: 'env' };
  if (statusline?.contextWindowSize) return { size: statusline.contextWindowSize, source: 'statusline' };
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
  const window = resolveContextWindow(statusline, opts.env);
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
