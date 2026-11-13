// Installs Pi into pi/node_modules, rewrites its regexes for QuickJS, and trims it to what runs,
// mirroring .wasmerignore. Wasmer's Git deploys run this as `npm run build` (see Anybuild).
//   node scripts/prepare-pi.mjs
import { execFileSync } from 'node:child_process';
import { readdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const pi = new URL('../pi/', import.meta.url).pathname;
const npm = (...args) => execFileSync('npm', args, { cwd: pi, stdio: 'inherit' });
npm('ci', '--ignore-scripts', '--no-bin-links', '--no-audit', '--no-fund');
npm('run', 'prepare:wasmer');

const keepOnly = (dir, keep) => {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) if (!keep.includes(name)) rmSync(join(dir, name), { recursive: true, force: true });
};
const modules = join(pi, 'node_modules');
keepOnly(modules, ['@earendil-works']);
const agent = join(modules, '@earendil-works', 'pi-coding-agent');
keepOnly(join(agent, 'node_modules'), ['@earendil-works']);
keepOnly(join(agent, 'node_modules', '@earendil-works'), ['chord']);
for (const dir of ['docs', 'examples']) rmSync(join(agent, dir), { recursive: true, force: true });
console.log('Pi is installed and trimmed in pi/node_modules');
