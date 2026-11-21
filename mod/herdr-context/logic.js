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
  let s = p.replace(/\\/g, "/");
  if (s.length > 1) s = s.replace(/\/+$/, "");
  if (/^[a-zA-Z]:\//.test(s) || /^[a-zA-Z]:$/.test(s)) s = s.toLowerCase();
  return s;
}

const newest = (list) => list.slice().sort((a, b) => String(b.lastTs ?? "").localeCompare(String(a.lastTs ?? "")))[0] ?? null;

/** The Claude session for a pane's folder: same folder first (newest),
 *  else the newest session whose folder contains it or sits inside it. */
export function pickSession(sessions, cwd) {
  const want = normPath(cwd);
  if (!want || !Array.isArray(sessions)) return null;
  const exact = sessions.filter((s) => normPath(s.cwd) === want);
  if (exact.length) return newest(exact);
  const near = sessions.filter((s) => {
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
  const h = Math.floor(ms / 3.6e6);
  const m = Math.round((ms % 3.6e6) / 6e4);
  return h >= 24 ? `in ${Math.floor(h / 24)}d ${h % 24}h` : `in ${h}h ${m}m`;
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

/** Last path segment, for compact file lists. */
export function baseName(p) {
  const s = String(p ?? "").replace(/\\/g, "/");
  const i = s.lastIndexOf("/");
  return i === -1 ? s : s.slice(i + 1);
}
