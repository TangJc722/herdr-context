# herdr-context

**English** | [简体中文](README.zh-CN.md)

What is in your coding agent's context window, where it came from, and how much
of each subscription you have left.
A data layer and CLI first; a [Herdr](https://herdr.dev) mod on top next.

Context analysis supports **Claude Code** today (Codex next, see Roadmap).
Subscription usage covers Claude, Codex and Kiro, plus Cursor, Copilot and others through quota-axi.

```
claude · 1dea6540 · ~/work/api (main) · claude-opus-5-5 · v2.1.330
  Context   █████░░░░░░░░░░░░░░░░░░░ 200k / 1.00M (20%)
  Trend     ▁▁▁▂▂▂▃▃▃▄▄▄▅▅▅▆▆▆▇▇▇███  41 requests
  Tokens    in 101 · cache read 5.56M · cache write 110k · out 70k (thinking 20k) · cache hit 98%
  Cost      $2.73 (Claude Code's last saved total, all models incl. background)
  Limits    5h 37% (resets in 2h 0m) · 7d 12% (resets in 4d 15h)
  Compacted never
  Makeup    tool definitions 33% · tool results 29% · replies 17% · tool calls 12% · injected 7% · system prompt 2% · your messages 1%  (estimated split)
  Heaviest tool definitions  Artifact 14k · mcp__remote__create_environment 3.6k · …
  Files     10 changed, 0 read — src/claude/session.js ✎7, src/render.js ✎5, …
  Tools     WebSearch 19 · Bash 15 · Edit 13 · Write 11
  Subagents a6428b59 (2 req, peak 6.0k)
```

## Usage

Requires Node 18+. No dependencies.

```sh
node bin/herdr-context.js                 # latest session
node bin/herdr-context.js --list          # recent sessions
node bin/herdr-context.js --session 1dea  # by id prefix
node bin/herdr-context.js --cwd ~/work/api
node bin/herdr-context.js --json          # for the Herdr mod / scripts
```

### Context-window size and subscription limits (recommended)

Session logs do not record the context-window size or the 5-hour / 7-day limits.
Claude Code hands both to its statusLine command, so register the collector
(it prints nothing and never breaks the status line):

```json
// ~/.claude/settings.json
{ "statusLine": { "type": "command", "command": "node /path/to/herdr-context/bin/claude-statusline-collector.js" } }
```

Keep an existing status line by chaining it: `... claude-statusline-collector.js --then '~/.claude/statusline.sh'`.
Payloads are saved to `~/.cache/herdr-context/claude-statusline/<session>.json`.
Without the collector, token counts are shown but no percentage (or set `HERDR_CONTEXT_WINDOW`).

## Subscription usage: `herdr-context quota`

Every subscription on this machine in one list.

```sh
node bin/herdr-context.js quota            # default: local data, then the agents' own commands
node bin/herdr-context.js quota --refresh  # ignore caches, ask every source now
node bin/herdr-context.js quota --passive  # never start claude / codex; local data only
node bin/herdr-context.js quota --direct   # Claude: use the local login directly (opt-in, see below)
node bin/herdr-context.js quota --json     # for the Herdr mod; --no-axi skips quota-axi
```

```
Subscription usage
  claude  5h     ████░░░░░░░░  37% used (resets in 2h 6m)
          week   █████████░░░  72% used ! (resets in 4d 3h)
          via claude-statusline · as of 2026-11-21 14:35Z
  codex   5h     ███░░░░░░░░░  22% used (resets in 3h 30m) [plus]
          week   ███████████░  91% used ‼ (resets in 1d 5h)
          via codex-rollout · as of 2026-11-21 14:35Z
  kiro    month  █████░░░░░░░  41% used (resets in 9d 9h) · 820.5 of 2000 credits [KIRO PRO]
          bonus  █░░░░░░░░░░░  12% used (expires in 19d 23h) · 12 of 100 bonus credits
          via kiro-cli · as of 2026-11-21 14:35Z
  cursor  month  █████░░░░░░░  45% used (resets in 8d 23h) [pro]
          via quota-axi · as of 2026-11-21 14:35Z
```

Sources are tried cheapest first. Local data is used while it is under 5 minutes old;
otherwise the agent's own command is asked (results cached):

| Provider | 1. Local, free | 2. Agent's own command | Credentials |
|---|---|---|---|
| Claude | statusLine readings from the collector (highest reading of the current window across sessions) | `claude -p "/usage"`, cached 5 min | Claude Code uses its own login |
| Codex | last `token_count` event with `rate_limits` in `$CODEX_HOME/sessions/**/rollout-*.jsonl[.zst]` | `codex -s read-only -a never app-server` → JSON-RPC `account/rateLimits/read`, cached 3 min | Codex uses (and renews) its own login |
| Kiro | — | `kiro-cli chat --no-interactive "/usage" --v2`, text parsed, cached 10 min | kiro-cli's own login |
| Cursor, Copilot, Grok, … | — | [`quota-axi --json`](https://github.com/kunchenguid/quota-axi) when installed | quota-axi reads each CLI's login |

If a source fails, the next one is tried and the reason is shown; quota-axi also
stands in when a source above has nothing. Windows whose reset time has passed
are dropped (shown as `stale`) rather than shown as current.

The `claude /usage` probe runs with `--no-session-persistence --tools "" --strict-mcp-config`,
hooks and Remote Control disabled, in an empty directory, so it writes no session
log and starts no MCP servers. Its text parser follows CodexBar's description of
the report and **has not yet been checked against a live Pro/Max report**.
The Codex app-server exchange was checked against Codex CLI 0.171.0.

### Claude direct mode (`--direct`, opt-in)

Reads Claude Code's OAuth access token and asks Anthropic's usage endpoint
(`GET https://api.anthropic.com/api/oauth/usage`), as CodexBar and quota-axi do:
freshest data, one HTTP request, structured JSON. Also enabled by `HERDR_CONTEXT_CLAUDE_DIRECT=1`.

- Token sources: `CLAUDE_CODE_OAUTH_TOKEN`, then `~/.claude/.credentials.json`
  (`$CLAUDE_CONFIG_DIR`), then the macOS Keychain item `Claude Code-credentials` (macOS may ask once).
- **Read-only**: Claude Code's credentials are never written or moved.
- **Never refreshes**: an expired token is reported and the other sources are used,
  so Claude Code renews its own login. Refreshing here could rotate the refresh token
  out from under Claude Code and sign it out.
- The token is sent only to `api.anthropic.com` and never printed or cached; only the usage numbers are cached (2 min).
- The endpoint is not a documented public API and may change.

Codex needs no direct mode: its app-server already answers with Codex's own login.

Kiro caveats: no documented API, so a report-format change breaks parsing; each
run starts a non-interactive chat and the CLI saves an empty session for it.
The parser is built from CodexBar's documented format and **has not yet been
checked against a live kiro-cli**.

## Where each number comes from

| Figure | Source | Confidence |
|---|---|---|
| Context tokens, trend | latest request's `input + cache_read + cache_creation` in `~/.claude/projects/*/<session>.jsonl` | measured |
| Token totals, cache hit | `message.usage`, counted **once per requestId** (one response is logged as several records) | measured |
| Compactions | `system` / `compact_boundary` records (`compactMetadata.preTokens`) + the next request's size | measured |
| Cost | Claude Code's own `cost-state` records (last saved, may lag) | reported by Claude Code |
| Window size, % used, 5h / 7d limits | statusLine payload | official, may be missing |
| Makeup (split by category) | measured total split by estimated text size (~4 chars/token, CJK 1/token) | **estimate** |
| System prompt vs tool definitions | internal `prompt_snapshot` records when present, else one "system+tools" block | **estimate** |
| Files, tools, sub-agents | `tool_use` blocks; `<session>/subagents/*.jsonl` | measured |

The log format is internal to Claude Code and changes between versions. Unknown
record types and malformed lines are counted and shown, never fatal.
Checked against Claude Code 2.1.330.

## Layout

```
src/jsonl-tail.js          incremental, byte-safe JSONL reader (for live polling)
src/claude/session.js      folds log records into a summary (pure, no I/O)
src/claude/load.js         one session + sub-agents + statusLine → snapshot
src/claude/statusline.js   statusLine payload save / read / normalize
src/claude/discover.js     finds session logs
src/quota/                 subscription usage: claude (statusLine), claude-cli (/usage), claude-direct,
                           codex (logs), codex-rpc (app-server), kiro, quota-axi, index (source order)
src/render.js              text output
bin/                       CLI and statusLine collector
test/                      node --test, synthetic fixtures; a fake codex app-server script.
                           Tests never start the real claude or codex.
```

`npm test` runs the suite.

## Roadmap

1. **Codex adapter**: `~/.codex/sessions/**` rollout events: `token_count`
   (`info.last_token_usage`, `model_context_window`, `rate_limits.primary/secondary`)
   and `context_compacted`. Needs a real sample to confirm.
2. **Herdr mod**: status-bar chip (context % of the focused pane) + side panel; map sessions to panes by cwd / process.
3. **Quota**: done (Claude statusLine / `/usage` / direct, Codex logs / app-server, Kiro, quota-axi).
   Next: verify Claude `/usage` text and Kiro against live reports; Cursor without quota-axi.
4. Cursor context: research what its CLI leaves on disk.
