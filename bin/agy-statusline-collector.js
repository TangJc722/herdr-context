#!/usr/bin/env node
// Antigravity (agy) statusLine command that records the plan tier for herdr-context.
//
// In ~/.gemini/antigravity-cli/settings.json (stack_with_default keeps agy's own
// status line; this prints nothing):
//   "statusLine": { "type": "command", "command": "node <path>/agy-statusline-collector.js", "stack_with_default": true }
// To keep an existing status line, pass it after --then; its output is shown.
//
// Never fails the status line: any error is swallowed so agy keeps working.
import { spawnSync } from 'node:child_process';
import { writeAgyStatusline } from '../src/agy/statusline.js';

const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const input = Buffer.concat(chunks);
  try {
    writeAgyStatusline(JSON.parse(input.toString('utf8')));
  } catch {}

  const i = process.argv.indexOf('--then');
  const next = i !== -1 ? process.argv.slice(i + 1).join(' ') : '';
  if (next) {
    const r = spawnSync(next, { input, shell: true, encoding: 'utf8' });
    if (r.stdout) process.stdout.write(r.stdout);
  }
});
