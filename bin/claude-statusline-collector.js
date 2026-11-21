#!/usr/bin/env node
// Claude Code statusLine command that records the payload for herdr-context.
//
// In ~/.claude/settings.json:
//   "statusLine": { "type": "command", "command": "herdr-context-statusline" }
// To keep an existing status line, pass it after --then; its output is shown:
//   "command": "herdr-context-statusline --then '~/.claude/my-statusline.sh'"
//
// Prints nothing of its own, and never fails the status line: any error is
// swallowed so Claude Code keeps working.
import { spawnSync } from 'node:child_process';
import { writeStatusline } from '../src/claude/statusline.js';

const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const input = Buffer.concat(chunks);
  try {
    writeStatusline(JSON.parse(input.toString('utf8')));
  } catch {}

  const i = process.argv.indexOf('--then');
  const next = i !== -1 ? process.argv.slice(i + 1).join(' ') : '';
  if (next) {
    const r = spawnSync(next, { input, shell: true, encoding: 'utf8' });
    if (r.stdout) process.stdout.write(r.stdout);
  }
});
