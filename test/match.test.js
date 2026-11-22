import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { matchPanes, titleKey, projectSlug, folderRelation, assign } from '../src/match.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hc-match-'));
const jl = (recs) => recs.map((r) => JSON.stringify(r)).join('\n') + '\n';

function claudeLog(dir, cwd, id, { title, custom, tokens, ts }) {
  const d = path.join(dir, projectSlug(cwd));
  fs.mkdirSync(d, { recursive: true });
  const recs = [
    { type: 'user', cwd, sessionId: id, timestamp: ts, message: { role: 'user', content: 'hi' } },
    { type: 'assistant', cwd, sessionId: id, timestamp: ts, requestId: `r-${id}`, message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: tokens, output_tokens: 10 } } },
  ];
  if (title) recs.push({ type: 'ai-title', aiTitle: title, sessionId: id });
  if (custom) recs.push({ type: 'custom-title', customTitle: custom, sessionId: id });
  const f = path.join(d, `${id}.jsonl`);
  fs.writeFileSync(f, jl(recs));
  const t = new Date(ts);
  fs.utimesSync(f, t, t);
  return f;
}

function rollout(home, name, meta, tokens, ts) {
  const d = path.join(home, 'sessions', '2026', '11', '20');
  fs.mkdirSync(d, { recursive: true });
  const u = { input_tokens: tokens, cached_input_tokens: 0, output_tokens: 0, total_tokens: tokens };
  const f = path.join(d, `rollout-${name}.jsonl`);
  fs.writeFileSync(f, jl([
    { timestamp: ts, type: 'session_meta', payload: { cwd: '/w', originator: 'codex_cli_rs', cli_version: '0.1', base_instructions: { text: 'x'.repeat(300000) }, ...meta } },
    { timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: u, last_token_usage: u, model_context_window: 272000 } } },
  ]));
  const t = new Date(ts);
  fs.utimesSync(f, t, t);
}

test('titles, slugs, folders', () => {
  assert.equal(titleKey('✳ Fix login'), 'fix login');
  assert.equal(titleKey('◐ DSH插件设计评审与优化'), 'dsh插件设计评审与优化');
  assert.equal(titleKey('⠋ deck work'), 'deck work');
  assert.equal(titleKey('  '), null);
  assert.equal(projectSlug('C:\\tempDisk\\Project\\myProjects'), 'C--tempDisk-Project-myProjects');
  assert.equal(projectSlug('/home/user/herdr-context'), '-home-user-herdr-context');
  assert.equal(folderRelation('C:\\Work\\a', 'c:/work/a/'), 'same');
  assert.equal(folderRelation('/w', '/w/sub'), 'near');
  assert.equal(folderRelation('/w', '/w2'), null);
});

test('Claude panes in one folder each get their own session, by terminal title', () => {
  const dir = tmp();
  const env = { XDG_CACHE_HOME: tmp() };
  claudeLog(dir, '/w', 'old-fix', { title: 'Fix login', tokens: 63000, ts: '2026-11-22T08:00:00Z' });
  claudeLog(dir, '/w', 'new-hud', { title: 'Set up claude-hud', tokens: 20000, ts: '2026-11-22T09:00:00Z' });
  claudeLog(dir, '/w', 'renamed', { title: 'AI name', custom: 'My name', tokens: 5000, ts: '2026-11-22T07:00:00Z' });
  claudeLog(dir, '/elsewhere', 'other', { title: 'Fix login', tokens: 1, ts: '2026-11-22T10:00:00Z' });
  const panes = [
    { pane: 'p1', agent: 'claude', cwd: '/w', title: '✳ Fix login' },
    { pane: 'p2', agent: 'claude', cwd: '/w', title: 'Claude Code' },
    { pane: 'p3', agent: 'claude', cwd: '/w', title: '◐ My name' },
  ];
  const r = Object.fromEntries(matchPanes(panes, { env, projectsDir: dir, home: tmp() }).map((x) => [x.pane, [x.how, x.session?.sessionId]]));
  assert.deepEqual(r, { p1: ['title', 'old-fix'], p2: ['folder', 'new-hud'], p3: ['title', 'renamed'] });
  // second run reads the cache and gives the same answer
  const again = matchPanes(panes, { env, projectsDir: dir, home: tmp() });
  assert.equal(again[0].session.sessionId, 'old-fix');
  assert.equal(again[0].session.context.tokens, 63000);
});

test('a titled pane does not take a session titled for another window', () => {
  const mk = (file, title, mtimeMs, rel = 'same') => ({ agent: 'claude', file, title, titles: title ? [title] : [], mtimeMs, rel });
  const r = assign([{ pane: 'p', agent: 'claude', title: '✳ Something new', cands: [mk('a', 'Other window', 2), mk('b', null, 1)] }]);
  assert.equal(r.get('p').cand.file, 'b');
  // nothing untitled: the newest, flagged as a guess (others > 0)
  const g = assign([{ pane: 'p', agent: 'claude', title: '✳ Something new', cands: [mk('a', 'Other window', 2), mk('c', 'Third', 1)] }]);
  assert.deepEqual([g.get('p').cand.file, g.get('p').how, g.get('p').others], ['a', 'folder', 1]);
});

test('Codex panes: thread name, then newest terminal session; app, exec and sub-agent threads never', () => {
  const home = tmp();
  const env = { XDG_CACHE_HOME: tmp() };
  rollout(home, 'cli-old', { id: 'cli-old', source: 'cli' }, 100000, '2026-11-19T09:00:00Z');
  rollout(home, 'app-new', { id: 'app-new', source: 'vscode' }, 412000, '2026-11-22T09:00:00Z');
  rollout(home, 'exec-new', { id: 'exec-new', source: 'exec' }, 5000, '2026-11-22T09:30:00Z');
  rollout(home, 'sub-new', { id: 'sub-new', source: { subagent: 'review' } }, 5000, '2026-11-22T09:40:00Z');
  rollout(home, 'named', { id: 'named', source: 'cli' }, 50000, '2026-11-18T09:00:00Z');
  fs.writeFileSync(path.join(home, 'session_index.jsonl'), jl([{ id: 'named', thread_name: 'deck work', updated_at: 'x' }]));
  const out = matchPanes([
    { pane: 'a', agent: 'codex', cwd: '/w', title: 'myProjects' },
    { pane: 'b', agent: 'codex', cwd: '/w', title: '⠋ deck work | myProjects' },
  ], { env, projectsDir: tmp(), home });
  assert.deepEqual(out.map((x) => [x.pane, x.how, x.session?.sessionId]), [['a', 'folder', 'cli-old'], ['b', 'title', 'named']]);
});

test('CLI: match command', async () => {
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const dir = tmp();
  claudeLog(dir, '/w', 's1', { title: 'Fix login', tokens: 1000, ts: '2026-11-22T08:00:00Z' });
  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'herdr-context.js');
  const out = JSON.parse(execFileSync(process.execPath, [cli, 'match', '--json', '--dir', dir, '--panes', JSON.stringify([{ pane: 'p1', agent: 'claude', cwd: '/w', title: '✳ Fix login' }])], {
    env: { ...process.env, XDG_CACHE_HOME: tmp(), CODEX_HOME: tmp() },
  }).toString());
  assert.equal(out[0].session.sessionId, 's1');
  assert.equal(out[0].how, 'title');
});

test('Codex pane started in a parent folder: the project in its title picks the sub-project', () => {
  const home = tmp();
  const env = { XDG_CACHE_HOME: tmp() };
  const d = path.join(home, 'sessions', '2026', '11', '20');
  fs.mkdirSync(d, { recursive: true });
  const put = (name, cwd, ts) => {
    const u = { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 0, total_tokens: 1000 };
    const f = path.join(d, `rollout-${name}.jsonl`);
    fs.writeFileSync(f, jl([
      { timestamp: ts, type: 'session_meta', payload: { id: name, cwd, source: 'cli' } },
      { timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: u, last_token_usage: u, model_context_window: 475000 } } },
    ]));
    fs.utimesSync(f, new Date(ts), new Date(ts));
  };
  put('workbench', 'C:\\P\\myProjects\\dsh-agent-workbench', '2026-11-19T17:43:00Z');
  put('worktree', 'C:\\P\\myProjects\\wt-m4c', '2026-11-22T09:00:00Z');
  const run = (title) => matchPanes([{ pane: 'x', agent: 'codex', cwd: 'C:\\P\\myProjects', title }], { env, projectsDir: tmp(), home })[0];
  assert.equal(run('⠋ dsh-agent-workbench').session.sessionId, 'workbench');
  assert.equal(run('deck work | dsh-agent-workbench').session.sessionId, 'workbench');
  assert.equal(run('Codex').session.sessionId, 'worktree', 'no project in the title: newest');
});

test('codexTitleProject reads the last part, cut names as prefixes', async () => {
  const { codexTitleProject, inProject } = await import('../src/match.js');
  assert.deepEqual(codexTitleProject('⠙ fix login | api'), { name: 'api', prefix: false });
  assert.deepEqual(codexTitleProject('a-very-long-project-name…'), { name: 'a-very-long-project-name', prefix: true });
  assert.equal(codexTitleProject('codex'), null);
  assert.ok(inProject('/w/a-very-long-project-name-2/src', { name: 'a-very-long-project-name', prefix: true }));
  assert.ok(!inProject('/w/other', { name: 'api', prefix: false }));
});

test("Codex state database: the pane's thread name, else the project's own folder over a worktree inside it", async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const home = tmp();
  const env = { XDG_CACHE_HOME: tmp() };
  const d = path.join(home, 'sessions', '2026', '11', '11');
  fs.mkdirSync(d, { recursive: true });
  const log = (name, ts) => {
    const u = { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 0, total_tokens: 1000 };
    const f = path.join(d, `rollout-${name}.jsonl`);
    fs.writeFileSync(f, jl([
      { timestamp: ts, type: 'session_meta', payload: { id: name, cwd: '/x', source: 'cli' } },
      { timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: u, last_token_usage: u, model_context_window: 475000 } } },
    ]));
    fs.utimesSync(f, new Date(ts), new Date(ts));
    return f;
  };
  const db = new DatabaseSync(path.join(home, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, source TEXT, name TEXT, agent_role TEXT, updated_at INTEGER)');
  const add = db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?)');
  const W = 'C:\\P\\myProjects\\dsh-agent-workbench';
  add.run('workbench', log('workbench', '2026-11-19T17:43:00Z'), W, 'cli', 'DSH插件优化-Fable设计方案', null, 1);
  add.run('other', log('other', '2026-11-20T10:00:00Z'), W, 'cli', null, null, 2);
  add.run('worktree', log('worktree', '2026-11-22T09:00:00Z'), W + '\\wt-m4c', 'cli', null, null, 3);
  add.run('app', log('app', '2026-11-22T10:00:00Z'), W, 'vscode', null, null, 4);
  add.run('sub', log('sub', '2026-11-22T11:00:00Z'), W, '{"subagent":"review"}', null, 'reviewer', 5);
  db.close();
  const run = (title) => matchPanes([{ pane: 'x', agent: 'codex', cwd: 'C:\\P\\myProjects', title }], { env, projectsDir: tmp(), home })[0];
  const named = run('DSH插件优化-Fable设计方案 | dsh-agent-workbench');
  assert.deepEqual([named.how, named.session.sessionId], ['title', 'workbench']);
  assert.equal(run('⠋ Something else | dsh-agent-workbench').session.sessionId, 'other', 'project root, newest; not the worktree');
  assert.equal(run('⠋ wt-m4c').session.sessionId, 'worktree');
  const { codexTitleThread } = await import('../src/match.js');
  assert.deepEqual(codexTitleThread('⠋ a long thread name cut ... | proj'), { name: 'a long thread name cut', prefix: true });
  assert.equal(codexTitleThread('⠋ proj'), null);
});

test('Codex database with Windows verbatim paths (\\\\?\\C:\\...) still matches; logs fill in what it lacks', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { norm } = await import('../src/match.js');
  assert.equal(norm('\\\\?\\C:\\tempDisk\\P'), 'c:/tempdisk/p');
  assert.equal(norm('\\\\?\\UNC\\host\\share'), '//host/share');
  const home = tmp();
  const env = { XDG_CACHE_HOME: tmp() };
  const d = path.join(home, 'sessions', '2026', '11', '19');
  fs.mkdirSync(d, { recursive: true });
  const log = (name, cwd, ts) => {
    const u = { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 0, total_tokens: 1000 };
    const f = path.join(d, `rollout-${name}.jsonl`);
    fs.writeFileSync(f, jl([
      { timestamp: ts, type: 'session_meta', payload: { id: name, cwd, source: 'cli' } },
      { timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: u, last_token_usage: u, model_context_window: 475000 } } },
    ]));
    fs.utimesSync(f, new Date(ts), new Date(ts));
    return f;
  };
  const db = new DatabaseSync(path.join(home, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT, rollout_path TEXT, cwd TEXT, source TEXT, name TEXT, updated_at INTEGER)');
  db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)').run('a', log('a', '/p/proj', '2026-11-19T10:00:00Z'), '\\\\?\\/p/proj', 'cli', 'Named one', 1);
  db.close();
  log('b', '/p/proj', '2026-11-19T11:00:00Z'); // only in the logs
  const run = (title) => matchPanes([{ pane: 'x', agent: 'codex', cwd: '/p', title }], { env, projectsDir: tmp(), home })[0];
  const r = run('Named one | proj');
  assert.deepEqual([r.how, r.session.sessionId], ['title', 'a']);
  assert.match(r.diag, /database 1 threads, 1 here · logs 2 scanned, 2 here/);
  assert.equal(run('⠋ proj').session.sessionId, 'b', 'newest, found through the logs');
});
