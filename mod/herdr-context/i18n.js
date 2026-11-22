// UI text in English and Simplified Chinese. Pure: tests import it directly.
// Established technical terms stay English in both (tokens, cache, agent,
// System Prompt, ctx, provider and plan names, model names).

const STRINGS = {
  en: {
    title: "Context",
    updating: "updating…",
    refreshTip: "Refresh now (also re-asks every subscription)",
    closeTip: "Close (or click the chip in the status bar)",
    langTip: "中文",
    tokensInContext: "tokens in context",
    tokensOf: "{used} of {window} tokens",
    windowUnknown: "Window size unknown for this model; set HERDR_CONTEXT_WINDOW to see the %.",
    requests: "{n} requests",
    cacheHit: "cache {pct}",
    compacted: "compacted {n}×",
    neverCompacted: "never compacted",
    agents: "Agents in this space",
    makeup: "Makeup",
    heaviestTools: "heaviest tools",
    files: "Files",
    read: "read",
    subscriptions: "Subscriptions",
    stale: "stale",
    notSetUp: "Not set up: {names}",
    via: "via {source}",
    asOf: "as of {time}",
    loading: "Loading…",
    noTerminal: "No terminal in this tab.",
    otherAgent: "{app}: the context view supports Claude Code and Codex for now.",
    noSessionLog: "{app}: no session log for this folder yet.",
    matchedBy: "matched by",
    noRequests: "No request has gone through in this session yet (signed out?).",
    guessed: "{n} other session(s) use this folder; showing the newest. /rename the session to pin it.",
    noAgentPick: "No agent in this pane. Pick one below.",
    noAgent: "No agent in this pane.",
    chipShow: "Show context details",
    chipHide: "Hide context details",
    chipPlain: "Context of the focused agent · fullest subscription window",
    chipEmpty: "context",
  },
  zh: {
    title: "上下文",
    updating: "更新中…",
    refreshTip: "立即刷新（同时重新查询所有订阅）",
    closeTip: "关闭（也可以点击状态栏上的小标签）",
    langTip: "English",
    tokensInContext: "tokens 在上下文中",
    tokensOf: "{used} / {window} tokens",
    windowUnknown: "不知道这个模型的窗口大小；设置 HERDR_CONTEXT_WINDOW 后可显示百分比。",
    requests: "{n} 次请求",
    cacheHit: "cache 命中 {pct}",
    compacted: "已压缩 {n} 次",
    neverCompacted: "未压缩",
    agents: "本工作区的 Agents",
    makeup: "上下文组成",
    heaviestTools: "最占上下文的工具",
    files: "文件",
    read: "读取",
    subscriptions: "订阅用量",
    stale: "已过期",
    notSetUp: "未配置：{names}",
    via: "来源：{source}",
    asOf: "更新于 {time}",
    loading: "加载中…",
    noTerminal: "这个标签页里没有终端。",
    otherAgent: "{app}：上下文视图目前支持 Claude Code 和 Codex。",
    noSessionLog: "{app}：还没有这个文件夹的会话日志。",
    matchedBy: "匹配方式",
    noRequests: "这个会话还没有成功的请求（可能是登录过期了）。",
    guessed: "这个文件夹还有 {n} 个其他会话，当前显示的是最近的一个。用 /rename 给会话命名就能精确对应。",
    noAgentPick: "这个窗格里没有 agent，可以在下方选择。",
    noAgent: "这个窗格里没有 agent。",
    chipShow: "显示上下文详情",
    chipHide: "隐藏上下文详情",
    chipPlain: "当前 agent 的上下文 · 用量最高的订阅窗口",
    chipEmpty: "context",
  },
};

const CATEGORY = {
  en: {
    systemAndTools: "system + tools", systemPrompt: "system prompt", toolDefinitions: "tool definitions",
    user: "your messages", assistant: "replies", toolUse: "tool calls", toolResult: "tool results",
    injected: "injected", compactSummary: "compact summary", unattributed: "unattributed",
  },
  zh: {
    systemAndTools: "System Prompt + 工具", systemPrompt: "System Prompt", toolDefinitions: "工具定义",
    user: "你的消息", assistant: "模型回复", toolUse: "工具调用", toolResult: "工具结果",
    injected: "注入内容", compactSummary: "压缩摘要", unattributed: "未归类",
  },
};

export const LANGS = ["en", "zh"];
export const normLang = (l) => (l === "zh" ? "zh" : "en");

/** t(key, {var}) for one language; unknown keys fall back to English, then the key. */
export function translator(lang) {
  const table = STRINGS[normLang(lang)];
  return (key, vars = {}) =>
    String(table[key] ?? STRINGS.en[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? `{${k}}`));
}

export function categoryLabel(key, lang) {
  return CATEGORY[normLang(lang)][key] ?? CATEGORY.en[key] ?? key;
}

/** Quota window labels from the CLI ("5h", "week", "month", "bonus", "Sonnet week", ...). */
export function windowLabel(label, lang) {
  if (normLang(lang) === "en" || !label) return label;
  const fixed = { "5h": "5 小时", week: "每周", month: "每月", bonus: "赠送额度" };
  if (fixed[label]) return fixed[label];
  return String(label).replace(/ week$/, " 每周").replace(/ month$/, " 每月");
}

/** "in 2h 5m" / "2 小时 5 分后", from an ISO time; "" if unknown. */
export function resetsText(iso, lang, now = Date.now()) {
  const t = Date.parse(iso ?? "");
  if (!Number.isFinite(t)) return "";
  const zh = normLang(lang) === "zh";
  const ms = t - now;
  if (ms <= 0) return zh ? "即将重置" : "now";
  const mins = Math.round(ms / 6e4);
  const h = Math.floor(mins / 60);
  if (h >= 24) return zh ? `${Math.floor(h / 24)} 天 ${h % 24} 小时后` : `in ${Math.floor(h / 24)}d ${h % 24}h`;
  return zh ? `${h} 小时 ${mins % 60} 分后` : `in ${h}h ${mins % 60}m`;
}

/** "5s ago" / "5 秒前". */
export function agoText(ms, lang, now = Date.now()) {
  const zh = normLang(lang) === "zh";
  if (!ms) return zh ? "尚未更新" : "never";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return zh ? `${s} 秒前` : `${s}s ago`;
  if (s < 3600) return zh ? `${Math.round(s / 60)} 分钟前` : `${Math.round(s / 60)}m ago`;
  return zh ? `${Math.round(s / 3600)} 小时前` : `${Math.round(s / 3600)}h ago`;
}
