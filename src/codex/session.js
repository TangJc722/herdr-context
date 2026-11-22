// Folds a Codex rollout log ($CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl)
// into the same snapshot shape as ClaudeSession, so the CLI and the mod can
// show either agent. Pure in-memory: feed records in file order with apply().
//
// Facts this relies on (codex-rs: history/src/rollout_payload.rs RolloutItemWire,
// protocol/src/models.rs ResponseItem, protocol/src/protocol.rs TokenUsageInfo):
// - Each line is {timestamp, type, payload}: type is session_meta, turn_context,
//   response_item, compacted or event_msg (and a few others we ignore).
// - event_msg/token_count carries info = {total_token_usage, last_token_usage,
//   model_context_window}. Codex's own "tokens in context window" is
//   last_token_usage.total_tokens, and the window size is in the log.
//   The same event is repeated without new usage (e.g. for rate-limit
//   updates); those repeats are skipped.
// - input_tokens includes cached_input_tokens.
// - "compacted" (payload {message, replacement_history}) marks a compaction.
// - response_item payloads: message {role, content[]}, function_call
//   {name, arguments}, function_call_output {output}, custom_tool_call
//   {name, input} (apply_patch), custom_tool_call_output, local_shell_call,
//   web_search_call, reasoning (encrypted: left out of the split).
import { estimateTokens } from '../estimate.js';

const CATEGORIES = ['user', 'assistant', 'toolUse', 'toolResult', 'injected', 'compactSummary'];
const KNOWN_TYPES = new Set(['session_meta', 'turn_context', 'response_item', 'compacted', 'event_msg']);
// User-role messages Codex writes itself (environment, AGENTS.md, instructions).
const INJECTED_USER = /^\s*(<environment_context>|<user_instructions>|<permissions instructions>|<user_shell_command>|<turn_aborted>|# AGENTS\.md instructions|<INSTRUCTIONS>)/;
const SHELL_TOOLS = new Set(['shell', 'exec_command', 'shell_command', 'container.exec', 'local_shell']);
const READ_CMD = /^\s*(?:cat|nl(?:\s+-\w+)*|head(?:\s+-n?\s*\d+)?|tail(?:\s+-n?\s*\d+)?|less|bat|sed\s+-n\s+(?:'[^']*'|"[^"]*"|\S+))\s+(['"]?)([^\s'"|;&<>]+)\1\s*$/;

const emptySegment = () => Object.fromEntries(CATEGORIES.map((c) => [c, 0]));

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);
  return content.map((c) => (typeof c?.text === 'string' ? c.text : c?.type === 'input_image' ? '' : JSON.stringify(c))).join('\n');
}

/** The shell command line of a shell-like tool call, or null. */
export function shellCommand(name, args) {
  let a = args;
  if (typeof a === 'string') {
    try {
      a = JSON.parse(a);
    } catch {
      return null;
    }
  }
  const cmd = a?.cmd ?? a?.command ?? a?.action?.command;
  if (typeof cmd === 'string') return cmd;
  if (Array.isArray(cmd)) {
    // ["bash", "-lc", "<script>"] → the script; otherwise the words
    const i = cmd.findIndex((w) => w === '-lc' || w === '-c');
    return i !== -1 && typeof cmd[i + 1] === 'string' ? cmd[i + 1] : cmd.join(' ');
  }
  return null;
}

/** Files named by an apply_patch body: [{path, kind: "write"|"edit"}]. */
export function patchFiles(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(/^\*\*\* (Add|Update|Delete) File: (.+?)\s*$/gm)) {
    out.push({ path: m[2], kind: m[1] === 'Add' ? 'write' : 'edit' });
  }
  return out;
}

/** Files a shell command line reads (cat/sed -n/head/tail/nl, one file each). */
export function readFiles(cmd) {
  const out = [];
  for (const part of String(cmd ?? '').split(/&&|\|\||;|\n/)) {
    const first = part.split('|')[0];
    const m = first.match(READ_CMD);
    if (m && !m[2].startsWith('-')) out.push(m[2]);
  }
  return out;
}

export class CodexSession {
  constructor(opts = {}) {
    this.file = opts.file ?? null;
    this.sessionId = null;
    this.parentId = null; // set for sub-agent threads
    this.cwd = null;
    this.gitBranch = null;
    this.version = null;
    this.model = null;
    this.firstTs = null;
    this.lastTs = null;
    this.window = null;

    this.requests = [];
    this.lastTotal = null;
    this.totals = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, thinking: 0 };
    this.segment = emptySegment();
    this.baseline = null;
    this.compactions = [];
    this.files = new Map();
    this.tools = new Map();
    this.unknownTypes = new Map();
  }

  apply(rec) {
    if (!rec || typeof rec !== 'object') return;
    if (!KNOWN_TYPES.has(rec.type)) this.unknownTypes.set(rec.type, (this.unknownTypes.get(rec.type) || 0) + 1);
    if (rec.timestamp) {
      if (!this.firstTs) this.firstTs = rec.timestamp;
      this.lastTs = rec.timestamp;
    }
    const p = rec.payload ?? {};
    switch (rec.type) {
      case 'session_meta': {
        const meta = p.meta ?? p; // older logs nest it under "meta"
        this.sessionId = this.sessionId ?? meta.id ?? null;
        this.parentId = meta.parent_thread_id ?? (meta.source?.subagent || meta.agent_role ? 'subagent' : null) ?? this.parentId;
        if (meta.cwd) this.cwd = meta.cwd;
        if (meta.cli_version) this.version = meta.cli_version;
        const git = p.git ?? meta.git;
        if (git?.branch) this.gitBranch = git.branch;
        return;
      }
      case 'turn_context':
        if (p.cwd) this.cwd = p.cwd;
        if (p.model) this.model = p.model;
        return;
      case 'response_item': return this.#item(p, rec.timestamp);
      case 'compacted': return this.#compaction(p, rec.timestamp);
      case 'event_msg':
        if (p.type === 'token_count') this.#tokens(p.info, rec.timestamp);
        return;
      default:
    }
  }

  #item(p, ts) {
    switch (p.type) {
      case 'message': {
        const text = textOf(p.content);
        if (p.role === 'assistant') this.segment.assistant += estimateTokens(text);
        else if (p.role === 'user') this.segment[INJECTED_USER.test(text) ? 'injected' : 'user'] += estimateTokens(text);
        else this.segment.injected += estimateTokens(text); // developer / system
        return;
      }
      case 'function_call':
      case 'custom_tool_call':
      case 'local_shell_call':
      case 'web_search_call':
      case 'tool_search_call': {
        const name = p.name ?? p.type.replace(/_call$/, '');
        const args = p.arguments ?? p.input ?? p.action ?? null;
        this.tools.set(name, (this.tools.get(name) || 0) + 1);
        this.segment.toolUse += estimateTokens(args);
        this.#fileActivity(name, args, ts);
        return;
      }
      case 'function_call_output':
      case 'custom_tool_call_output':
      case 'tool_search_output':
        this.segment.toolResult += estimateTokens(p.output ?? p.tools ?? null);
        return;
      default:
      // reasoning (encrypted), compaction items, etc.: not split out
    }
  }

  #fileActivity(name, args, ts) {
    const touch = (path, kind) => {
      const f = this.files.get(path) || { read: 0, edit: 0, write: 0, lastTs: null };
      f[kind]++;
      f.lastTs = ts || f.lastTs;
      this.files.set(path, f);
    };
    const raw = typeof args === 'string' ? args : JSON.stringify(args ?? '');
    if (raw.includes('*** Begin Patch')) {
      // apply_patch as a custom tool (raw patch) or inside a shell call (JSON-escaped)
      const body = typeof args === 'string' && !args.trimStart().startsWith('{') ? args : raw.replace(/\\n/g, '\n');
      for (const f of patchFiles(body)) touch(f.path, f.kind);
      return;
    }
    if (SHELL_TOOLS.has(name)) for (const f of readFiles(shellCommand(name, args))) touch(f, 'read');
  }

  #tokens(info, ts) {
    if (!info?.last_token_usage) return;
    const total = info.total_token_usage ?? {};
    // repeated event with no new usage (rate-limit refreshes): skip
    if (this.lastTotal !== null && total.total_tokens === this.lastTotal) return;
    this.lastTotal = total.total_tokens ?? null;
    if (typeof info.model_context_window === 'number') this.window = info.model_context_window;

    const u = info.last_token_usage;
    const input = u.input_tokens || 0;
    const cached = u.cached_input_tokens || 0;
    const context = u.total_tokens || input + (u.output_tokens || 0);
    if (this.baseline === null) {
      const conv = Object.values(this.segment).reduce((a, b) => a + b, 0);
      this.baseline = Math.max(0, input - conv);
    }
    this.requests.push({ ts: ts || null, model: this.model, input: input - cached, cacheRead: cached, cacheWrite: 0, output: u.output_tokens || 0, thinking: u.reasoning_output_tokens || 0, prompt: context });
    this.totals = {
      input: Math.max(0, (total.input_tokens || 0) - (total.cached_input_tokens || 0)),
      cacheRead: total.cached_input_tokens || 0,
      cacheWrite: 0,
      output: total.output_tokens || 0,
      thinking: total.reasoning_output_tokens || 0,
    };
    const last = this.compactions[this.compactions.length - 1];
    if (last && last.postTokens === null) last.postTokens = context;
  }

  #compaction(p, ts) {
    const prev = this.requests[this.requests.length - 1];
    this.compactions.push({ ts: ts || null, trigger: null, preTokens: prev ? prev.prompt : null, postTokens: null });
    this.segment = emptySegment();
    this.segment.compactSummary += estimateTokens(p.message ?? '');
    for (const it of p.replacement_history ?? []) this.segment.compactSummary += estimateTokens(it?.content ?? it);
  }

  /** Current context split into categories: measured total, estimated split. */
  composition() {
    const last = this.requests[this.requests.length - 1];
    if (!last) return null;
    const total = last.prompt;
    const baseline = Math.min(this.baseline ?? 0, total);
    const rest = total - baseline;
    const est = this.segment;
    const estSum = CATEGORIES.reduce((n, c) => n + est[c], 0);
    const parts = [{ category: 'systemAndTools', tokens: baseline }];
    if (estSum === 0) {
      parts.push({ category: 'unattributed', tokens: rest });
    } else {
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
    return { total, estimated: true, parts: parts.filter((p) => p.tokens > 0), topTools: null };
  }

  snapshot({ trendLength = 40 } = {}) {
    const last = this.requests[this.requests.length - 1] || null;
    const t = this.totals;
    const promptAll = t.input + t.cacheRead;
    const rel = (p) => {
      const s = String(p).replace(/\\/g, '/');
      const c = this.cwd ? String(this.cwd).replace(/\\/g, '/').replace(/\/+$/, '') : null;
      return c && s.startsWith(c + '/') ? s.slice(c.length + 1) : p;
    };
    const tokens = last ? last.prompt : null;
    return {
      agent: 'codex',
      sessionId: this.sessionId,
      file: this.file,
      cwd: this.cwd,
      gitBranch: this.gitBranch,
      version: this.version,
      model: this.model,
      firstTs: this.firstTs,
      lastTs: this.lastTs,
      requestCount: this.requests.length,
      context: {
        tokens,
        window: this.window,
        windowSource: this.window ? 'log' : 'unknown',
        percent: tokens == null || !this.window ? null : tokens / this.window,
        officialPercent: null,
      },
      trend: this.requests.slice(-trendLength).map((r) => r.prompt),
      totals: { ...t, cacheHitRate: promptAll ? t.cacheRead / promptAll : null },
      compactions: this.compactions.map((c) => ({ ...c })),
      composition: this.composition(),
      files: [...this.files.entries()]
        .map(([p, f]) => ({ path: rel(p), ...f }))
        .sort((a, b) => b.edit + b.write - (a.edit + a.write) || b.read - a.read),
      tools: Object.fromEntries([...this.tools.entries()].sort((a, b) => b[1] - a[1])),
      cost: null,
      sidechain: { requests: 0, promptTokens: 0, outputTokens: 0 },
      subagents: [],
      rateLimits: null,
      parseIssues: { malformedLines: 0, unknownTypes: Object.fromEntries(this.unknownTypes) },
    };
  }
}
