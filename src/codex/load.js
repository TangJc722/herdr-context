// Codex sessions for the CLI: find recent rollout logs and read them.
import path from 'node:path';
import { codexHome, listRollouts, readRollout } from '../quota/codex.js';
import { CodexSession } from './session.js';

/** Recent rollout files, newest first: [{agent, file, mtimeMs}]. */
export function listCodexSessions({ home = codexHome(), max = 20 } = {}) {
  return listRollouts(path.join(home, 'sessions'), { maxFiles: max }).map((f) => ({ agent: 'codex', file: f.path, mtimeMs: f.mtimeMs }));
}

export function parseRollout(text, file = null) {
  const s = new CodexSession({ file });
  let malformed = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      malformed++;
      continue;
    }
    s.apply(rec);
  }
  return { session: s, malformed };
}

/** Snapshot of one rollout (same shape as loadClaudeSession's). */
export function loadCodexSession(entry) {
  const { session, malformed } = parseRollout(readRollout(entry.file), entry.file);
  const snap = session.snapshot();
  snap.parseIssues.malformedLines = malformed;
  snap.isSubagent = Boolean(session.parentId);
  return snap;
}
