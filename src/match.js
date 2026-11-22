// Which session runs in which Herdr pane.
//
// Herdr tells a mod each pane's folder, its terminal title and the agent it
// runs, but not the agent's session id. Several sessions often share a folder,
// so "the newest session in the folder" is wrong whenever two windows (or an
// earlier, finished session) use the same folder. What pins a pane down:
//
// - Claude Code sets the terminal title to the session's title (custom title
//   from /rename, else the AI-generated one), and writes the same title to the
//   session log as {"type":"custom-title"} / {"type":"ai-title"} records.
//   The title is prefixed with a status glyph ("✳", "◐", "◑", ">", "*").
// - Codex puts the thread name (from /rename, kept in
//   $CODEX_HOME/session_index.jsonl) in the terminal title, when there is one.
//   Newer Codex keeps every thread (folder, name, log path, origin) in a SQLite
//   database, $CODEX_HOME/state_<n>.sqlite (table "threads"); it is read
//   read-only with Node's built-in node:sqlite when available, and merged with
//   a scan of the rollout logs' first lines. The title's thread part is the
//   thread name cut to 48 characters with "...".
//   A thread keeps the origin it was created with: one started in the desktop
//   app / IDE (source "vscode") or by `codex exec` and later resumed in a
//   terminal still says so. Such threads are matched by thread name only,
//   never guessed by folder. Sub-agent threads never run in a pane.
//
// Without a title match: the newest session in the folder that is not already
// another pane's and does not carry a different title.
//
// Per-file facts (folder, titles) are cached by file size in
// ~/.cache/herdr-context/session-meta.json, so polling reads only new bytes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { claudeProjectsDir } from './claude/discover.js';
import { loadClaudeSession } from './claude/load.js';
import { codexHome, listRollouts, readRollout } from './quota/codex.js';
import { loadCodexSession } from './codex/load.js';

export const norm = (p) => {
  if (!p || typeof p !== 'string') return null;
  // Windows verbatim paths ("\\?\C:\x", "\\?\UNC\host\x"), as Rust programs print them
  let s = p.replace(/^[\\/]{2}\?[\\/]UNC[\\/]/i, '//').replace(/^[\\/]{2}\?[\\/]/, '').replace(/\\/g, '/');
  if (s.length > 1) s = s.replace(/\/+$/, '');
  if (/^[a-zA-Z]:(\/|$)/.test(s)) s = s.toLowerCase();
  return s;
};

/** Claude Code's project folder name for a cwd: every non-alphanumeric character becomes "-". */
export const projectSlug = (cwd) => String(cwd ?? '').replace(/[^a-zA-Z0-9]/g, '-');

/** "same" | "near" (one folder inside the other) | null */
export function folderRelation(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return null;
  if (x === y) return 'same';
  if (x.startsWith(y + '/') || y.startsWith(x + '/')) return 'near';
  return null;
}

/** A terminal title without its status glyphs/spinner, lower-cased, for comparing. */
export function titleKey(t) {
  const s = String(t ?? '')
    .replace(/^[\s✳✻✶✢✽◐◑◒◓●○•·>*⠀-⣿|-]+/u, '')
    .trim()
    .toLowerCase();
  return s || null;
}

const GENERIC_TITLE = /^(claude( code)?|codex|bash|zsh|fish|sh|pwsh|powershell|cmd|windows powershell)$/i;

// ---------- per-file facts, cached ----------

function metaCachePath(env) {
  const base = env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, 'herdr-context', 'session-meta.json');
}

function loadMetaCache(env) {
  try {
    const c = JSON.parse(fs.readFileSync(metaCachePath(env), 'utf8'));
    return c && c.v === 1 && typeof c.files === 'object' ? c : { v: 1, files: {} };
  } catch {
    return { v: 1, files: {} };
  }
}

function saveMetaCache(cache, env, keep) {
  try {
    // only files seen this run, so the cache never grows without bound
    const files = Object.fromEntries(Object.entries(cache.files).filter(([f]) => keep.has(f)));
    fs.mkdirSync(path.dirname(metaCachePath(env)), { recursive: true });
    fs.writeFileSync(metaCachePath(env), JSON.stringify({ v: 1, files }));
  } catch {}
}

function readRange(file, start, end) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(end - start);
    const n = fs.readSync(fd, buf, 0, buf.length, start);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

/** Folder and titles of a Claude Code log, reading only bytes added since last time. */
export function claudeMeta(file, size, cache) {
  let m = cache.files[file];
  if (!m || m.kind !== 'claude' || m.offset > size) m = { kind: 'claude', offset: 0, cwd: null, customTitle: null, aiTitle: null };
  if (m.offset < size) {
    const buf = readRange(file, m.offset, size);
    const last = buf.lastIndexOf(0x0a);
    if (last !== -1) {
      for (const line of buf.subarray(0, last).toString('utf8').split('\n')) {
        const want = (!m.cwd && line.includes('"cwd"')) || line.includes('-title"');
        if (!want) continue;
        let r;
        try {
          r = JSON.parse(line);
        } catch {
          continue;
        }
        if (!m.cwd && typeof r.cwd === 'string') m.cwd = r.cwd;
        if (r.type === 'custom-title' && typeof r.customTitle === 'string') m.customTitle = r.customTitle;
        if (r.type === 'ai-title' && typeof r.aiTitle === 'string') m.aiTitle = r.aiTitle;
      }
      m.offset += last + 1;
    }
  }
  cache.files[file] = m;
  return m;
}

/** Folder, id and origin of a Codex rollout, from its first line (session_meta). */
export function codexMeta(file, cache) {
  const hit = cache.files[file];
  if (hit && hit.kind === 'codex') return hit;
  const m = { kind: 'codex', id: null, cwd: null, source: null, sub: false };
  try {
    let head;
    if (file.endsWith('.zst')) {
      // cold (compressed) logs: decompressed once; the header never changes, so it stays cached
      head = readRollout(file).slice(0, 8 * 1024 * 1024);
    } else {
      head = readRange(file, 0, 256 * 1024).toString('utf8');
    }
    // the header carries the base instructions and can be long: read on to its end
    if (!head.includes('\n') && !file.endsWith('.zst')) head = readRange(file, 0, 8 * 1024 * 1024).toString('utf8');
    const first = head.split('\n')[0];
    let p = null;
    try {
      p = JSON.parse(first).payload;
    } catch {
      // first line longer than what we read: pick the fields out of the text
      const field = (k) => {
        const r = first.match(new RegExp(`"${k}":"((?:[^"\\\\]|\\\\.)*)"`));
        return r ? JSON.parse(`"${r[1]}"`) : null;
      };
      p = { id: field('id'), cwd: field('cwd'), source: field('source'), parent_thread_id: field('parent_thread_id') };
      if (/"source":\{"(subagent|internal)"/.test(first)) p.source = { subagent: true };
    }
    const meta = p?.meta ?? p ?? {};
    m.id = meta.id ?? null;
    m.cwd = meta.cwd ?? null;
    m.source = typeof meta.source === 'string' ? meta.source : meta.source ? Object.keys(meta.source)[0] : null;
    m.sub = Boolean(meta.parent_thread_id || (meta.source && typeof meta.source === 'object') || meta.agent_role);
  } catch {}
  cache.files[file] = m;
  return m;
}

/** Thread names from $CODEX_HOME/session_index.jsonl (newest entry wins). */
export function codexThreadNames(home) {
  const names = new Map();
  let text = '';
  try {
    text = fs.readFileSync(path.join(home, 'session_index.jsonl'), 'utf8');
  } catch {
    return names;
  }
  for (const line of text.split('\n')) {
    try {
      const e = JSON.parse(line);
      if (e?.id && typeof e.thread_name === 'string') names.set(e.id, e.thread_name);
    } catch {}
  }
  return names;
}

// ---------- candidates ----------

function claudeCandidates(cwd, projectsDir, cache, seen) {
  const slug = projectSlug(cwd).toLowerCase();
  let dirs = [];
  try {
    dirs = fs.readdirSync(projectsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const out = [];
  for (const d of dirs) {
    const l = d.toLowerCase();
    if (!(l === slug || l.startsWith(slug + '-') || slug.startsWith(l + '-'))) continue;
    const dir = path.join(projectsDir, d);
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const n of names) {
      const file = path.join(dir, n);
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      seen.add(file);
      const m = claudeMeta(file, st.size, cache);
      const rel = folderRelation(m.cwd, cwd);
      if (!rel) continue;
      out.push({
        agent: 'claude', file, rel, mtimeMs: st.mtimeMs, id: n.slice(0, -'.jsonl'.length),
        title: m.customTitle ?? m.aiTitle ?? null, titles: [m.customTitle, m.aiTitle].filter(Boolean),
      });
    }
  }
  return out;
}

// Threads started in a terminal. Others (desktop app / IDE, exec, mcp) can be
// resumed in one, so they stay candidates, but only for a thread-name match.
const PANE_SOURCES = new Set(['cli', 'unknown', null]);
const paneSource = (src) => PANE_SOURCES.has(src == null || src === '' ? null : String(src).replace(/^"|"$/g, '').trim().toLowerCase());

/** stat of a rollout, or of its compressed copy: Codex zstd-compresses old logs and the database keeps the old name. */
function statRollout(file) {
  for (const f of file.endsWith('.zst') ? [file] : [file, file + '.zst']) {
    try {
      return { file: f, st: fs.statSync(f) };
    } catch {}
  }
  return null;
}

/** Codex's thread list from its state database, or null when it can't be read. */
export function codexStateThreads(home, env = process.env) {
  const dir = env.CODEX_SQLITE_HOME ? path.resolve(env.CODEX_SQLITE_HOME) : home;
  let file;
  try {
    file = fs.readdirSync(dir)
      .filter((n) => /^state_\d+\.sqlite$/.test(n))
      .sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]))[0];
  } catch {
    return null;
  }
  if (!file) return null;
  const emit = process.emitWarning;
  let db;
  try {
    process.emitWarning = () => {}; // node:sqlite announces itself as experimental on stderr
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    db = new DatabaseSync(path.join(dir, file), { readOnly: true });
    const cols = new Set(db.prepare('PRAGMA table_info(threads)').all().map((c) => c.name));
    const pick = ['id', 'rollout_path', 'cwd', 'source', 'name', 'agent_role', 'archived', 'updated_at', 'updated_at_ms'].filter((c) => cols.has(c));
    if (!cols.has('rollout_path') || !cols.has('cwd')) return null;
    return db.prepare(`SELECT ${pick.join(', ')} FROM threads ORDER BY updated_at DESC LIMIT 5000`).all().map((r) => ({
      id: r.id ?? null,
      file: r.rollout_path,
      cwd: r.cwd,
      source: r.source ?? null,
      sub: Boolean(r.agent_role) || /^\s*\{/.test(String(r.source ?? '')),
      name: r.name || null,
    }));
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {}
    process.emitWarning = emit;
  }
}

/** Codex candidates from its state database. */
function codexDbCandidates(cwd, threads, names) {
  const out = [];
  for (const t of threads) {
    if (t.sub || !t.file) continue;
    const rel = folderRelation(t.cwd, cwd);
    if (!rel) continue;
    const hit = statRollout(t.file);
    if (!hit) continue;
    const titles = [t.name, t.id ? names.get(t.id) : null].filter(Boolean);
    out.push({
      agent: 'codex', file: hit.file, rel, cwd: t.cwd, mtimeMs: hit.st.mtimeMs, id: t.id, title: titles[0] ?? null, titles,
      titleOnly: !paneSource(t.source),
    });
  }
  return out;
}

function codexCandidates(cwd, rollouts, cache, names, seen) {
  const out = [];
  for (const r of rollouts) {
    seen.add(r.path);
    const m = codexMeta(r.path, cache);
    if (m.sub) continue;
    const rel = folderRelation(m.cwd, cwd);
    if (!rel) continue;
    const name = m.id ? names.get(m.id) ?? null : null;
    out.push({
      agent: 'codex', file: r.path, rel, cwd: m.cwd, mtimeMs: r.mtimeMs, id: m.id, title: name, titles: name ? [name] : [],
      titleOnly: !paneSource(m.source),
    });
  }
  return out;
}

// ---------- assignment ----------

/**
 * The project name in a Codex terminal title. Codex's default title is
 * "<spinner> <thread name> | <project>", where <project> is the git root's
 * folder name (else the cwd's), cut to 24 characters with "…".
 * @returns {{name:string, prefix:boolean}|null}
 */
export function codexTitleProject(title) {
  const parts = String(title ?? '').split(' | ');
  const last = titleKey(parts[parts.length - 1]);
  if (!last || GENERIC_TITLE.test(last)) return null;
  const cut = /(…|\.\.\.)$/.test(last);
  return { name: last.replace(/(…|\.\.\.)$/, '').trimEnd(), prefix: cut };
}

/** The thread-name part of a Codex title ("<spinner> <name> | <project>"), or null. */
export function codexTitleThread(title) {
  const parts = String(title ?? '').split(' | ');
  if (parts.length < 2) return null;
  const first = titleKey(parts[0]);
  if (!first) return null;
  const cut = /(…|\.\.\.)$/.test(first);
  return { name: first.replace(/(…|\.\.\.)$/, '').trimEnd(), prefix: cut };
}

/** Whether a session folder sits in (or is) the project the title names. */
export function inProject(cwd, project) {
  if (!project || !cwd) return false;
  return (norm(cwd) ?? '').toLowerCase().split('/').some((seg) => (project.prefix ? seg.startsWith(project.name) : seg === project.name));
}

/** Whether a session folder is the project folder itself (its last segment). */
export function isProjectRoot(cwd, project) {
  if (!project || !cwd) return false;
  const last = (norm(cwd) ?? '').toLowerCase().split('/').pop();
  return project.prefix ? last.startsWith(project.name) : last === project.name;
}

/**
 * Pairs panes with sessions. Pure: candidates are given.
 * @param {{pane:string, title?:string, cands:object[]}[]} items
 * @returns {Map<string, {cand:object, how:'title'|'folder', others:number}>}
 */
export function assign(items) {
  const taken = new Set();
  const result = new Map();
  const titleMatches = (it, c) => {
    const k = titleKey(it.title);
    if (!k) return false;
    if (c.agent === 'codex') {
      const thread = codexTitleThread(it.title);
      return c.titles.some((t) => {
        const n = t.trim().toLowerCase();
        if (thread) return thread.prefix ? n.startsWith(thread.name) : n === thread.name;
        // a custom title layout: too loose for threads started outside a terminal
        return !c.titleOnly && n.length >= 3 && k.includes(n);
      });
    }
    return c.titles.some((t) => titleKey(t) === k);
  };
  // 1. exact title matches (Codex: in the title's project first, as names repeat across projects)
  for (const it of items) {
    const proj = it.agent === 'codex' ? codexTitleProject(it.title) : null;
    const inProj = (x) => (proj && inProject(x.cwd, proj) ? 0 : 1);
    const c = it.cands
      .filter((x) => !taken.has(x.file) && titleMatches(it, x))
      .sort((a, b) => inProj(a) - inProj(b) || b.mtimeMs - a.mtimeMs)[0];
    if (c) {
      taken.add(c.file);
      result.set(it.pane, { cand: c, how: 'title', others: 0 });
    }
  }
  // 2. the rest: newest free session, own folder first, skipping sessions whose
  //    title says they belong to another window
  for (const it of items) {
    if (result.has(it.pane)) continue;
    const k = titleKey(it.title);
    const specific = k && !GENERIC_TITLE.test(k);
    // threads started outside a terminal are never guessed by folder: only a name ties one to a pane
    let free = it.cands.filter((x) => !taken.has(x.file) && !x.titleOnly);
    // Codex: a pane started in a parent folder sees every sub-project's sessions;
    // the project named in its title narrows them down
    if (it.agent === 'codex') {
      const proj = codexTitleProject(it.title);
      const inIt = free.filter((x) => inProject(x.cwd, proj));
      // the project's own folder before folders inside it (e.g. a worktree there)
      const root = inIt.filter((x) => isProjectRoot(x.cwd, proj));
      if (root.length) free = root;
      else if (inIt.length) free = inIt;
    }
    const order = (a, b) => (a.rel === 'same' ? 0 : 1) - (b.rel === 'same' ? 0 : 1) || b.mtimeMs - a.mtimeMs;
    const fit = free.filter((x) => !specific || it.agent === 'codex' || !x.title).sort(order);
    // nothing untitled left: the newest anyway (the panel says it is a guess)
    const c = fit[0] ?? free.sort(order)[0] ?? null;
    if (c) {
      taken.add(c.file);
      result.set(it.pane, { cand: c, how: 'folder', others: free.length - 1 });
    }
  }
  return result;
}

/**
 * @param {{pane:string, agent:'claude'|'codex', cwd:string, title?:string}[]} panes
 * @returns {{pane:string, agent:string, how:string|null, others:number, session:object|null, error?:string}[]}
 */
export function matchPanes(panes, { env = process.env, projectsDir = claudeProjectsDir(), home = codexHome(env) } = {}) {
  const cache = loadMetaCache(env);
  const seen = new Set();
  const list = (panes ?? []).filter((p) => p && p.pane && p.cwd && (p.agent === 'claude' || p.agent === 'codex'));
  let rollouts = null;
  let names = null;
  let threads; // undefined: not read yet; null: no database
  const items = list.map((p) => {
    if (p.agent === 'claude') return { ...p, cands: claudeCandidates(p.cwd, projectsDir, cache, seen) };
    if (threads === undefined) {
      threads = codexStateThreads(home, env);
      names = codexThreadNames(home);
      for (const t of threads ?? []) if (t.id && t.name) names.set(t.id, t.name); // the database knows newer names
    }
    rollouts ??= listRollouts(path.join(home, 'sessions'), { maxFiles: 400 });
    // both sources, merged by log file: the database alone has missed sessions
    // (paths written differently), the log scan alone misses old ones
    const fromDb = threads ? codexDbCandidates(p.cwd, threads, names) : [];
    const fromLogs = codexCandidates(p.cwd, rollouts, cache, names, seen);
    const byFile = new Map();
    for (const c of [...fromDb, ...fromLogs]) {
      const k = norm(c.file)?.toLowerCase();
      if (!byFile.has(k)) byFile.set(k, c);
    }
    const cands = [...byFile.values()];
    const titleOnly = cands.filter((c) => c.titleOnly).length;
    const diag = `Codex: database ${threads ? `${threads.length} threads, ${fromDb.length} here` : 'not readable'} · logs ${rollouts.length} scanned, ${fromLogs.length} here`
      + (titleOnly ? ` · ${titleOnly} from the app/exec (name match only)` : '');
    return { ...p, cands, diag };
  });
  const byKind = (k) => assign(items.filter((i) => i.agent === k));
  const pairs = new Map([...byKind('claude'), ...byKind('codex')]);
  saveMetaCache(cache, env, seen);

  return list.map((p) => {
    const hit = pairs.get(p.pane);
    const diag = items.find((i) => i.pane === p.pane)?.diag ?? null;
    if (!hit) return { pane: p.pane, agent: p.agent, how: null, others: 0, session: null, diag, paneTitle: p.title ?? null };
    const { cand, how, others } = hit;
    try {
      const session = cand.agent === 'claude' ? loadClaudeSession(claudeEntry(cand), { env }) : loadCodexSession({ file: cand.file });
      return { pane: p.pane, agent: p.agent, how, others, paneTitle: p.title ?? null, file: cand.file, diag, session };
    } catch (err) {
      return { pane: p.pane, agent: p.agent, how, others, session: null, error: `${err.name}: ${err.message}` };
    }
  });
}

function claudeEntry(cand) {
  let subagents = [];
  try {
    const sd = path.join(path.dirname(cand.file), cand.id, 'subagents');
    subagents = fs.readdirSync(sd).filter((n) => n.endsWith('.jsonl')).map((n) => path.join(sd, n));
  } catch {}
  return { sessionId: cand.id, file: cand.file, mtimeMs: cand.mtimeMs, subagents };
}
