// The main-context layout built from Herdr's own main layout, and the
// installer writing it. test/fixtures/herdr/main.json is Herdr's shipped
// layouts/main.json (herdrdev/herdr-app defaults, Apache-2.0).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withContext, LAYOUT_NAME } from '../src/herdr-layout.js';
import { panelState, toggleCommands, findNode } from '../mod/herdr-context/logic.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'herdr', 'main.json'), 'utf8'));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hcl-'));

test('withContext: Context joins the right panel stack; chip beside the status bar', () => {
  const before = JSON.stringify(MAIN);
  const l = withContext(MAIN);
  assert.equal(JSON.stringify(MAIN), before, 'input not modified');

  const body = findNode(l, 'panel-body');
  assert.deepEqual(body.children.map((c) => c.id), ['files', 'changes', 'context']);
  assert.deepEqual(findNode(l, 'context').content, { mod: 'herdr-context' });
  assert.equal(findNode(l, 'panel').hidden, true, 'panel stays closed until asked');

  const status = findNode(l, 'status');
  assert.equal(status.type, 'row');
  assert.deepEqual(status.size, { px: 28 });
  assert.equal(status.content, undefined);
  assert.deepEqual(status.children.map((c) => c.id), ['status-main', 'status-context']);
  assert.deepEqual(status.children[0].content, { mod: 'workspace-status' });
  assert.equal(status.children[0].size, undefined);
  assert.deepEqual(status.children[1].content, { mod: 'herdr-context', props: { view: 'chip' } });

  // everything else is Herdr's, unchanged
  assert.deepEqual(findNode(l, 'sidebar'), findNode(MAIN, 'sidebar'));
  assert.deepEqual(findNode(l, 'main'), findNode(MAIN, 'main'));
  assert.equal(l.titlebar, MAIN.titlebar);
});

test('withContext: refuses a layout without the expected nodes', () => {
  assert.throws(() => withContext({ id: 'root', type: 'row', children: [] }), /panel-body/);
  const noStatus = JSON.parse(JSON.stringify(MAIN));
  findNode(noStatus, 'status').id = 'renamed';
  assert.throws(() => withContext(noStatus), /status/);
});

test('panelState / toggleCommands', () => {
  const l = withContext(MAIN);
  assert.deepEqual(panelState(MAIN), { inSidebar: false, open: false });
  assert.deepEqual(toggleCommands(panelState(MAIN)), []);
  assert.deepEqual(panelState(l), { inSidebar: true, open: false });
  assert.deepEqual(toggleCommands(panelState(l)), [['layout.select', { stack: 'panel-body', child: 'context' }], ['layout.show', { id: 'panel' }]]);
  findNode(l, 'panel').hidden = false;
  findNode(l, 'panel-body').active = 'context';
  assert.deepEqual(panelState(l), { inSidebar: true, open: true });
  assert.deepEqual(toggleCommands(panelState(l)), [['layout.hide', { id: 'panel' }]]);
  findNode(l, 'panel-body').active = 'files'; // Files is showing: the chip switches to Context
  assert.equal(panelState(l).open, false);
});

function install(appHome, ...args) {
  return spawnSync(process.execPath, [path.join(ROOT, 'bin', 'install-mod.js'), ...args], {
    env: { ...process.env, HERDR_APP_HOME: appHome, HERDR_CONTEXT_NO_SWITCH: '1' },
    encoding: 'utf8',
  });
}

test('installer writes main-context from the installed main layout; uninstall removes it', () => {
  const appHome = tmp();
  fs.mkdirSync(path.join(appHome, 'layouts'));
  fs.writeFileSync(path.join(appHome, 'layouts', 'main.json'), JSON.stringify(MAIN));
  const r = install(appHome);
  assert.equal(r.status, 0, r.stderr);
  const file = path.join(appHome, 'layouts', `${LAYOUT_NAME}.json`);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), withContext(MAIN));
  assert.match(r.stdout, /switch to it with ctrl-shift-l/);
  assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(path.join(appHome, 'layouts', 'main.json'), 'utf8'))), JSON.stringify(MAIN), "Herdr's main untouched");

  const u = install(appHome, '--uninstall');
  assert.equal(u.status, 0);
  assert.ok(!fs.existsSync(file));
  assert.ok(fs.existsSync(path.join(appHome, 'layouts', 'main.json')));
});

test('installer: no main layout yet, or --no-layout → mod installed, pane hint', () => {
  const a = tmp();
  const r = install(a);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /not written .*start Herdr once/);
  assert.match(r.stdout, /pane\.split/);
  assert.ok(fs.existsSync(path.join(a, 'mods', 'herdr-context', 'main.js')));

  const b = tmp();
  fs.mkdirSync(path.join(b, 'layouts'));
  fs.writeFileSync(path.join(b, 'layouts', 'main.json'), JSON.stringify(MAIN));
  const s = install(b, '--no-layout');
  assert.match(s.stdout, /skipped/);
  assert.ok(!fs.existsSync(path.join(b, 'layouts', `${LAYOUT_NAME}.json`)));
});
