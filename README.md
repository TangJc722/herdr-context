# herdr-context

What is in your coding agent's context window, and where it came from.
A data layer and CLI first; a [Herdr](https://herdr.dev) mod on top next.

Supports **Claude Code** today. Codex is next (its rollout events are already mapped, see Roadmap).

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

Every subscription on this machine in one list (`--json` for the mod, `--refresh` to skip the Kiro cache, `--no-axi`):

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

| Provider | Source | Credentials / network |
|---|---|---|
| Claude | statusLine payloads saved by the collector; highest reading of the current window across sessions | none |
| Codex | last `token_count` event with `rate_limits` in `$CODEX_HOME/sessions/**/rollout-*.jsonl[.zst]` | none |
| Kiro | `kiro-cli chat --no-interactive "/usage" --v2`, text parsed, cached 10 min | kiro-cli's own login |
| Cursor, Copilot, Grok, … | [`quota-axi --json`](https://github.com/kunchenguid/quota-axi) when installed | quota-axi reads each CLI's login |

Local sources win; quota-axi stands in when one has nothing. Windows whose reset
time has passed are dropped (shown as `stale`) rather than shown as current.

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
src/quota/                 subscription usage: claude, codex, kiro, quota-axi, index (merge)
src/render.js              text output
bin/                       CLI and statusLine collector
test/                      node --test, synthetic fixtures
```

`npm test` runs the suite.

## Roadmap

1. **Codex adapter**: `~/.codex/sessions/**` rollout events: `token_count`
   (`info.last_token_usage`, `model_context_window`, `rate_limits.primary/secondary`)
   and `context_compacted`. Needs a real sample to confirm.
2. **Herdr mod**: status-bar chip (context % of the focused pane) + side panel; map sessions to panes by cwd / process.
3. **Quota**: done (Claude, Codex, Kiro, quota-axi). Next: verify Kiro and Codex against live output; Cursor without quota-axi.
4. Cursor context: research what its CLI leaves on disk.
