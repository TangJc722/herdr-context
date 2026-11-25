// Pure helpers for the Herdr mod: no imports from "herdr" or "gpui-kit", so
// Node tests can import this file directly. main.js does the drawing.

export const LABELS = {
  systemAndTools: "system + tools",
  systemPrompt: "system prompt",
  toolDefinitions: "tool definitions",
  user: "your messages",
  assistant: "replies",
  toolUse: "tool calls",
  toolResult: "tool results",
  injected: "injected",
  compactSummary: "compact summary",
  unattributed: "unattributed",
};

const SPARK = "▁▂▃▄▅▆▇█";

/** Comparable form of a folder: forward slashes, no trailing slash,
 *  and lower case for Windows drive paths (which are case-insensitive). */
export function normPath(p) {
  if (!p || typeof p !== "string") return null;
  let s = p.replace(/^[\\/]{2}\?[\\/]UNC[\\/]/i, "//").replace(/^[\\/]{2}\?[\\/]/, "").replace(/\\/g, "/");
  if (s.length > 1) s = s.replace(/\/+$/, "");
  if (/^[a-zA-Z]:\//.test(s) || /^[a-zA-Z]:$/.test(s)) s = s.toLowerCase();
  return s;
}

/**
 * The terminal whose agent the panel describes. Clicking the panel moves the
 * focus onto the panel itself (a mod pane, no terminal), so then fall back to
 * a terminal in the same tab: the last one focused, else one running Claude,
 * else the first. A focused layout terminal block has a terminal but no pane.
 * @returns {{cwd: string|null, app: string|null, pane: string|null}}
 */
export function choosePane(focus, paneList, lastPane) {
  const list = Array.isArray(paneList) ? paneList : [];
  const own = list.find((p) => p.focused) ?? null;
  if (own?.terminal) return { cwd: own.cwd ?? focus?.cwd ?? null, app: own.app ?? null, pane: own.pane };
  if (!own && focus?.terminal) return { cwd: focus.cwd ?? null, app: null, pane: null };
  const tab = focus?.tab ?? own?.tab ?? null;
  const terms = list.filter((p) => p.terminal && (!tab || p.tab === tab));
  const pick =
    terms.find((p) => p.pane === lastPane) ??
    terms.find((p) => /claude/i.test(p.app ?? "")) ??
    terms[0] ??
    null;
  return pick ? { cwd: pick.cwd ?? null, app: pick.app ?? null, pane: pick.pane } : { cwd: null, app: null, pane: null };
}

const newest = (list) => list.slice().sort((a, b) => String(b.lastTs ?? "").localeCompare(String(a.lastTs ?? "")))[0] ?? null;

/** Which agent a pane runs, as far as the context view goes: "claude" | "codex" | "agy" | null. */
export function agentKind(app) {
  const a = String(app ?? "").toLowerCase();
  if (a.includes("claude")) return "claude";
  if (a.includes("codex")) return "codex";
  if (a.includes("antigravity") || /^agy\b/.test(a)) return "agy";
  return null;
}

/** The session for a pane's folder (of one agent, when given): same folder
 *  first (newest), else the newest session whose folder contains it or sits inside it. */
export function pickSession(sessions, cwd, agent = null) {
  const want = normPath(cwd);
  if (!want || !Array.isArray(sessions)) return null;
  const mine = agent ? sessions.filter((s) => (s.agent ?? "claude") === agent) : sessions;
  const exact = mine.filter((s) => normPath(s.cwd) === want);
  if (exact.length) return newest(exact);
  const near = mine.filter((s) => {
    const c = normPath(s.cwd);
    return c && (want.startsWith(c + "/") || c.startsWith(want + "/"));
  });
  return newest(near);
}

export function fmt(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

export const pctText = (x) => (x == null || !Number.isFinite(x) ? "—" : `${Math.round(x * 100)}%`);

export function sparkline(values, width = 32) {
  const v = (values || []).filter(Number.isFinite).slice(-width);
  if (!v.length) return "";
  const max = Math.max(...v);
  const min = Math.min(...v);
  const span = max - min || 1;
  return v.map((x) => SPARK[Math.round(((x - min) / span) * (SPARK.length - 1))]).join("");
}

/** "in 2h 5m" / "in 3d 4h" / "now" for an ISO time; "" if unknown. */
export function resetsIn(iso, now = Date.now()) {
  const t = Date.parse(iso ?? "");
  if (!Number.isFinite(t)) return "";
  const ms = t - now;
  if (ms <= 0) return "now";
  const mins = Math.round(ms / 6e4); // round once, so it never reads "1h 60m"
  const h = Math.floor(mins / 60);
  return h >= 24 ? `in ${Math.floor(h / 24)}d ${h % 24}h` : `in ${h}h ${mins % 60}m`;
}

export function ago(ms, now = Date.now()) {
  if (!ms) return "never";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

/** Severity for colouring a % used: "ok" | "warn" (≥70) | "high" (≥90). */
export function level(usedPercent) {
  if (usedPercent == null) return "ok";
  return usedPercent >= 90 ? "high" : usedPercent >= 70 ? "warn" : "ok";
}

/** The most-used window across providers that have numbers: {provider, window} or null. */
export function worstWindow(quota) {
  let best = null;
  for (const p of quota?.providers ?? []) {
    if (p.status !== "ok" && p.status !== "stale") continue;
    for (const w of p.windows ?? []) {
      if (typeof w.usedPercent !== "number") continue;
      if (!best || w.usedPercent > best.window.usedPercent) best = { provider: p.provider, window: w };
    }
  }
  return best;
}

/** Composition parts, largest first, with share of the total. */
export function makeup(session) {
  const c = session?.composition;
  if (!c?.parts?.length || !c.total) return [];
  return c.parts
    .filter((p) => p.tokens > 0)
    .map((p) => ({ label: LABELS[p.category] ?? p.category, tokens: p.tokens, share: p.tokens / c.total }))
    .sort((a, b) => b.tokens - a.tokens);
}

/** Short status-bar text: "ctx 62% · claude 5h 37%". */
export function chipText(session, quota) {
  const parts = [];
  if (session?.context?.tokens != null) {
    parts.push(session.context.percent != null ? `ctx ${pctText(session.context.percent)}` : `ctx ${fmt(session.context.tokens)}`);
  }
  const w = worstWindow(quota);
  if (w) parts.push(`${w.provider} ${w.window.label} ${Math.round(w.window.usedPercent)}%`);
  return parts.join(" · ") || "context";
}

/** The line of a failed run's output that says what went wrong: our own
 *  "herdr-context: ..." line, else Node's "SomeError: ..." line (Node prints
 *  the source location first), else the first non-empty line. */
export function errorLine(output) {
  const lines = String(output ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return (
    lines.find((l) => l.startsWith("herdr-context:")) ??
    lines.find((l) => /^[A-Z]\w*(Error|Exception)\b/.test(l)) ??
    lines[0] ??
    ""
  );
}

export function findNode(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.id === id) return node;
  for (const c of node.children ?? []) {
    const f = findNode(c, id);
    if (f) return f;
  }
  return null;
}

/** Where the Context panel stands in the shown layout (the main-context one has it
 *  in the right sidebar's "panel-body" stack, next to Files and Changes). */
export function panelState(layoutTree) {
  const block = findNode(layoutTree, "context");
  const panel = findNode(layoutTree, "panel");
  const body = findNode(layoutTree, "panel-body");
  const inSidebar = Boolean(block && panel && body);
  return { inSidebar, open: inSidebar && !panel.hidden && body.active === "context" };
}

/** The layout commands that open or close the Context panel. */
export function toggleCommands(state) {
  if (!state.inSidebar) return [];
  return state.open
    ? [["layout.hide", { id: "panel" }]]
    : [["layout.select", { stack: "panel-body", child: "context" }], ["layout.show", { id: "panel" }]];
}

/** Below this width the panel draws its compact form. It goes by the width, not a
 *  flag (as Herdr's own sidebar rail does): dragging the edge narrow compacts it too. */
export const COMPACT_PX = 280;
export const COMPACT_WIDTH = 248;
export const WIDE_WIDTH = 368;

export function isCompact(layoutTree) {
  const px = findNode(layoutTree, "panel")?.size?.px;
  return Number.isFinite(px) && px < COMPACT_PX;
}

/** Narrow the right sidebar to the compact width, or back to the width it had.
 *  @returns {{save: number|null, commands: Array<[string, object]>}} save = the wide width to remember */
export function compactCommands(layoutTree, savedWidth) {
  const px = findNode(layoutTree, "panel")?.size?.px;
  if (isCompact(layoutTree)) {
    const back = Number.isFinite(savedWidth) && savedWidth >= COMPACT_PX ? savedWidth : WIDE_WIDTH;
    return { save: null, commands: [["layout.resize", { id: "panel", px: back }]] };
  }
  return { save: Number.isFinite(px) ? px : null, commands: [["layout.resize", { id: "panel", px: COMPACT_WIDTH }]] };
}

/** Theme colour names for each makeup category (theme().ansiN), stable across views. */
export const CATEGORY_COLORS = {
  toolResult: "ansi4",
  toolUse: "ansi6",
  assistant: "ansi5",
  user: "ansi2",
  toolDefinitions: "ansi3",
  systemPrompt: "ansi11",
  systemAndTools: "ansi3",
  injected: "ansi8",
  compactSummary: "ansi13",
  unattributed: "ansi8",
};

/** Makeup with each part's colour name, largest first. */
export function makeupParts(session) {
  const c = session?.composition;
  if (!c?.parts?.length || !c.total) return [];
  return c.parts
    .filter((p) => p.tokens > 0)
    .map((p) => ({ key: p.category, label: LABELS[p.category] ?? p.category, tokens: p.tokens, share: p.tokens / c.total, color: CATEGORY_COLORS[p.category] ?? "ansi8" }))
    .sort((a, b) => b.tokens - a.tokens);
}

/** A file path for display: relative to the project, else ~/..., split into folder and name. */
export function displayPath(p, cwd, home) {
  let s = String(p ?? "").replace(/\\/g, "/");
  const c = normPath(cwd);
  const h = normPath(home);
  const cmp = (x) => (/^[a-z]:\//.test(normPath(x) ?? "") ? x.toLowerCase() : x);
  if (c && cmp(s).startsWith(cmp(c) + "/")) s = s.slice(c.length + 1);
  else if (h && cmp(s).startsWith(cmp(h) + "/")) s = "~/" + s.slice(h.length + 1);
  const i = s.lastIndexOf("/");
  return { dir: i === -1 ? "" : s.slice(0, i + 1), name: i === -1 ? s : s.slice(i + 1), full: s };
}

/** Bar heights (px) for a mini chart of the last `n` values, scaled from the
 *  smallest to the largest shown so growth and compaction drops stay visible
 *  (context sizes move within a narrow band relative to zero). */
export function trendBars(values, n = 48, max = 26, min = 3) {
  const v = (values || []).filter(Number.isFinite).slice(-n);
  if (!v.length) return [];
  const lo = Math.min(...v);
  const hi = Math.max(...v);
  if (hi === lo) return v.map(() => Math.round((min + max) / 2));
  return v.map((x) => Math.round(min + ((x - lo) / (hi - lo)) * (max - min)));
}

/** Claude Code and Codex agents in a space, each with its session: from `match`
 *  results ({pane: {session}}) when given an object, else by its pane's folder. */
export function spaceAgents(agentList, paneList, sessions, spaceId) {
  const matched = sessions && !Array.isArray(sessions) ? sessions : null;
  const byPane = new Map((paneList ?? []).map((p) => [p.pane, p]));
  return (agentList ?? [])
    .filter((a) => (!spaceId || a.space === spaceId) && agentKind(a.app))
    .map((a) => {
      const cwd = byPane.get(a.pane)?.cwd ?? null;
      // An unnamed tab is called by its number ("1") or by its program ("Claude Code"):
      // use the folder then, as the sidebar does.
      const tn = String(a.tab_name ?? "").trim();
      const generic = !tn || /^\d+$/.test(tn) || /^(claude( code)?|codex|antigravity|agy|bash|zsh|fish|sh|pwsh|powershell|cmd)$/i.test(tn);
      const named = generic ? null : tn;
      const title = a.pane_name || named || baseName(cwd) || a.title || a.app;
      const kind = agentKind(a.app);
      const session = matched ? matched[a.pane]?.session ?? null : pickSession(sessions, cwd, kind);
      return { address: a.address, pane: a.pane, title, kind, status: a.status, cwd, session };
    });
}

const PROVIDER_NAMES = { claude: "Claude", codex: "Codex", agy: "Antigravity", kiro: "Kiro", cursor: "Cursor", copilot: "Copilot", grok: "Grok" };
export const providerName = (id) => PROVIDER_NAMES[id] ?? (id ? id.charAt(0).toUpperCase() + id.slice(1) : "?");

/** Providers with numbers, and the rest folded into one "not set up" line. */
export function splitProviders(quota) {
  const shown = [];
  const missing = [];
  for (const p of quota?.providers ?? []) {
    if ((p.status === "ok" || p.status === "stale") && p.windows?.length) shown.push(p);
    else missing.push({ name: providerName(p.provider), why: p.message ?? p.status });
  }
  for (const n of quota?.notes ?? []) {
    if (/quota-axi not installed/.test(n)) missing.push({ name: "Cursor, Copilot…", why: n });
  }
  return { shown, missing };
}

/** Last path segment, for compact file lists. */
export function baseName(p) {
  const s = String(p ?? "").replace(/\\/g, "/");
  const i = s.lastIndexOf("/");
  return i === -1 ? s : s.slice(i + 1);
}
