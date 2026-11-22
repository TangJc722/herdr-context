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
- Sessions from the desktop app / IDE (`source: vscode`), `exec`, `mcp`, sub-agents
  (`source: {subagent}` / `parent_thread_id`) never run in a pane.
- Terminal title: "<spinner> <thread name> | <project>": thread name cut to 48 chars with
  "...", project = git root folder name (24 chars). A pane started in a parent folder must
  be narrowed to the project's own folder (not worktrees inside it, e.g. `wt-m4c`).
- Thread names live in Codex's SQLite DB `$CODEX_HOME/state_<n>.sqlite` (table `threads`:
  id, rollout_path, cwd, source, name, ...), not reliably in `session_index.jsonl`.
  Read it read-only via `node:sqlite` and merge with a rollout scan (incl. `.zst`): never
  rely on the DB alone. Its paths can be Windows verbatim (`\\?\C:\...`): `norm()` strips that.

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
Kiro's `/usage` format is unverified against a real kiro-cli.
