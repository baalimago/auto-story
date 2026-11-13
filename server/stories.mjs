// The shelf: each account sees only the books it made. Books are filed per account on the volume,
// in /data/stories/<hash of account>/<build id>.json, so a listing never reads anyone else's files.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';

export const storiesDir = () => join(config.dataDir, 'stories');
const accountDir = account => join(storiesDir(), createHash('sha256').update(String(account)).digest('hex').slice(0, 32));

function readJson(file) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } }

export function saveStory(account, story) {
  if (!account) throw new Error('A story needs an owning account');
  const dir = accountDir(account);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${story.id}.json`), JSON.stringify({ ...story, account }, null, 2));
}

// Books from before per-account shelves sit directly in /data/stories with only a username.
// The first time that user lists their shelf, file them under the account (copy, then delete).
function adoptLegacy(user) {
  let entries;
  try { entries = readdirSync(storiesDir()); } catch { return; }
  for (const name of entries.filter(f => f.endsWith('.json'))) {
    const file = join(storiesDir(), name);
    try { if (!statSync(file).isFile()) continue; } catch { continue; }
    const story = readJson(file);
    if (!story || story.account || String(story.user || '').toLowerCase() !== user.username.toLowerCase()) continue;
    saveStory(user.account, story);
    rmSync(file, { force: true });
  }
}

export function listStories(user, limit = 60) {
  adoptLegacy(user);
  const dir = accountDir(user.account);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith('.json'))
    .map(f => readJson(join(dir, f)))
    .filter(story => story && story.account === user.account)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, limit)
    .map(({ account, ...story }) => story);
}
