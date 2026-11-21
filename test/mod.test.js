// The Herdr mod: pure logic, the installer, and main.js itself run against
// stand-ins for Herdr's modules ("gpui-kit", "gpui-base", "herdr") whose
// exec() really runs the installed CLI. The stand-ins record what the mod
// draws; they do not check GPUI's API (that is `herdr-app check`'s job).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as logic from '../mod/herdr-context/logic.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'test', 'fixtures', 'claude');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hcm-'));

// ---------- logic ----------
test('normPath / pickSession: exact folder, Windows case, nearest folder, none', () => {
  assert.equal(logic.normPath('C:\\Users\\Tang\\Repo\\'), 'c:/users/tang/repo');
  assert.equal(logic.normPath('/home/a/B/'), '/home/a/B');
  assert.equal(logic.normPath('/'), '/');
  const s = [
    { sessionId: 'old', cwd: '/w/api', lastTs: '2026-11-20T10:00:00Z' },
    { sessionId: 'new', cwd: '/w/api', lastTs: '2026-11-21T10:00:00Z' },
    { sessionId: 'win', cwd: 'C:\\Users\\Tang\\web', lastTs: '2026-11-21T09:00:00Z' },
    { sessionId: 'parent', cwd: '/w/mono', lastTs: '2026-11-21T08:00:00Z' },
  ];
  assert.equal(logic.pickSession(s, '/w/api/').sessionId, 'new');
  assert.equal(logic.pickSession(s, 'c:/users/tang/WEB').sessionId, 'win');
  assert.equal(logic.pickSession(s, '/w/mono/packages/ui').sessionId, 'parent');
  assert.equal(logic.pickSession(s, '/elsewhere'), null);
  assert.equal(logic.pickSession(s, null), null);
  assert.equal(logic.pickSession(null, '/w/api'), null);
});

test('choosePane: focused terminal; panel focused → same tab terminal; layout block', () => {
  const panes = [
    { pane: 'p1', terminal: 't1', tab: 'A', cwd: '/w/api', app: null, focused: false },
    { pane: 'p2', terminal: 't2', tab: 'A', cwd: '/w/web', app: 'claude-code', focused: false },
    { pane: 'p3', terminal: null, mod: 'herdr-context', tab: 'A', focused: true },
    { pane: 'p4', terminal: 't4', tab: 'B', cwd: '/w/other', app: 'claude-code', focused: false },
  ];
  // the panel itself is focused: prefer the last terminal seen, else Claude's, never another tab
  assert.equal(logic.choosePane({ tab: 'A', pane: 'p3', terminal: null, cwd: null }, panes, 'p1').cwd, '/w/api');
  assert.equal(logic.choosePane({ tab: 'A', pane: 'p3', terminal: null, cwd: null }, panes, null).cwd, '/w/web');
  // a terminal is focused
  const focusedP1 = panes.map((p) => ({ ...p, focused: p.pane === 'p1' }));
  assert.deepEqual(logic.choosePane({ tab: 'A', pane: 'p1', terminal: 't1', cwd: '/w/api' }, focusedP1, null), { cwd: '/w/api', app: null, pane: 'p1' });
  // a layout terminal block: terminal set, no pane focused
  const none = panes.map((p) => ({ ...p, focused: false }));
  assert.equal(logic.choosePane({ tab: 'A', pane: null, terminal: 't9', cwd: '/w/block' }, none, null).cwd, '/w/block');
  // nothing at all
  assert.deepEqual(logic.choosePane(null, [], null), { cwd: null, app: null, pane: null });
});

test('formatting helpers', () => {
  assert.equal(logic.fmt(1234), '1.2k');
  assert.equal(logic.fmt(2_500_000), '2.50M');
  assert.equal(logic.fmt(null), '—');
  assert.equal(logic.pctText(0.456), '46%');
  assert.equal(logic.sparkline([1, 2, 3]), '▁▅█');
  assert.equal(logic.sparkline([]), '');
  const now = Date.parse('2026-11-21T12:00:00Z');
  assert.equal(logic.resetsIn('2026-11-21T14:05:00Z', now), 'in 2h 5m');
  assert.equal(logic.resetsIn('2026-11-24T15:00:00Z', now), 'in 3d 3h');
  assert.equal(logic.resetsIn('2026-11-21T11:00:00Z', now), 'now');
  assert.equal(logic.resetsIn(null, now), '');
  assert.equal(logic.ago(now - 5000, now), '5s ago');
  assert.equal(logic.ago(0, now), 'never');
  assert.deepEqual([50, 70, 95].map(logic.level), ['ok', 'warn', 'high']);
  assert.equal(logic.baseName('C:\\a\\b\\c.js'), 'c.js');
});

test('worstWindow / chipText / makeup', () => {
  const quota = { providers: [
    { provider: 'claude', status: 'ok', windows: [{ label: '5h', usedPercent: 37 }] },
    { provider: 'codex', status: 'stale', windows: [{ label: 'week', usedPercent: 81 }] },
    { provider: 'kiro', status: 'not_found', windows: [{ label: 'month', usedPercent: 99 }] },
  ] };
  assert.deepEqual(logic.worstWindow(quota), { provider: 'codex', window: { label: 'week', usedPercent: 81 } });
  assert.equal(logic.chipText({ context: { tokens: 1000, percent: 0.62 } }, quota), 'ctx 62% · codex week 81%');
  assert.equal(logic.chipText({ context: { tokens: 12345, percent: null } }, null), 'ctx 12k');
  assert.equal(logic.chipText(null, null), 'context');
  const m = logic.makeup({ composition: { total: 100, parts: [{ category: 'toolResult', tokens: 30 }, { category: 'systemPrompt', tokens: 70 }, { category: 'user', tokens: 0 }] } });
  assert.deepEqual(m.map((p) => [p.label, p.share]), [['system prompt', 0.7], ['tool results', 0.3]]);
  assert.deepEqual(logic.makeup(null), []);
});

// ---------- installer ----------
function install(appHome) {
  return spawnSync(process.execPath, [path.join(ROOT, 'bin', 'install-mod.js')], { env: { ...process.env, HERDR_APP_HOME: appHome }, encoding: 'utf8' });
}

test('installer: copies mod + CLI, writes config, bundled CLI runs; uninstall', () => {
  const appHome = tmp();
  const r = install(appHome);
  assert.equal(r.status, 0, r.stderr);
  const dest = path.join(appHome, 'mods', 'herdr-context');
  for (const f of ['main.js', 'logic.js', 'mod.json', 'config.json', 'cli/package.json', 'cli/bin/herdr-context.js', 'cli/src/claude/session.js']) {
    assert.ok(fs.existsSync(path.join(dest, f)), f);
  }
  const cfg = JSON.parse(fs.readFileSync(path.join(dest, 'config.json'), 'utf8'));
  assert.equal(cfg.node, process.execPath);
  assert.equal(cfg.cli, path.join(dest, 'cli', 'bin', 'herdr-context.js'));
  assert.match(execFileSync(cfg.node, [cfg.cli, '--help'], { encoding: 'utf8' }), /herdr-context quota/);
  assert.match(r.stdout, /herdr-app check/);
  assert.equal(install(appHome).status, 0, 'reinstall over an existing copy');
  const u = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'install-mod.js'), '--uninstall'], { env: { ...process.env, HERDR_APP_HOME: appHome }, encoding: 'utf8' });
  assert.equal(u.status, 0);
  assert.ok(!fs.existsSync(dest));
  const missing = install(path.join(appHome, 'nope'));
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /Herdr app folder not found/);
});

// ---------- main.js against stand-in modules ----------
const STUBS = {
  'gpui-kit': `
    function el(tag) {
      const node = { tag, text: [], kids: [], ids: [], tip: null, clickFn: null };
      const p = new Proxy(node, { get(t, k) {
        if (k in t) return t[k];
        if (k === 'then') return undefined;
        return (...a) => {
          if (k === 'child') (typeof a[0] === 'string' ? t.text : t.kids).push(a[0]);
          else if (k === 'children') t.kids.push(...a[0]);
          else if (k === 'id') t.ids.push(a[0]);
          else if (k === 'tooltip') t.tip = a[0];
          else if (k === 'when') return a[0] ? a[1](p) : p;
          else if (k === 'hover') a[0](p);
          else if (k === 'on_click') t.clickFn = a[0];
          return p;
        };
      } });
      return p;
    }
    export const div = () => el('div');
    export class View {}
    globalThis.__el = el;`,
  'gpui-base': `export const h_flex = () => globalThis.__el('h'); export const v_flex = () => globalThis.__el('v');`,
  'herdr': `
    const S = () => globalThis.__herdr;
    export const theme = () => new Proxy({}, { get: (_t, k) => '#' + String(k) });
    export const focused = () => S().focused;
    export const panes = () => S().panes;
    export const props = () => S().props;
    export const checking = () => S().checking;
    export const appHome = () => S().appHome;
    export const readTextFile = async (p) => { try { return (await import('node:fs')).readFileSync(p, 'utf8'); } catch { return null; } };
    export const exec = async (cmd, args, opts) => {
      S().execCalls.push([cmd, ...args]);
      const r = (await import('node:child_process')).spawnSync(cmd, args, { encoding: 'utf8', env: { ...process.env, ...S().env } });
      return { code: r.status, stdout: r.stdout, stderr: r.stderr };
    };`,
};

function stubWorld(appHome) {
  const dir = tmp();
  for (const [name, src] of Object.entries(STUBS)) {
    fs.mkdirSync(path.join(dir, 'node_modules', name), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', name, 'package.json'), JSON.stringify({ name, type: 'module', main: 'index.js' }));
    fs.writeFileSync(path.join(dir, 'node_modules', name, 'index.js'), src);
  }
  // the installed mod files, next to the stand-ins
  const modDir = path.join(appHome, 'mods', 'herdr-context');
  for (const f of fs.readdirSync(modDir).filter((f) => f.endsWith('.js'))) fs.copyFileSync(path.join(modDir, f), path.join(dir, f));
  return dir;
}

function texts(node, out = []) {
  if (!node) return out;
  out.push(...node.text);
  if (node.tip) out.push(node.tip);
  for (const k of node.kids) texts(k, out);
  return out;
}

function fakeCx() {
  const cx = { timers: [], notified: 0, pending: [] };
  cx.spawn = (fn) => { cx.pending.push(fn(cx)); };
  cx.timer = { every: (ms, fn) => cx.timers.push(ms) };
  cx.notify = () => { cx.notified++; };
  cx.settle = async () => { while (cx.pending.length) await cx.pending.shift(); };
  return cx;
}

test('mod main.js: fetches through the bundled CLI and draws panel and chip', async () => {
  const appHome = tmp();
  assert.equal(install(appHome).status, 0);
  // a Claude projects dir holding the basic fixture as a session in /p
  const projects = tmp();
  fs.mkdirSync(path.join(projects, '-p'));
  fs.copyFileSync(path.join(FIX, 'basic.jsonl'), path.join(projects, '-p', 's-basic.jsonl'));
  const cache = tmp();

  globalThis.__herdr = {
    appHome,
    checking: false,
    props: {},
    focused: { space: 's1', tab: 't1', pane: 'p1', terminal: 'tm1', cwd: '/p' },
    panes: [{ pane: 'p1', terminal: 'tm1', tab: 't1', focused: true, cwd: '/p', app: 'claude-code' }],
    execCalls: [],
    // keep the CLI away from the real machine: no real claude/codex/kiro, temp caches
    env: { CLAUDE_CONFIG_DIR: path.dirname(projects), XDG_CACHE_HOME: cache, CODEX_HOME: tmp(), PATH: path.dirname(process.execPath) },
  };
  // CLAUDE_CONFIG_DIR/projects must be the fixture dir
  fs.renameSync(projects, path.join(path.dirname(projects), 'projects-' + path.basename(projects)));
  const projDir = path.join(path.dirname(projects), 'projects-' + path.basename(projects));
  const cfgDir = tmp();
  fs.symlinkSync(projDir, path.join(cfgDir, 'projects'));
  globalThis.__herdr.env.CLAUDE_CONFIG_DIR = cfgDir;

  const world = stubWorld(appHome);
  const { default: Mod } = await import(pathToFileURL(path.join(world, 'main.js')).href);

  // `herdr-app check` mode: nothing runs
  globalThis.__herdr.checking = true;
  const idle = new Mod();
  const cx0 = fakeCx();
  idle.init({}, cx0);
  assert.equal(cx0.timers.length, 0);
  assert.equal(globalThis.__herdr.execCalls.length, 0);
  // ...but it draws the built-in sample, so the check renders every part
  const preview = texts(idle.render());
  for (const want of ['claude-sample · main', '61%', 'MAKEUP', 'src/app.js', 'kiro', 'quota-axi not installed']) {
    assert.ok(preview.some((s) => s.includes(want)), `preview shows ${want}`);
  }

  // live
  globalThis.__herdr.checking = false;
  const m = new Mod();
  const cx = fakeCx();
  m.init({}, cx);
  await cx.settle();
  assert.deepEqual(cx.timers, [15000, 120000]);
  const calls = globalThis.__herdr.execCalls.map((c) => c.slice(2).join(' '));
  assert.ok(calls.includes('--list --json --limit 8 --recent 48'), calls.join(' | '));
  assert.ok(calls.includes('quota --json'), calls.join(' | '));
  assert.equal(m.error, null);
  assert.equal(m.quotaError, null);
  assert.equal(m.sessions.length, 1);

  const panel = texts(m.render());
  const odd = panel.filter((s) => typeof s !== "string"); assert.deepEqual(odd, [], "non-text children: " + odd.map(String).join(","));
  for (const want of ['Context', 'THIS PANE', 'MAKEUP', 'FILES', 'b.js', 'SUBSCRIPTIONS', 'claude', 'codex', 'kiro']) {
    assert.ok(panel.some((s) => s.includes(want)), `panel shows ${want}: ${JSON.stringify(panel)}`);
  }
  assert.ok(panel.includes('1.3k'), 'context tokens (1305) without a window size');

  // another folder: explains instead of showing the wrong session
  globalThis.__herdr.focused = { cwd: '/elsewhere' };
  globalThis.__herdr.panes = [{ pane: 'p2', terminal: 'tm2', tab: 't1', focused: true, cwd: '/elsewhere', app: 'codex' }];
  assert.ok(texts(m.render()).includes('codex: context view supports Claude Code for now.'));

  // the panel itself focused (what clicking it does): still shows the tab's terminal
  globalThis.__herdr.focused = { tab: 't1', pane: 'pm', terminal: null, cwd: null };
  globalThis.__herdr.panes = [
    { pane: 'p1', terminal: 'tm1', tab: 't1', focused: false, cwd: '/p', app: 'claude-code' },
    { pane: 'pm', terminal: null, mod: 'herdr-context', tab: 't1', focused: true },
  ];
  assert.ok(texts(m.render()).includes('MAKEUP'), 'panel focus falls back to the terminal');

  // chip
  globalThis.__herdr.focused = { tab: 't1', pane: 'p1', terminal: 'tm1', cwd: '/p' };
  globalThis.__herdr.panes = [{ pane: 'p1', terminal: 'tm1', tab: 't1', focused: true, cwd: '/p', app: 'claude-code' }];
  globalThis.__herdr.props = { view: 'chip' };
  assert.ok(texts(m.render()).includes('ctx 1.3k'));

  // refresh button re-asks with --refresh
  globalThis.__herdr.props = {};
  const findClick = (n) => (n.ids.includes('hc-refresh') ? n.clickFn : n.kids.map(findClick).find(Boolean));
  globalThis.__herdr.execCalls = [];
  findClick(m.render())(null, cx);
  await cx.settle();
  assert.ok(globalThis.__herdr.execCalls.some((c) => c.includes('--refresh')));

  // missing config: a readable error, no crash
  fs.rmSync(path.join(appHome, 'mods', 'herdr-context', 'config.json'));
  const broken = new Mod();
  const cx2 = fakeCx();
  broken.init({}, cx2);
  await cx2.settle();
  assert.match(broken.error, /config\.json missing/);
  assert.ok(texts(broken.render()).some((s) => /config\.json missing/.test(s)));
});
