// Finds Claude Code session logs and their sub-agent logs.
//   ~/.claude/projects/<project-slug>/<sessionId>.jsonl
//   ~/.claude/projects/<project-slug>/<sessionId>/subagents/agent-<id>.jsonl
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function claudeProjectsDir() {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(base, 'projects');
}

/** @returns {{sessionId:string, file:string, mtimeMs:number, subagents:string[]}[]} newest first */
export function listClaudeSessions(projectsDir = claudeProjectsDir()) {
  const out = [];
  let projects;
  try {
    projects = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const proj of projects) {
    if (!proj.isDirectory()) continue;
    const dir = path.join(projectsDir, proj.name);
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isFile() || !ent.name.endsWith('.jsonl')) continue;
      const file = path.join(dir, ent.name);
      const sessionId = ent.name.slice(0, -'.jsonl'.length);
      let subagents = [];
      try {
        const sd = path.join(dir, sessionId, 'subagents');
        subagents = fs.readdirSync(sd).filter((n) => n.endsWith('.jsonl')).map((n) => path.join(sd, n));
      } catch {}
      out.push({ sessionId, file, mtimeMs: fs.statSync(file).mtimeMs, subagents });
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
