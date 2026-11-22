# herdr-context

**English** | [简体中文](README.zh-CN.md)

What is in your coding agent's context window, where it came from, and how much
of each subscription you have left.
A data layer and CLI first; a [Herdr](https://herdr.dev) mod on top next.

Context analysis supports **Claude Code** and **Codex**.
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

## Herdr mod

For the [Herdr app](https://herdr.dev/app) (checked against Herdr 0.1.16):
a **chip in the status bar** (`ctx 62% · codex week 81%`: the focused pane's
context and the fullest subscription window) that opens and closes a **Context
panel in the right sidebar**, next to Files and Changes. The panel shows the
pane's context (occupancy, trend, makeup, compactions, files) and every
subscription's usage, refreshed on its own.

```sh
git clone https://github.com/TangJc722/herdr-context && cd herdr-context
node bin/install-mod.js                                   # mod + CLI + the main-context layout
herdr-app check ~/.config/herdr-app/mods/herdr-context    # Herdr's own check
```

Herdr's shipped layouts are read-only, so the installer writes a separate layout,
`main-context`: Herdr's `main` (from the Herdr version you have) with the chip
beside its status bar and Context as a third panel in its right sidebar. It
switches to it when `herdr-app` is on PATH; otherwise press ctrl-shift-l (or
`herdr-app do layout.switch --name main-context`). Your other layouts are not
touched; switch back the same way. The tab bar remembers per space whether
Context was open, as it does for Files and Changes.

Re-run `install-mod.js` to update (it rebuilds `main-context` from the current
`main`); `--no-layout` skips the layout; `--uninstall` removes the mod and the
layout. Without the layout, open the panel as a pane:
`herdr-app do pane.split --direction right --mod herdr-context`.
Works on Windows: commands installed by npm as `.cmd` shims (claude, codex,
quota-axi) are found and started without a shell.
The % works out of the box (window sizes come from the logs or Claude Code's
model table); the statusLine collector is optional, see below.

How it works:
- Mods can't use Node, so the mod only draws. It runs the bundled CLI with
  Herdr's `exec`: context every 15 s (`match --json --panes …`), subscriptions
  every 2 min (`quota --json`; the refresh button adds `--refresh`).
- Each agent pane is paired with its own session (`herdr-context match`), since
  several sessions often share a folder:
  - Claude Code sets the terminal title to the session's title and writes the
    same title to the log (`ai-title` / `custom-title` records), so a pane whose
    title matches a session gets exactly that one.
  - Codex's title is "<thread name> | <project>" (name cut to 48 characters,
    project = git root folder name). Thread names, folders and log paths come
    from Codex's own database (`$CODEX_HOME/state_<n>.sqlite`, read-only through
    Node's built-in `node:sqlite`), merged with a scan of the logs and
    `session_index.jsonl`; Windows verbatim paths (`\\?\C:\...`) are normalized.
    A pane started in a parent folder is narrowed to the project's own folder
    (before worktrees or folders inside it). Threads created in the desktop app /
    IDE or by `codex exec` can be resumed in a terminal, so they are matched by
    their thread name, but never picked by folder alone; sub-agent threads are
    skipped. Logs Codex has compressed (`.jsonl.zst`) are found even though the
    database still lists them as `.jsonl`.
  - Otherwise: the newest session in the pane's folder (or one inside / above
    it) that is not another pane's and not titled for another window. The panel
    then says other sessions share the folder; `/rename` the session to pin it.
    Hovering the folder name on the card (or the "no session" note) shows the log
    file, how it was matched, the pane title Herdr reported and how many sessions
    each source found.
  - Folder facts and titles are cached by file size
    (`~/.cache/herdr-context/session-meta.json`), so polling reads only new bytes.
  With the panel itself focused, it describes the tab's last focused terminal.
  A pane without an agent borrows nothing; the panel lists the space's Claude
  Code and Codex agents instead (click one to go to it), as it also does
  whenever a space has several. Other agents' panes say they are not supported
  yet; a session with no reply yet (e.g. signed out) says so.
- English or Simplified Chinese: the 中/EN button in the panel header (kept in
  Herdr's shared state, so panel and chip switch together and it is remembered).
  Established terms stay English in both: tokens, cache, agent, System Prompt, ctx.
- Claude's reset times ("Nov 22, 2:20am (Asia/Shanghai)") are read as local time
  and shown like the others ("in 2h 5m").
- Layout: the agent's card (occupancy, bar, a mini chart of the last 48 requests),
  makeup as one stacked bar with a legend, recent files, then one card per
  subscription with numbers; providers that aren't set up fold into one line
  (details in its tooltip).
- During `herdr-app check` the mod draws built-in sample data (panel and chip)
  instead of running the CLI, so the check renders every part.

## Usage

Requires Node 18+. No dependencies.

```sh
node bin/herdr-context.js                 # latest session
node bin/herdr-context.js --list          # recent sessions, Claude Code and Codex
node bin/herdr-context.js --agent codex   # only one agent (claude | codex)
node bin/herdr-context.js --session 1dea  # by id prefix
node bin/herdr-context.js --cwd ~/work/api
node bin/herdr-context.js --json          # for the Herdr mod / scripts
node bin/herdr-context.js match --panes '[{"pane":"p1","agent":"claude","cwd":"/work/api","title":"✳ Fix login"}]'
```

### Context-window size

The % is context tokens ÷ the model's context window. Where the window size comes from:

- **Codex** writes it into its log (`model_context_window`). The % uses Codex's
  own formula, which leaves 12k of fixed prompt out of both sides
  (`(tokens − 12k) / (window − 12k)`), so it matches Codex's footer.
- **Claude Code** does not, so, most reliable first: `HERDR_CONTEXT_WINDOW`; the
  statusLine payload (below); a prompt larger than 200k (only a 1M window allows
  that); else Claude Code's own model table (read from the Claude Code binary:
  Opus 4.7+, Sonnet 5+, Haiku 5.5 and the Fable models are 1M; older ones 200k).
  The one case the table gets wrong: an older 200k model run with the `[1m]`
  suffix, until its context passes 200k. The collector fixes that.

### statusLine collector (optional)

Claude Code hands its statusLine command the exact window size, its own % and
the 5-hour / 7-day limits. Register the collector to use them
(it prints nothing and never breaks the status line):

```json
// ~/.claude/settings.json
{ "statusLine": { "type": "command", "command": "node /path/to/herdr-context/bin/claude-statusline-collector.js" } }
```

Keep an existing status line by chaining it: `... claude-statusline-collector.js --then '~/.claude/statusline.sh'`.
Payloads are saved to `~/.cache/herdr-context/claude-statusline/<session>.json`.
Without it everything still works: the window comes from the model table, and
Claude's limits from `claude -p "/usage"`.

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
log and starts no MCP servers. Its parser reads the one-line-per-limit format
(`Current week (all models): 47% used · resets Nov 25, 9am`) taken from Claude
Code 2.1.330's own formatter; it **has not yet been checked against a live Pro/Max report**.
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
| Window size | statusLine payload, else Claude Code's model table (see above) | official / table |
| % used (Claude Code's own), 5h / 7d limits | statusLine payload | official, may be missing |
| Makeup (split by category) | measured total split by estimated text size (~4 chars/token, CJK 1/token) | **estimate** |
| System prompt vs tool definitions | internal `prompt_snapshot` records when present, else one "system+tools" block | **estimate** |
| Files, tools, sub-agents | `tool_use` blocks; `<session>/subagents/*.jsonl` | measured |

The log format is internal to Claude Code and changes between versions. Unknown
record types and malformed lines are counted and shown, never fatal.
Checked against Claude Code 2.1.330.

Codex (`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl[.zst]`), from codex-rs's
rollout and protocol types:

| Figure | Source | Confidence |
|---|---|---|
| Context tokens, window, trend | `event_msg` / `token_count`: `info.last_token_usage.total_tokens` (what Codex itself counts as in the window) and `info.model_context_window`; repeats without new usage are skipped | measured |
| Token totals, cache hit | `info.total_token_usage` (`input_tokens` includes `cached_input_tokens`) | measured |
| Compactions | `compacted` records; size before/after from the neighbouring `token_count` | measured |
| Makeup | `response_item` messages, tool calls and outputs since the last compaction, as for Claude Code; Codex's own instructions and environment messages count as "injected" | **estimate** |
| Files | `apply_patch` (edited / added), `cat`, `sed -n`, `head`, `tail`, `nl` in shell commands (read) | measured, reads are a heuristic |

Sub-agent threads (`parent_thread_id` in `session_meta`) are left out of the list.
Not yet checked against a real Codex log: send one `--json` output if numbers look off.

## Layout

```
src/jsonl-tail.js          incremental, byte-safe JSONL reader (for live polling)
src/claude/session.js      folds log records into a summary (pure, no I/O)
src/claude/load.js         one session + sub-agents + statusLine → snapshot
src/claude/statusline.js   statusLine payload save / read / normalize
src/claude/discover.js     finds session logs
src/claude/models.js       context window per Claude model (Claude Code's table)
src/codex/                 Codex rollout logs → the same snapshot shape
src/match.js               pairs each Herdr pane with its own session (terminal title, folder)
src/quota/                 subscription usage: claude (statusLine), claude-cli (/usage), claude-direct,
                           codex (logs), codex-rpc (app-server), kiro, quota-axi, index (source order)
src/herdr-layout.js        builds the main-context layout from Herdr's main
src/render.js              text output
bin/                       CLI, statusLine collector, install-mod.js (Herdr mod installer)
mod/herdr-context/         the Herdr mod: main.js (drawing), logic.js (pure, tested), sample.js (check data)
test/                      node --test, synthetic fixtures; a fake codex app-server script;
                           main.js run against stand-ins for Herdr's modules.
                           Tests never start the real claude or codex.
```

`npm test` runs the suite.

## Roadmap

1. **Codex context**: done. Next: confirm against a real rollout log.
2. **Herdr mod**: status-bar chip + Context panel in the right sidebar (main-context layout).
   Next: an incremental reader so polling never re-parses whole logs.
3. **Quota**: done (Claude statusLine / `/usage` / direct, Codex logs / app-server, Kiro, quota-axi).
   Next: verify Claude `/usage` text and Kiro against live reports; Cursor without quota-axi.
4. Cursor context: research what its CLI leaves on disk.
