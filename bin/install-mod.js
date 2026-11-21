#!/usr/bin/env node
// Installs the Herdr app mod:
//   <appHome>/mods/herdr-context/        main.js, logic.js, mod.json
//   <appHome>/mods/herdr-context/cli/    a copy of this CLI (bin/, src/, package.json)
//   <appHome>/mods/herdr-context/config.json   { node, cli } so the mod can exec it
// appHome is $HERDR_APP_HOME or ~/.config/herdr-app (Herdr's own default).
//
//   node bin/install-mod.js              install or update
//   node bin/install-mod.js --uninstall  remove the mod folder
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appHome = process.env.HERDR_APP_HOME || path.join(os.homedir(), '.config', 'herdr-app');
const dest = path.join(appHome, 'mods', 'herdr-context');

if (!fs.existsSync(appHome)) {
  console.error(`Herdr app folder not found: ${appHome}\nStart the Herdr app once, or set HERDR_APP_HOME.`);
  process.exit(1);
}

if (process.argv.includes('--uninstall')) {
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

// 3. The mod files last: saving them is what makes Herdr (re)load the mod.
const modSrc = path.join(root, 'mod', 'herdr-context');
for (const f of fs.readdirSync(modSrc)) fs.copyFileSync(path.join(modSrc, f), path.join(dest, f));

const collector = path.join(cliDir, 'bin', 'claude-statusline-collector.js');
console.log(`installed herdr-context ${pkg.version} → ${dest}

Next:
  1. Check it:   herdr-app check "${dest}"
  2. Herdr docks the panel on the right the first time it sees the mod.
  3. Recommended, for context % and Claude limits, in ~/.claude/settings.json:
     "statusLine": { "type": "command", "command": "\\"${process.execPath.replace(/\\/g, '\\\\')}\\" \\"${collector.replace(/\\/g, '\\\\')}\\"" }
  Optional status-bar chip: add a block { "content": { "mod": "herdr-context", "props": { "view": "chip" } } }
  to a cloned layout (see README).`);
