#!/usr/bin/env node
// herdr-context: context windows and subscription usage of your coding agents.
//
//   herdr-context                 latest Claude Code session's context
//   herdr-context --list          recent sessions, one line each
//   herdr-context --session <id>  a session by id (prefix is enough)
//   herdr-context --cwd <dir>     latest session started in <dir>
//   herdr-context quota           subscription usage: Claude, Codex, Kiro (+ quota-axi providers)
//     --refresh                   re-run kiro-cli instead of using its 10-minute cache
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
    json: { type: 'boolean' },
    dir: { type: 'string' },
    refresh: { type: 'boolean' },
    'no-axi': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (a.help) {
  console.log(`usage:
  herdr-context [--list] [--session <id>] [--cwd <dir>] [--json] [--dir <claude projects dir>]
  herdr-context quota [--refresh] [--no-axi] [--json]`);
  process.exit(0);
}

if (positionals[0] === 'quota') {
  const q = collectQuotas({ refresh: a.refresh, axi: !a['no-axi'] });
  console.log(a.json ? JSON.stringify(q, null, 2) : renderQuotas(q));
  process.exit(0);
}
if (positionals.length) {
  console.error(`unknown command: ${positionals[0]} (try --help)`);
  process.exit(2);
}

const dir = a.dir || claudeProjectsDir();
let entries = listClaudeSessions(dir);
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
