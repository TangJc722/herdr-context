#!/usr/bin/env node
// herdr-context: context windows and subscription usage of your coding agents.
//
//   herdr-context                 latest session's context (Claude Code or Codex)
//   herdr-context --list          recent sessions, one line each (--limit N, --recent <hours>)
//   herdr-context --agent codex   only one agent's sessions (claude | codex)
//   herdr-context --session <id>  a session by id (prefix is enough)
//   herdr-context --cwd <dir>     latest session started in <dir>
//   herdr-context quota           subscription usage: Claude, Codex, Kiro (+ quota-axi providers)
//     --refresh                   ignore caches and freshness checks, ask every source now
//     --passive                   never start claude / codex processes; local data only
//     --direct                    Claude: read Claude Code's login (read-only) and ask the
//                                 usage endpoint directly (also HERDR_CONTEXT_CLAUDE_DIRECT=1)
//     --no-axi                    do not call quota-axi
//   --json                        machine-readable output (for the Herdr mod)
import { parseArgs } from 'node:util';
import { listClaudeSessions, claudeProjectsDir } from '../src/claude/discover.js';
import { loadClaudeSession } from '../src/claude/load.js';
import { listCodexSessions, loadCodexSession } from '../src/codex/load.js';
import { collectQuotas } from '../src/quota/index.js';
import { renderSession, renderQuotas, fmt, bar } from '../src/render.js';

// Anything unexpected: one readable line on stderr (the Herdr mod shows it), not a stack.
const die = (err) => {
  console.error(`herdr-context: ${err?.name ?? 'Error'}: ${err?.message ?? err}`);
  if (process.env.HERDR_CONTEXT_DEBUG) console.error(err?.stack);
  process.exit(1);
};
process.on('uncaughtException', die);
process.on('unhandledRejection', die);

const { values: a, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    session: { type: 'string', short: 's' },
    cwd: { type: 'string' },
    list: { type: 'boolean', short: 'l' },
    limit: { type: 'string', default: '10' },
    recent: { type: 'string' },
    json: { type: 'boolean' },
    dir: { type: 'string' },
    agent: { type: 'string' },
    refresh: { type: 'boolean' },
    passive: { type: 'boolean' },
    direct: { type: 'boolean' },
    'no-axi': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (a.help) {
  console.log(`usage:
  herdr-context [--list] [--agent claude|codex] [--session <id>] [--cwd <dir>] [--json] [--dir <claude projects dir>]
  herdr-context quota [--refresh] [--passive] [--direct] [--no-axi] [--json]`);
  process.exit(0);
}

if (positionals[0] === 'quota') {
  const q = await collectQuotas({
    refresh: a.refresh,
    active: !a.passive,
    direct: a.direct || process.env.HERDR_CONTEXT_CLAUDE_DIRECT === '1',
    axi: !a['no-axi'],
  });
  console.log(a.json ? JSON.stringify(q, null, 2) : renderQuotas(q));
  process.exit(0);
}
if (positionals.length) {
  console.error(`unknown command: ${positionals[0]} (try --help)`);
  process.exit(2);
}

const dir = a.dir || claudeProjectsDir();
const want = a.agent ? a.agent.toLowerCase() : null;
if (want && want !== 'claude' && want !== 'codex') {
  console.error(`unknown agent: ${a.agent} (claude or codex)`);
  process.exit(2);
}
// Both agents' sessions, newest first. Each entry knows how to load itself.
let entries = [
  ...(want === 'codex' ? [] : listClaudeSessions(dir).map((e) => ({ ...e, agent: 'claude', load: () => loadClaudeSession(e) }))),
  ...(want === 'claude' ? [] : listCodexSessions({ max: 40 }).map((e) => ({ ...e, load: () => loadCodexSession(e) }))),
].sort((x, y) => y.mtimeMs - x.mtimeMs);
if (a.recent) {
  // only sessions written to in the last N hours (keeps frequent polling cheap)
  const since = Date.now() - Number(a.recent) * 3600e3;
  entries = entries.filter((e) => e.mtimeMs >= since);
}
// Codex sub-agent threads are not sessions of their own; a rollout with
// neither a session header nor usage has nothing to show.
const skip = (s) => s.isSubagent || (s.agent === 'codex' && !s.error && !s.sessionId && !s.requestCount);
if (!entries.length && a.list) {
  console.log(a.json ? '[]' : 'no sessions');
  process.exit(0);
}
if (!entries.length) {
  console.error(`no session logs found (Claude Code: ${dir}; Codex: $CODEX_HOME/sessions)`);
  process.exit(1);
}

if (a.list) {
  // One unreadable session must not hide the others: it becomes an {error} row.
  const limit = Number(a.limit) || 10;
  const rows = [];
  for (const e of entries) {
    if (rows.length >= limit) break;
    let snap;
    try {
      snap = e.load();
    } catch (err) {
      snap = { agent: e.agent, sessionId: e.sessionId ?? null, file: e.file, error: `${err.name}: ${err.message}` };
    }
    if (skip(snap)) continue;
    rows.push(snap);
  }
  if (a.json) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    for (const s of rows) {
      if (s.error) {
        console.log(`${s.agent.padEnd(6)} ${(s.sessionId || '?').slice(0, 8)}  could not read: ${s.error}`);
        continue;
      }
      const c = s.context;
      const p = c.percent == null ? '   ?' : `${String(Math.round(c.percent * 100)).padStart(3)}%`;
      console.log(`${s.agent.padEnd(6)} ${(s.sessionId || '?').slice(0, 8)}  ${bar(c.percent, 12)} ${p}  ${fmt(c.tokens).padStart(6)}  ${String(s.requestCount).padStart(4)} req  ${s.lastTs ?? ''}  ${s.cwd ?? ''}`);
    }
  }
  process.exit(0);
}

// One session: by id, by folder, else the newest.
const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
let snap = null;
for (const e of entries) {
  if (a.session && e.sessionId && !e.sessionId.startsWith(a.session)) continue;
  const s = e.load();
  if (skip(s)) continue;
  if (a.session && !String(s.sessionId ?? '').startsWith(a.session)) continue;
  if (a.cwd && norm(s.cwd) !== norm(a.cwd)) continue;
  snap = s;
  break;
}
if (!snap) {
  console.error('no matching session');
  process.exit(1);
}
console.log(a.json ? JSON.stringify(snap, null, 2) : renderSession(snap));
