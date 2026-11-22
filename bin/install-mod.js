#!/usr/bin/env node
// Installs the Herdr app mod:
//   <appHome>/mods/herdr-context/        main.js, logic.js, sample.js, mod.json
//   <appHome>/mods/herdr-context/cli/    a copy of this CLI (bin/, src/, package.json)
//   <appHome>/mods/herdr-context/config.json   { node, cli } so the mod can exec it
//   <appHome>/layouts/main-context.json  Herdr's "main" plus a Context panel in the
//                                        right sidebar and a chip in the status bar
// appHome is $HERDR_APP_HOME or ~/.config/herdr-app (Herdr's own default).
//
//   node bin/install-mod.js              install or update, then switch to main-context
//   node bin/install-mod.js --no-layout  don't write or switch the layout
//   node bin/install-mod.js --uninstall  remove the mod folder and the layout
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withContext, LAYOUT_NAME } from '../src/herdr-layout.js';
import { commandLine } from '../src/quota/common.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appHome = process.env.HERDR_APP_HOME || path.join(os.homedir(), '.config', 'herdr-app');
const dest = path.join(appHome, 'mods', 'herdr-context');
const layoutFile = path.join(appHome, 'layouts', `${LAYOUT_NAME}.json`);
const argv = process.argv.slice(2);

if (!fs.existsSync(appHome)) {
  console.error(`Herdr app folder not found: ${appHome}\nStart the Herdr app once, or set HERDR_APP_HOME.`);
  process.exit(1);
}

/** Runs `herdr-app do ...` if herdr-app is reachable; never fails the install. */
function herdrApp(args) {
  if (process.env.HERDR_CONTEXT_NO_SWITCH) return false;
  try {
    const c = commandLine('herdr-app', args);
    const r = spawnSync(c.file, c.args, { encoding: 'utf8', timeout: 15000, windowsVerbatimArguments: c.windowsVerbatimArguments });
    return r.status === 0;
  } catch {
    return false;
  }
}

if (argv.includes('--uninstall')) {
  if (fs.existsSync(layoutFile)) {
    herdrApp(['do', 'layout.switch', '--name', 'main']);
    fs.rmSync(layoutFile, { force: true });
    console.log(`removed ${layoutFile}`);
  }
  fs.rmSync(dest, { recursive: true, force: true });
  console.log(`removed ${dest}`);
  process.exit(0);
}

fs.mkdirSync(dest, { recursive: true });

// 1. The CLI first, so everything the mod needs exists before Herdr reloads it.
const cliDir = path.join(dest, 'cli');
fs.rmSync(cliDir, { recursive: true, force: true });
for (const d of ['bin', 'src']) fs.cpSync(path.join(root, d), path.join(cliDir, d), { recursive: true });
fs.copyFileSync(path.join(root, 'package.json'), path.join(cliDir, 'package.json'));

// 2. Where Node and the CLI are (absolute, so it works without PATH and on Windows).
const cli = path.join(cliDir, 'bin', 'herdr-context.js');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
fs.writeFileSync(path.join(dest, 'config.json'), JSON.stringify({ node: process.execPath, cli, version: pkg.version }, null, 2) + '\n');

// 3. The mod files: saving them is what makes Herdr (re)load the mod.
const modSrc = path.join(root, 'mod', 'herdr-context');
for (const f of fs.readdirSync(modSrc)) fs.copyFileSync(path.join(modSrc, f), path.join(dest, f));
console.log(`installed herdr-context ${pkg.version} → ${dest}`);

// 4. The layout, built from the Herdr version installed here.
let layoutNote;
if (argv.includes('--no-layout')) {
  layoutNote = 'layout: skipped (--no-layout)';
} else {
  const mainFile = path.join(appHome, 'layouts', 'main.json');
  try {
    const layout = withContext(JSON.parse(fs.readFileSync(mainFile, 'utf8')));
    fs.writeFileSync(layoutFile, JSON.stringify(layout, null, 2) + '\n');
    const switched = herdrApp(['do', 'layout.switch', '--name', LAYOUT_NAME]);
    layoutNote = `layout: wrote ${layoutFile}\n        ${switched ? 'switched to it' : `switch to it with ctrl-shift-l, or: herdr-app do layout.switch --name ${LAYOUT_NAME}`}`;
  } catch (e) {
    layoutNote = `layout: not written (${e.code === 'ENOENT' ? `${mainFile} not found; start Herdr once` : e.message})\n        open the panel as a pane instead: herdr-app do pane.split --direction right --mod herdr-context`;
  }
}

const collector = path.join(cliDir, 'bin', 'claude-statusline-collector.js');
console.log(`${layoutNote}

The status-bar chip on the right (ctx % · fullest subscription) opens and closes
the Context panel in the right sidebar, next to Files and Changes.

Check it:  herdr-app check "${dest}"
Optional (exact Claude window size and limits from Claude Code itself), in ~/.claude/settings.json:
  "statusLine": { "type": "command", "command": "\\"${process.execPath.replace(/\\/g, '\\\\')}\\" \\"${collector.replace(/\\/g, '\\\\')}\\"" }`);
