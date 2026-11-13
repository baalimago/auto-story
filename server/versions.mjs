// Version history for a book. Every build, tweak and rollback leaves a full snapshot of what made
// the deployed app, so the owner can see what changed and roll back without running any agent:
//   /data/builds/<book id>/versions/<nnnn>/
//     version.json   { n, kind: build|tweak|rollback, at, by, message, from, changed, repainted, url }
//     site/          the deployed static site, art included
//     work/          the mood board (brief.json, script.json), notes.md, check.json, reviews/
// The document itself (source/, digests/, workspace.json) never changes and stays in the book's archive.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { config } from './config.mjs';

export const ID_RE = /^[0-9]{8}-[a-z0-9]{6}$/;
export const bookDir = id => join(config.dataDir, 'builds', id);
export const versionsDir = id => join(bookDir(id), 'versions');
export const versionDir = (id, n) => join(versionsDir(id), String(n).padStart(4, '0'));

const WORK_FILES = ['brief.json', 'script.json', 'notes.md', 'check.json'];
const WORK_DIRS = ['reviews'];
const DOC_FILES = ['workspace.json', 'source.txt'];
const DOC_DIRS = ['source', 'digests'];

// fs.cpSync/copyFileSync fail with EACCES inside the WASIX guest.
export function copyFile(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, readFileSync(from));
}
export function copyDir(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.isDirectory()) copyDir(join(from, entry.name), join(to, entry.name));
    else if (entry.isFile()) copyFile(join(from, entry.name), join(to, entry.name));
  }
}
function copySome(from, to, files, dirs) {
  for (const f of files) if (existsSync(join(from, f))) copyFile(join(from, f), join(to, f));
  for (const d of dirs) if (existsSync(join(from, d))) copyDir(join(from, d), join(to, d));
}

export function readJson(file, fallback = null) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; } }

export function listVersions(id) {
  let names;
  try { names = readdirSync(versionsDir(id)); } catch { return []; }
  return names.filter(n => /^\d{4}$/.test(n)).sort()
    .map(n => readJson(join(versionsDir(id), n, 'version.json')))
    .filter(Boolean);
}

export function latestVersion(id) { return listVersions(id).at(-1) || null; }

// Snapshot a workspace as the next version.
export function saveVersion(id, workDir, info) {
  const n = (latestVersion(id)?.n || 0) + 1;
  const dir = versionDir(id, n);
  rmSync(dir, { recursive: true, force: true });
  copyDir(join(workDir, 'site'), join(dir, 'site'));
  mkdirSync(join(dir, 'work'), { recursive: true });
  copySome(workDir, join(dir, 'work'), WORK_FILES, WORK_DIRS);
  const version = { n, at: new Date().toISOString(), ...info };
  writeFileSync(join(dir, 'version.json'), JSON.stringify(version, null, 2));
  return version;
}

// Copy a version as a new version (rollback); returns the new version.
export function copyVersion(id, n, info) {
  const from = versionDir(id, n);
  if (!existsSync(join(from, 'version.json'))) throw Object.assign(new Error(`Version ${n} does not exist`), { status: 404 });
  const next = (latestVersion(id)?.n || 0) + 1;
  const dir = versionDir(id, next);
  rmSync(dir, { recursive: true, force: true });
  copyDir(join(from, 'site'), join(dir, 'site'));
  if (existsSync(join(from, 'work'))) copyDir(join(from, 'work'), join(dir, 'work'));
  const version = { n: next, at: new Date().toISOString(), ...info };
  writeFileSync(join(dir, 'version.json'), JSON.stringify(version, null, 2));
  return version;
}

// Books made before versions existed: their archive becomes version 1.
export function ensureFirstVersion(id, story) {
  if (latestVersion(id)) return true;
  const archive = bookDir(id);
  if (!existsSync(join(archive, 'site'))) return false;
  const dir = versionDir(id, 1);
  copyDir(join(archive, 'site'), join(dir, 'site'));
  mkdirSync(join(dir, 'work'), { recursive: true });
  copySome(archive, join(dir, 'work'), WORK_FILES, WORK_DIRS);
  writeFileSync(join(dir, 'version.json'), JSON.stringify({
    n: 1, kind: 'build', at: story?.createdAt || new Date().toISOString(), by: story?.user || null,
    message: 'First edition', url: story?.url || null,
  }, null, 2));
  return true;
}

// Rebuild a workspace from a version: the document from the book's archive, then the version's files.
export function restoreVersion(id, n, workDir) {
  const dir = versionDir(id, n);
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  copySome(bookDir(id), workDir, DOC_FILES, DOC_DIRS);
  for (const d of ['inputs', 'reviews', 'digests']) mkdirSync(join(workDir, d), { recursive: true });
  if (existsSync(join(dir, 'work'))) copyDir(join(dir, 'work'), workDir);
  copyDir(join(dir, 'site'), join(workDir, 'site'));
}

export const versionFile = (id, n, rel) => join(versionDir(id, n), rel);
