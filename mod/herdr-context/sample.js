// Sample data drawn during `herdr-app check`, so the check renders every part
// of the panel (bars, makeup, files, every quota row) without running the CLI.
// Same shape as `herdr-context --list --json` and `herdr-context quota --json`.
const inHours = (h) => new Date(Date.now() + h * 3600e3).toISOString();

export const SAMPLE_SESSIONS = [
  {
    agent: "claude",
    sessionId: "00000000-sample",
    cwd: "/sample/project",
    gitBranch: "main",
    model: "claude-sample",
    lastTs: new Date().toISOString(),
    requestCount: 12,
    trend: [40000, 52000, 61000, 70000, 83000, 96000, 104000, 121000],
    totals: { input: 120, cacheRead: 900000, cacheWrite: 60000, output: 21000, thinking: 4000, cacheHitRate: 0.93 },
    compactions: [{ ts: null, trigger: "auto", preTokens: 160000, postTokens: 38000 }],
    composition: {
      total: 121000,
      estimated: true,
      parts: [
        { category: "systemPrompt", tokens: 9000 },
        { category: "toolDefinitions", tokens: 31000 },
        { category: "toolResult", tokens: 52000 },
        { category: "assistant", tokens: 15000 },
        { category: "toolUse", tokens: 9000 },
        { category: "user", tokens: 5000 },
      ],
      topTools: [{ name: "Bash", tokens: 4000 }, { name: "Edit", tokens: 3000 }],
    },
    files: [
      { path: "src/app.js", read: 3, edit: 2, write: 0, lastTs: null },
      { path: "README.md", read: 1, edit: 0, write: 0, lastTs: null },
    ],
    cost: { totalUSD: 1.23 },
    context: { tokens: 121000, window: 200000, windowSource: "statusline", percent: 0.605, officialPercent: 60 },
  },
];

export const SAMPLE_AGENTS = [
  { address: "t1", title: "fix login", status: "working", cwd: "/sample/project" },
  { address: "t2", title: "write tests", status: "idle", cwd: "/sample/other" },
];

export const SAMPLE_QUOTA = {
  generatedAt: new Date().toISOString(),
  providers: [
    { provider: "claude", source: "claude-statusline", status: "ok", plan: "max", windows: [
      { id: "five_hour", label: "5h", usedPercent: 37, resetsAt: inHours(2) },
      { id: "seven_day", label: "week", usedPercent: 74, resetsAt: inHours(90) },
    ] },
    { provider: "codex", source: "codex app-server", status: "stale", plan: "plus", windows: [
      { id: "secondary", label: "week", usedPercent: 93, resetsAt: inHours(30) },
    ] },
    { provider: "kiro", source: "kiro-cli", status: "ok", plan: "KIRO PRO", windows: [
      { id: "monthly", label: "month", usedPercent: 41, resetsAt: inHours(200), detail: "820 of 2000 credits" },
      { id: "bonus", label: "bonus", usedPercent: 12, resetsAt: inHours(480) },
    ] },
    { provider: "cursor", source: "quota-axi", status: "not_found", plan: null, windows: [], message: "quota-axi not installed" },
  ],
  notes: ["sample data shown during herdr-app check"],
};
