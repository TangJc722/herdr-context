// Fresh Claude limits from Claude Code itself: `claude -p "/usage"`.
// /usage supports non-interactive mode, needs no model call, and lets Claude
// Code use (and renew) its own login. Hardening, after CodexBar's CLI probe:
//   --no-session-persistence   writes no session log
//   --tools ""                 no built-in tools
//   --strict-mcp-config        does not start the user's MCP servers
//   --settings {...}           no hooks, no Remote Control for this process only
//   cwd = a dedicated empty directory (no project CLAUDE.md, no trust prompts)
//
// The report is text. Parsing follows CodexBar's description: blocks headed
// "Current session" / "Current week (...)" with "N% used|left" and a
// "Resets ..." line; the "What's contributing to your limits usage?" section is
// ignored. NOT yet checked against a live Pro/Max report: on a login without a
// subscription (verified) the command prints only session cost lines.
import fs from 'node:fs';
import path from 'node:path';
import { quota, runCommand, stripAnsi, quotaCacheDir } from './common.js';

const ARGS = [
  '-p', '/usage',
  '--no-session-persistence',
  '--tools', '',
  '--strict-mcp-config',
  '--settings', JSON.stringify({ disableAllHooks: true, remoteControlAtStartup: false }),
];

function windowFor(title) {
  const t = title.toLowerCase();
  if (t.includes('session')) return { id: 'five_hour', label: '5h', windowMinutes: 300 };
  const scope = t.match(/\(([^)]+)\)/)?.[1] ?? '';
  if (!scope || /all models/.test(scope)) return { id: 'seven_day', label: 'week', windowMinutes: 10080 };
  const name = scope.replace(/\s*only\s*/, '').trim();
  const pretty = name.charAt(0).toUpperCase() + name.slice(1);
  return { id: `seven_day_${name.replace(/\W+/g, '_')}`, label: `${pretty} week`, windowMinutes: 10080 };
}

/** Parses the /usage text report. Returns windows (possibly empty). */
export function parseClaudeUsage(raw) {
  let text = stripAnsi(raw).replace(/\r/g, '\n');
  const cut = text.search(/what'?s contributing/i);
  if (cut !== -1) text = text.slice(0, cut);
  const windows = [];
  let cur = null;
  const flush = () => {
    if (cur && typeof cur.usedPercent === 'number') windows.push(cur);
    cur = null;
  };
  for (const line of text.split('\n')) {
    const head = line.match(/^\s*(Current\s+(?:session|week)[^\n]*?)\s*$/i);
    if (head) {
      flush();
      cur = { ...windowFor(head[1]), usedPercent: null, resetsAt: null, detail: null };
      continue;
    }
    if (!cur) continue;
    const pct = line.match(/(\d+(?:\.\d+)?)\s*%\s*(used|left|remaining)?/i);
    if (pct && cur.usedPercent == null) {
      const n = Number(pct[1]);
      cur.usedPercent = /left|remaining/i.test(pct[2] || '') ? 100 - n : n;
    }
    const reset = line.match(/\bResets?\b\s*(.+)$/i);
    if (reset) cur.detail = `resets ${reset[1].trim()}`;
  }
  flush();
  return windows;
}

export function probeDir(env = process.env) {
  return path.join(quotaCacheDir(env), 'claude-probe');
}

export function claudeCliQuota({ run = runCommand, env = process.env, now = Date.now(), timeoutMs = 30000 } = {}) {
  const cwd = probeDir(env);
  try {
    fs.mkdirSync(cwd, { recursive: true });
  } catch {}
  const r = run('claude', ARGS, { timeoutMs, env, cwd });
  if (r.notFound) return quota('claude', 'claude /usage', { status: 'not_found', message: 'claude CLI not installed' });
  if (r.timedOut) return quota('claude', 'claude /usage', { status: 'error', message: 'claude /usage timed out' });
  const out = `${r.stdout}\n${r.stderr}`;
  const windows = parseClaudeUsage(out);
  if (windows.length) {
    return quota('claude', 'claude /usage', { observedAt: new Date(now).toISOString(), windows, message: 'parsed from text; reset times shown as Claude prints them' });
  }
  const signedOut = /log ?in|sign ?in|authenticat/i.test(out);
  return quota('claude', 'claude /usage', {
    status: 'not_found',
    message: signedOut ? 'Claude Code is not signed in' : '/usage showed no plan limits (API-key login, or a plan without limits)',
  });
}
