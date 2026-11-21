// Folds Claude Code session-log records (~/.claude/projects/<project>/<session>.jsonl)
// into a running summary. Feed records in file order with apply(); call snapshot()
// at any time. Pure in-memory: reading files is the caller's job (see jsonl-tail.js).
//
// Facts this relies on (checked against Claude Code 2.1.x logs):
// - One API response is written as several "assistant" records (one per content
//   block) that share requestId and repeat the same usage. Usage must be
//   counted once per requestId, content blocks once per record.
// - The prompt size of a request = input_tokens + cache_read_input_tokens +
//   cache_creation_input_tokens. The latest request's prompt size is the
//   current context occupancy.
// - Compaction is a {type:"system", subtype:"compact_boundary",
//   compactMetadata:{trigger, preTokens}} record; the summary that follows is a
//   user record with isCompactSummary.
// - "cost-state" records carry Claude Code's own running cost totals.
import path from 'node:path';
import { estimateTokens, IMAGE_TOKENS_ESTIMATE } from '../estimate.js';

const CATEGORIES = ['user', 'assistant', 'toolUse', 'toolResult', 'injected', 'compactSummary'];
const FILE_TOOLS = {
  Read: ['file_path', 'read'],
  Edit: ['file_path', 'edit'],
  MultiEdit: ['file_path', 'edit'],
  Write: ['file_path', 'write'],
  NotebookEdit: ['notebook_path', 'edit'],
};
const KNOWN_TYPES = new Set([
  'user', 'assistant', 'system', 'attachment', 'cost-state', 'summary',
  'queue-operation', 'last-prompt', 'tools-used', 'mode', 'atis-latch',
  'file-history-snapshot',
]);

// Attachment records mix text the model sees (skill listings, reminders,
// queued prompts) with bookkeeping it never sees. Only these fields count.
const ATTACHMENT_TEXT_FIELDS = ['content', 'text', 'prompt', 'addedLines', 'addedBlocks', 'lines', 'context', 'date'];
const ATTACHMENT_SKIP = new Set(['prompt_snapshot', 'deferred_tools_record', 'environment', 'credential_org', 'remote_session_change', 'auto_mode']);

function attachmentTokens(a) {
  if (!a || typeof a !== 'object' || ATTACHMENT_SKIP.has(a.type)) return 0;
  return ATTACHMENT_TEXT_FIELDS.reduce((n, k) => n + (a[k] == null ? 0 : estimateTokens(a[k])), 0);
}

function emptySegment() {
  return Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
}

function blockTokens(block) {
  if (!block || typeof block !== 'object') return estimateTokens(block);
  if (block.type === 'image') return IMAGE_TOKENS_ESTIMATE;
  if (block.type === 'text') return estimateTokens(block.text);
  if (Array.isArray(block.content)) return block.content.reduce((n, b) => n + blockTokens(b), 0);
  if (block.content != null) return estimateTokens(block.content);
  return estimateTokens(block);
}

export class ClaudeSession {
  /**
   * @param {object} [opts]
   * @param {string} [opts.file] log path, for display only
   * @param {boolean} [opts.sidechainAsMain] true for sub-agent logs, whose
   *   records are all marked isSidechain
   */
  constructor(opts = {}) {
    this.file = opts.file ?? null;
    this.sidechainAsMain = !!opts.sidechainAsMain;
    this.sessionId = null;
    this.cwd = null;
    this.gitBranch = null;
    this.version = null;
    this.model = null;
    this.firstTs = null;
    this.lastTs = null;

    this.requests = []; // main-chain requests, in order
    this.seenRequests = new Set();
    this.sidechain = { requests: 0, promptTokens: 0, outputTokens: 0 };
    this.totals = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, thinking: 0 };

    this.segment = emptySegment(); // estimated tokens since the last compaction
    this.baseline = null; // estimated system prompt + tool definitions
    this.compactions = [];
    this.files = new Map();
    this.tools = new Map();
    this.cost = null;
    this.promptShape = null; // from prompt_snapshot records, when present
    this.unknownTypes = new Map();
  }

  apply(rec) {
    if (!rec || typeof rec !== 'object') return;
    if (!KNOWN_TYPES.has(rec.type)) {
      this.unknownTypes.set(rec.type, (this.unknownTypes.get(rec.type) || 0) + 1);
    }
    if (rec.sessionId && !this.sessionId) this.sessionId = rec.sessionId;
    if (rec.cwd) this.cwd = rec.cwd;
    if (rec.gitBranch !== undefined && rec.gitBranch !== null) this.gitBranch = rec.gitBranch;
    if (rec.version) this.version = rec.version;
    if (rec.timestamp) {
      if (!this.firstTs) this.firstTs = rec.timestamp;
      this.lastTs = rec.timestamp;
    }

    const side = rec.isSidechain && !this.sidechainAsMain;
    switch (rec.type) {
      case 'assistant': return this.#assistant(rec, side);
      case 'user': return side ? undefined : this.#user(rec);
      case 'attachment':
        if (side) return;
        if (rec.attachment?.type === 'prompt_snapshot') return this.#promptSnapshot(rec.attachment);
        this.segment.injected += attachmentTokens(rec.attachment);
        return;
      case 'system':
        if (rec.subtype === 'compact_boundary') this.#compaction(rec);
        return;
      case 'cost-state': return this.#cost(rec);
      default:
    }
  }

  #assistant(rec, side) {
    const msg = rec.message || {};
    const key = rec.requestId || msg.id || rec.uuid;
    const u = msg.usage;
    if (u && key && !this.seenRequests.has(key)) {
      this.seenRequests.add(key);
      const input = u.input_tokens || 0;
      const cacheRead = u.cache_read_input_tokens || 0;
      const cacheWrite = u.cache_creation_input_tokens || 0;
      const output = u.output_tokens || 0;
      const thinking = u.output_tokens_details?.thinking_tokens || 0;
      const prompt = input + cacheRead + cacheWrite;
      if (side) {
        this.sidechain.requests++;
        this.sidechain.promptTokens += prompt;
        this.sidechain.outputTokens += output;
      } else {
        if (this.baseline === null) {
          // Everything in the first prompt that is not the conversation so far.
          const conv = Object.values(this.segment).reduce((a, b) => a + b, 0);
          this.baseline = Math.max(0, prompt - conv);
        }
        this.requests.push({ ts: rec.timestamp || null, model: msg.model || null, input, cacheRead, cacheWrite, output, thinking, prompt });
        this.totals.input += input;
        this.totals.cacheRead += cacheRead;
        this.totals.cacheWrite += cacheWrite;
        this.totals.output += output;
        this.totals.thinking += thinking;
        if (msg.model && msg.model !== '<synthetic>') this.model = msg.model;
        const last = this.compactions[this.compactions.length - 1];
        if (last && last.postTokens === null) last.postTokens = prompt;
      }
    }

    for (const block of Array.isArray(msg.content) ? msg.content : []) {
      if (block?.type === 'tool_use') {
        this.tools.set(block.name, (this.tools.get(block.name) || 0) + 1);
        this.#fileActivity(block, rec.timestamp);
        if (!side) this.segment.toolUse += estimateTokens(block.input);
      } else if (block?.type === 'text' && !side) {
        this.segment.assistant += estimateTokens(block.text);
      }
      // thinking blocks: counted in output/thinking totals; previous turns'
      // thinking is generally not resent, so it is left out of composition.
    }
  }

  #user(rec) {
    const content = rec.message?.content;
    let cat = 'user';
    if (rec.isCompactSummary) cat = 'compactSummary';
    else if (rec.isMeta) cat = 'injected';
    if (typeof content === 'string') {
      this.segment[cat] += estimateTokens(content);
      return;
    }
    for (const block of Array.isArray(content) ? content : []) {
      const c = block?.type === 'tool_result' ? 'toolResult' : cat;
      this.segment[c] += blockTokens(block);
    }
  }

  // Internal record (seen in Claude Code 2.1.3xx) holding the system prompt and
  // tool definitions sent to the model. Optional: used only to split the
  // measured baseline into "system prompt" vs "tool definitions".
  #promptSnapshot(a) {
    const sys = Array.isArray(a.systemPrompt) ? estimateTokens(a.systemPrompt.join('\n')) : null;
    const tools = Array.isArray(a.tools)
      ? a.tools.map((t) => ({ name: t?.name ?? '?', tokens: estimateTokens(t) })).sort((x, y) => y.tokens - x.tokens)
      : null;
    this.promptShape = {
      systemPrompt: sys ?? this.promptShape?.systemPrompt ?? null,
      tools: tools ?? this.promptShape?.tools ?? null,
    };
  }

  #compaction(rec) {
    const m = rec.compactMetadata || {};
    this.compactions.push({
      ts: rec.timestamp || null,
      trigger: m.trigger ?? null,
      preTokens: typeof m.preTokens === 'number' ? m.preTokens : null,
      postTokens: null,
    });
    this.segment = emptySegment();
  }

  #cost(rec) {
    const byModel = {};
    for (const [model, mu] of Object.entries(rec.modelUsage || {})) {
      if (typeof mu?.costUSD === 'number') byModel[model] = mu.costUSD;
    }
    this.cost = {
      totalUSD: typeof rec.totalCostUSD === 'number' ? rec.totalCostUSD : null,
      byModel,
      linesAdded: rec.totalLinesAdded ?? null,
      linesRemoved: rec.totalLinesRemoved ?? null,
      apiDurationMs: rec.totalAPIDuration ?? null,
      unknownModelCost: !!rec.hasUnknownModelCost,
    };
  }

  #fileActivity(block, ts) {
    const spec = FILE_TOOLS[block.name];
    const p = spec && block.input?.[spec[0]];
    if (typeof p !== 'string') return;
    const f = this.files.get(p) || { read: 0, edit: 0, write: 0, lastTs: null };
    f[spec[1]]++;
    f.lastTs = ts || f.lastTs;
    this.files.set(p, f);
  }

  /** Current context split into categories. Measured total, estimated split. */
  composition() {
    const last = this.requests[this.requests.length - 1];
    if (!last) return null;
    const total = last.prompt;
    const baseline = Math.min(this.baseline ?? 0, total);
    const rest = total - baseline;
    const est = this.segment;
    const estSum = CATEGORIES.reduce((n, c) => n + est[c], 0);
    const parts = [];
    const shape = this.promptShape;
    const toolsEst = shape?.tools?.reduce((n, t) => n + t.tokens, 0) ?? 0;
    const sysEst = shape?.systemPrompt ?? 0;
    let topTools = null;
    // Split only when the snapshot had both parts: a snapshot with a system
    // prompt but no tool list says nothing about how big the tools are.
    if (toolsEst > 0 && sysEst > 0) {
      const toolTokens = Math.round((baseline * toolsEst) / (toolsEst + sysEst));
      parts.push({ category: 'systemPrompt', tokens: baseline - toolTokens });
      parts.push({ category: 'toolDefinitions', tokens: toolTokens });
      const scale = toolTokens / toolsEst;
      topTools = shape.tools.slice(0, 8).map((t) => ({ name: t.name, tokens: Math.round(t.tokens * scale) }));
    } else {
      parts.push({ category: 'systemAndTools', tokens: baseline });
    }
    if (estSum === 0) {
      parts.push({ category: 'unattributed', tokens: rest });
    } else {
      // Largest-remainder split: whole tokens that always add up to `rest`.
      const raw = CATEGORIES.map((c) => (rest * est[c]) / estSum);
      const whole = raw.map(Math.floor);
      let left = rest - whole.reduce((a, b) => a + b, 0);
      raw
        .map((x, i) => [x - whole[i], i])
        .sort((a, b) => b[0] - a[0])
        .forEach(([, i]) => {
          if (left > 0) {
            whole[i]++;
            left--;
          }
        });
      CATEGORIES.forEach((c, i) => parts.push({ category: c, tokens: whole[i] }));
    }
    return { total, estimated: true, parts: parts.filter((p) => p.tokens > 0), topTools };
  }

  snapshot({ trendLength = 40 } = {}) {
    const last = this.requests[this.requests.length - 1] || null;
    const t = this.totals;
    const promptAll = t.input + t.cacheRead + t.cacheWrite;
    const rel = (p) => (this.cwd && p.startsWith(this.cwd + path.sep) ? p.slice(this.cwd.length + 1) : p);
    return {
      agent: 'claude',
      sessionId: this.sessionId,
      file: this.file,
      cwd: this.cwd,
      gitBranch: this.gitBranch,
      version: this.version,
      model: this.model,
      firstTs: this.firstTs,
      lastTs: this.lastTs,
      requestCount: this.requests.length,
      contextTokens: last ? last.prompt : null,
      trend: this.requests.slice(-trendLength).map((r) => r.prompt),
      totals: { ...t, cacheHitRate: promptAll ? t.cacheRead / promptAll : null },
      compactions: this.compactions.map((c) => ({ ...c })),
      composition: this.composition(),
      files: [...this.files.entries()]
        .map(([p, f]) => ({ path: rel(p), ...f }))
        .sort((a, b) => b.edit + b.write - (a.edit + a.write) || b.read - a.read),
      tools: Object.fromEntries([...this.tools.entries()].sort((a, b) => b[1] - a[1])),
      cost: this.cost,
      sidechain: { ...this.sidechain },
      unknownTypes: Object.fromEntries(this.unknownTypes),
    };
  }
}
