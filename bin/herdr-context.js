#!/usr/bin/env node
// herdr-context: context windows and subscription usage of your coding agents.
//
//   herdr-context                 latest Claude Code session's context
//   herdr-context --list          recent sessions, one line each (--limit N, --recent <hours>)
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
import { collectQuotas } from '../src/quota/index.js';
import { renderSession, renderQuotas, fmt, bar } from '../src/render.js';

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
    refresh: { type: 'boolean' },
    passive: { type: 'boolean' },
    direct: { type: 'boolean' },
    'no-axi': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (a.help) {
  console.log(`usage:
  herdr-context [--list] [--session <id>] [--cwd <dir>] [--json] [--dir <claude projects dir>]
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
let entries = listClaudeSessions(dir);
if (a.recent) {
  // only sessions written to in the last N hours (keeps frequent polling cheap)
  const since = Date.now() - Number(a.recent) * 3600e3;
  entries = entries.filter((e) => e.mtimeMs >= since);
  if (!entries.length && a.list) {
    console.log(a.json ? '[]' : 'no recent sessions');
    process.exit(0);
  }
}
if (!entries.length) {
  console.error(`no Claude Code session logs found under ${dir}`);
  process.exit(1);
}

if (a.list) {
  const rows = entries.slice(0, Number(a.limit) || 10).map((e) => loadClaudeSession(e));
  if (a.json) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    for (const s of rows) {
      const c = s.context;
      const p = c.percent == null ? '   ?' : `${String(Math.round(c.percent * 100)).padStart(3)}%`;
      console.log(`${(s.sessionId || '?').slice(0, 8)}  ${bar(c.percent, 12)} ${p}  ${fmt(c.tokens).padStart(6)}  ${String(s.requestCount).padStart(4)} req  ${s.lastTs ?? ''}  ${s.cwd ?? ''}`);
    }
  }
  process.exit(0);
}

if (a.session) entries = entries.filter((e) => e.sessionId.startsWith(a.session));
if (a.cwd) {
  const want = a.cwd.replace(/\/+$/, '');
  entries = entries.filter((e) => loadClaudeSession(e).cwd === want);
}
if (!entries.length) {
  console.error('no matching session');
  process.exit(1);
}

const snap = loadClaudeSession(entries[0]);
console.log(a.json ? JSON.stringify(snap, null, 2) : renderSession(snap));
