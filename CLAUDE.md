# Notes for working on this repository

- The README exists in two languages: `README.md` (English) and `README.zh-CN.md`
  (Simplified Chinese). Any change to one must be made to the other in the same
  commit, with the same sections in the same order. Command output examples stay
  in English in both (the CLI prints English).
- Commits use the owner's GitHub no-reply identity (set in this repo's
  `.git/config`); do not put a personal email address in commits.
- Run `npm test` before committing. Test fixtures are synthetic: never commit
  real agent session logs, which contain conversation content.

# Facts learned the hard way (read before changing parsing or matching)

Claude Code logs (`~/.claude/projects/<slug>/<session>.jsonl`, slug = cwd with
every non-alphanumeric character as "-"):
- One API response is several `assistant` records sharing `requestId`: count usage once per requestId.
- Context = `input + cache_read + cache_creation` of the last real request.
- API errors (signed out, verification, rate limits) are `assistant` records with
  `isApiErrorMessage`, model `<synthetic>`, zero usage: never count them.
- The window size is not in the log. Order: `HERDR_CONTEXT_WINDOW` > statusLine payload >
  a prompt over 200k (=1M) > Claude Code's model table (`src/claude/models.js`, read from
  the Claude Code binary; opus-5-5 etc. are 1M). Never assume 200k.
- `prompt_snapshot` attachments are bookkeeping, not context; a snapshot may lack `tools`.
- Terminal title = session title (custom-title, else ai-title records), prefixed with a
  status glyph. That is how a Herdr pane is tied to its session (`src/match.js`).

Codex logs (`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl[.zst]`):
- Context = `token_count.info.last_token_usage.total_tokens`; window = `model_context_window`;
  % = (tokens − 12000) / (window − 12000), Codex's own formula.
- token_count repeats without new usage: skip repeats. Old files are zstd (`.zst`).
- `source` is where a thread was *created* and never changes: a thread made in the desktop
  app (`source: vscode`, `originator: Codex Desktop`) and later `codex resume`d in a terminal
  still says `vscode`, in the DB and the rollout's `session_meta`; nothing in the log marks
  the terminal resume (a lone `thread_settings_applied` record at most). So `vscode` / `exec`
  / `mcp` threads stay candidates but match by thread name only, never by folder guess.
  Sub-agents (`source: {subagent}` / `parent_thread_id` / `agent_role`) never run in a pane.
- Codex compresses old rollouts to `.jsonl.zst`, but the DB's `rollout_path` keeps the
  `.jsonl` name: try `<path>.zst` when the file is gone.
- Terminal title: "<spinner> <thread name> | <project>": thread name cut to 48 chars with
  "...", project = git root folder name (24 chars). A pane started in a parent folder must
  be narrowed to the project's own folder (not worktrees inside it, e.g. `wt-m4c`).
- Thread names live in Codex's SQLite DB `$CODEX_HOME/state_<n>.sqlite` (table `threads`:
  id, rollout_path, cwd, source, name, ...), not reliably in `session_index.jsonl`.
  Read it read-only via `node:sqlite` and merge with a rollout scan (incl. `.zst`): never
  rely on the DB alone. Its paths can be Windows verbatim (`\\?\C:\...`): `norm()` strips that.

Antigravity CLI `agy` (`~/.gemini/antigravity-cli`; Herdr calls the pane's app "antigravity"):
- Conversations: `conversation_summaries.db` (workspace_uris = file:/// URIs, parent /
  nesting_depth for sub-conversations); steps in
  `brain/<id>/.system_generated/logs/transcript.jsonl`: USER_INPUT, PLANNER_RESPONSE (tokens,
  `tool_calls` whose arg values are JSON text, e.g. `"\"C:/x/a.js\""`), GENERIC (tool result),
  SYSTEM/ERROR_MESSAGE (API retry: not context). `input_tokens` excludes `cache_read_tokens`.
- agy's own context count/limit is protobuf field 1.9.10 (.1 tokens, .4 limit = 256000 for
  Gemini 3.8 Flash, not the model's 1M) in `conversations/<id>.db` → `gen_metadata`. No
  published schema: decoded by field number only.
- No terminal title. The running agy holds `presence/<id>.lock` open without sharing:
  Node can only see that with libuv's `UV_FS_O_EXLOCK` (0x10000000, not in fs.constants),
  Windows only. Lock files stay behind after agy exits.
- Quota: `agy -p "/usage" --output-format json` answers locally (num_turns 0, zero tokens,
  no conversation), ~10 s. Don't use Antigravity's internal quota endpoints (account risk).
  agy installs to `%LOCALAPPDATA%\agy\bin` and adds it to the *user* PATH: Herdr started
  earlier doesn't see it, so fall back to that path. Its "Eligibility check failed … EOF"
  is a network failure: keep the last reading.
- `/usage` buckets: weekly per group, plus `3p-5h` (window "5h") for Claude/GPT; an unused
  bucket has `reset_time` 1970-01-01 (= none). `--log-file <path>` keeps a run out of agy's
  `log/` folder (else one file per run). The plan/tier is in none of the print-mode answers
  (`/usage`, `/quota`, `/credits`) nor in agy's keyring entry (Credential Manager
  `gemini:antigravity`: token, auth_method, e-mail only; don't read it anyway). It is in the
  statusLine payload (`plan_tier`, also `quota` buckets, `version`, and `email`: never keep
  that), which agy sends to a custom statusLine command in interactive sessions only; the first
  payloads after start lack `plan_tier` (it follows ~3 s later): keep the last one. agy runs
  that command via cmd.exe with `"` escaped to `\"`: quoted paths break, use `node` + a path
  without spaces. `stack_with_default: true` keeps agy's own line when ours prints nothing.
  Try a statusLine with `--settings <file>` (session only, never saved; put the folder in its
  `trustedWorkspaces` to skip the trust prompt), not by editing settings.json.
  An unknown slash command goes to the model (num_turns > 0, spends quota): the probe
  stops for a day when it sees that.
- From Git Bash, `agy -p "/usage"` becomes `C:/Program Files/Git/usage` (MSYS path
  conversion) and goes to the model: run agy from PowerShell, or `MSYS_NO_PATHCONV=1`.
- Sample tool data: `agy -p "<task>" --mode accept-edits` in a scratch folder (headless
  mode auto-denies shell commands). Not `--dangerously-skip-permissions`.

Matching panes to sessions: several sessions share a folder all the time. Never pick
"newest in the folder" without title evidence; when guessing, the panel says so.

Windows (the owner's machine): npm `.cmd` shims can't be spawned by name
(`commandLine()` in `src/quota/common.js`); paths are case-insensitive with backslashes
(`norm()`); Herdr's pane cwd can be a parent of the agent's real cwd.

Herdr mods: no Node APIs (only herdr's exec/readTextFile/...), the mod draws and runs the
bundled CLI; shipped layouts are read-only (hence the `main-context` layout);
`herdr-app check <dir>` must pass. Install with `node bin/install-mod.js`.

Claude quota: `claude -p "/usage"` prints one line per limit
("Current week (all models): 47% used · resets Nov 25, 9am (Asia/Shanghai)").
Neither statusLine nor `/usage` names the plan: it is `oauthAccount.organizationType`
("claude_pro") in `~/.claude.json` (no credentials there; `.credentials.json` has
`subscriptionType` too, but holds tokens: don't read it for this).
Kiro's `/usage` format is unverified against a real kiro-cli.
