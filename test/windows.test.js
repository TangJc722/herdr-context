// Windows-specific behaviour, testable anywhere: commandLine() takes the
// platform, environment and file lookups as options.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandLine, npmShimTarget } from '../src/quota/common.js';
import { errorLine } from '../mod/herdr-context/logic.js';

// A real npm cmd-shim (what `npm i -g @anthropic-ai/claude-code` writes).
const NPM_SHIM = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*
`;

function world(files) {
  const set = new Map(Object.entries(files).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    platform: 'win32',
    env: { PATH: 'C:\\Windows\\System32;C:\\Users\\Tang\\AppData\\Roaming\\npm;C:\\Users\\Tang\\.local\\bin', PATHEXT: '.COM;.EXE;.BAT;.CMD', ComSpec: 'C:\\Windows\\system32\\cmd.exe' },
    exists: (p) => set.has(p.toLowerCase()),
    readFile: (p) => {
      if (!set.has(p.toLowerCase())) throw new Error('ENOENT');
      return set.get(p.toLowerCase());
    },
    node: 'C:\\Program Files\\nodejs\\node.exe',
  };
}

test('not Windows: unchanged', () => {
  assert.deepEqual(commandLine('claude', ['-p', '/usage'], { platform: 'linux' }), { file: 'claude', args: ['-p', '/usage'] });
});

test('Windows: npm .cmd shim runs its script with Node, args untouched', () => {
  const w = world({
    'C:\\Users\\Tang\\AppData\\Roaming\\npm\\claude.cmd': NPM_SHIM,
    'C:\\Users\\Tang\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js': '',
  });
  const settings = JSON.stringify({ disableAllHooks: true });
  const c = commandLine('claude', ['-p', '/usage', '--tools', '', '--settings', settings], w);
  assert.equal(c.file, 'C:\\Program Files\\nodejs\\node.exe');
  assert.deepEqual(c.args, ['C:\\Users\\Tang\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js', '-p', '/usage', '--tools', '', '--settings', settings]);
  assert.equal(c.windowsVerbatimArguments, undefined);
});

test('Windows: .exe found on PATH (native installer), in PATHEXT order', () => {
  const w = world({
    'C:\\Users\\Tang\\.local\\bin\\claude.exe': '',
    'C:\\Users\\Tang\\.local\\bin\\claude.cmd': NPM_SHIM, // .EXE comes first in PATHEXT
  });
  assert.deepEqual(commandLine('claude', ['-v'], w), { file: 'C:\\Users\\Tang\\.local\\bin\\claude.exe', args: ['-v'] });
});

test('Windows: other .cmd goes through cmd.exe with escaped arguments', () => {
  const w = world({ 'C:\\Users\\Tang\\.local\\bin\\kiro-cli.cmd': '@echo off\r\n"%~dp0\\kiro.exe" %*\r\n' });
  const c = commandLine('kiro-cli', ['chat', '--no-interactive', '/usage', 'a&b "q"'], w);
  assert.equal(c.file, 'C:\\Windows\\system32\\cmd.exe');
  assert.deepEqual(c.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(c.windowsVerbatimArguments, true);
  const line = c.args[3];
  assert.ok(line.startsWith('"') && line.endsWith('"'));
  assert.ok(line.includes('kiro-cli.cmd'));
  assert.ok(!/[^^]&/.test(line), 'every & is escaped');
  assert.ok(line.includes('^^^&'), '& double-escaped for a .cmd target');
});

test('Windows: not found → plain name (spawn reports ENOENT); shim without script → cmd.exe', () => {
  assert.deepEqual(commandLine('codex', ['app-server'], world({})), { file: 'codex', args: ['app-server'] });
  const w = world({ 'C:\\Users\\Tang\\AppData\\Roaming\\npm\\codex.cmd': NPM_SHIM.replace('@anthropic-ai\\\\claude-code\\\\cli.js', '@openai\\\\codex\\\\bin\\\\codex.js') });
  // the shim names a script that is missing on disk
  assert.equal(commandLine('codex', [], w).file, 'C:\\Windows\\system32\\cmd.exe');
});

test('npmShimTarget: current and older shim styles', () => {
  const read = (t) => () => t;
  assert.equal(npmShimTarget('C:\\npm\\codex.cmd', read('"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*')), 'C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js');
  assert.equal(npmShimTarget('C:\\npm\\x.cmd', read('node "%~dp0\\node_modules\\x\\cli.mjs" %*')), 'C:\\npm\\node_modules\\x\\cli.mjs');
  assert.equal(npmShimTarget('C:\\npm\\y.cmd', read('@echo off\r\n"%~dp0\\y.exe" %*')), null);
  assert.equal(npmShimTarget('C:\\npm\\z.cmd', () => { throw new Error('gone'); }), null);
});

test('errorLine: the message, not the source location Node prints first', () => {
  const nodeCrash = `file:///C:/Users/Tang/.config/herdr-app/mods/herdr-context/cli/src/claude/session.js:251
      topTools = shape.tools.slice(0, 8);
                             ^

TypeError: Cannot read properties of null (reading 'slice')
    at ClaudeSession.composition (file:///C:/x/session.js:251:30)`;
  assert.equal(errorLine(nodeCrash), "TypeError: Cannot read properties of null (reading 'slice')");
  assert.equal(errorLine('herdr-context: TypeError: boom\n'), 'herdr-context: TypeError: boom');
  assert.equal(errorLine('\n  something odd\n'), 'something odd');
  assert.equal(errorLine(''), '');
});
