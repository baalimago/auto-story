// One build: document -> parts -> brief (quizzed by an examiner) -> script (reviewed by a critic)
// -> Pi-built storybook -> painted character sheets and backdrops -> new Wasmer Edge app.
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';
import { redact } from './pi_run.mjs';
import { listFiles, zipDirectory } from './zip.mjs';
import { deployZip, waitLive } from './wasmer_api.mjs';
import { saveStory } from './stories.mjs';
import { prepareWorkspace, createContext, runStages, archiveWork, copyDir, missingPictures } from './stages.mjs';
import { saveVersion } from './versions.mjs';
import { checkImageKey } from './paint.mjs';

export const WORK_ROOT = process.env.WORK_ROOT || '/tmp/auto-story';
const MAX_ACTIVE = Number(process.env.MAX_ACTIVE_BUILDS || 2);
const jobs = new Map();

export const buildsDir = () => join(config.dataDir, 'builds');

export function activeBuilds() {
  return [...jobs.values()].filter(j => j.status === 'running').length;
}

export function getJob(id) { return jobs.get(id); }


export function slugify(text, max = 28) {
  return String(text).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '') || 'book';
}

export function startBuild({ user, title, filename, text, llm, images, wasmerToken, look }) {
  return startJob({ user, title, filename, llm, images, wasmerToken }, (job, ctx) => run(job, { user, title, filename, text, look, ...ctx }));
}

// A job is a build or a tweak: it streams events, can be aborted from any instance, and keeps its log
// in /data/builds/<job id>/. The secrets (model key, image key, Wasmer token) live only in memory.
export function startJob({ user, title, filename = '', llm = null, images = null, wasmerToken, extra = {} }, runner) {
  if (activeBuilds() >= MAX_ACTIVE) throw Object.assign(new Error('This instance is busy with other books; try again in a few minutes'), { status: 429 });
  const id = `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).slice(2, 8)}`;
  const wasmer = { token: wasmerToken, owner: config.storyOwner || user.username };
  const job = { id, user: user.username, account: user.account, title, filename, status: 'running', events: [], listeners: new Set(), startedAt: Date.now(), controller: new AbortController(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, images: 0, imageTokens: 0 }, ...extra };
  jobs.set(id, job);
  const archive = join(buildsDir(), id);
  mkdirSync(archive, { recursive: true });
  // Heartbeat on the shared volume, so any instance can tell a dead build from a quiet one.
  const beat = () => { try { writeFileSync(join(archive, 'alive'), String(Date.now())); } catch {} };
  beat();
  // The abort may arrive at another instance; it leaves a flag on the shared volume.
  let ticks = 0;
  const abortWatch = setInterval(() => {
    if (++ticks % 5 === 0) beat();
    if (job.controller.signal.aborted || !existsSync(join(archive, 'abort'))) return;
    try { job.abortedBy = JSON.parse(readFileSync(join(archive, 'abort'), 'utf8')).by; } catch {}
    job.controller.abort();
  }, 3000);
  const emit = event => {
    const full = { at: Date.now(), ...event, message: redact(event.message ?? '', [llm?.apiKey, images?.apiKey, wasmer.token]) };
    job.events.push(full);
    if (job.events.length > 2000) job.events.splice(0, job.events.length - 2000);
    try { appendFileSync(join(archive, 'events.ndjson'), JSON.stringify(full) + '\n'); } catch {}
    for (const listener of job.listeners) listener(full);
  };
  Promise.resolve().then(() => runner(job, { llm, images, wasmer, emit, archive }))
    .then(result => { job.status = 'done'; job.result = result; emit({ stage: 'done', kind: 'result', message: `Live at ${result.url}`, result }); })
    .catch(error => {
      job.status = 'failed';
      job.error = job.controller.signal.aborted ? `Aborted by ${job.abortedBy || 'its builder'}` : error.message;
      emit({ stage: 'failed', level: 'error', message: job.error, usage: { ...job.usage } });
    })
    .finally(() => {
      clearInterval(abortWatch);
      if (llm) llm.apiKey = null;
      wasmer.token = null;
      if (images) images.apiKey = null;
      for (const listener of job.listeners) listener(null);
      job.listeners.clear();
      setTimeout(() => jobs.delete(id), 60 * 60 * 1000);
    });
  return job;
}

// Pack a site and deploy it as appName (a new app, or a new version of the same app), then wait for it.
// Refuses to publish a book whose pages point at pictures that are not in the package.
export async function deploySite({ siteDir, appName, owner, token, emit, signal, artMode = 'painted' }) {
  const missing = await missingPictures(siteDir, artMode);
  if (missing.length) throw new Error(`Not deploying: ${missing.length} picture${missing.length === 1 ? '' : 's'} the book shows ${missing.length === 1 ? 'is' : 'are'} missing (${missing.join(', ')})`);
  const files = listFiles(siteDir);
  const zip = zipDirectory(siteDir, files);
  emit({ stage: 'deploy', message: `Packed ${files.length} files` });
  const deployed = await deployZip({ zip, appName, owner, token, onEvent: emit, signal });
  emit({ stage: 'deploy', message: `Waiting for ${deployed.url} to answer` });
  const live = await waitLive(deployed.url, deployed.versionId);
  if (!live) emit({ stage: 'deploy', level: 'warn', message: 'The app is deployed but not answering yet; it may need another minute' });
  return deployed;
}

async function run(job, { user, title, filename, text, llm, images, wasmer, look, emit, archive }) {
  const workDir = join(WORK_ROOT, job.id);
  const doc = prepareWorkspace({ workDir, title, filename, text });
  copyDir(join(workDir, 'source'), join(archive, 'source'));
  const artMode = images ? 'painted' : 'svg';
  const siteDir = join(workDir, 'site');
  writeFileSync(join(archive, 'meta.json'), JSON.stringify({ id: job.id, user: user.username, account: user.account, title, filename, chars: text.length, parts: doc.parts.length, mode: doc.mode, startedAt: job.startedAt, api: llm.api, model: llm.model, baseUrl: llm.baseUrl, artMode, look: look.label, lookOptions: look }));
  emit({ stage: 'prepare', message: `Read ${doc.characters.toLocaleString('en')} characters from ${filename || 'your text'}${doc.truncated ? ' (trimmed)' : ''}, in ${doc.parts.length} part${doc.parts.length === 1 ? '' : 's'}` });

  const { owner } = wasmer;
  emit({ stage: 'prepare', message: `The finished book will be deployed under ${owner}` });
  emit({ stage: 'prepare', message: `Look: ${look.label}` });
  emit({ stage: 'prepare', message: images ? `Character sheets and backdrops will be painted with ${images.model}` : 'No image key: Pi will draw the characters and backdrops as SVG' });

  if (images) {
    const refused = await checkImageKey(images);
    if (refused) throw new Error(`The OpenAI key for paintings was refused: ${refused}. Fix the key and start again; nothing else was run.`);
  }

  const signal = job.controller.signal;
  const ctx = createContext({ workDir, archive, emit, signal, llm, images, look, usage: job.usage });
  const results = await runStages(ctx);
  const report = results.build, painted = results.paint;
  const pi = { final: report.final };
  const bookTitle = String(pi.final?.title || title).slice(0, 120);
  if (signal.aborted) throw new Error('Aborted');

  // App URLs are public on Wasmer Edge, so the suffix is random enough that a book can't be guessed.
  const appName = `story-${slugify(bookTitle, 22)}-${unguessable()}`;
  const deployed = await deploySite({ siteDir, appName, owner, token: wasmer.token, emit, signal, artMode });

  const story = {
    id: job.id, title: bookTitle, summary: pi.final?.summary || '', metaphor: pi.final?.metaphor || '',
    url: deployed.url, appName, owner, adminUrl: deployed.adminUrl || null, user: user.username,
    question: pi.final?.question || '', look: look.label, pages: report.pages, images: images ? painted.painted.length : report.images, artMode, model: llm.model,
    cover: report.cover && (!images || painted.painted.includes(report.cover)) ? `${deployed.url.replace(/\/$/, '')}/art/${report.cover}.${images ? 'webp' : 'svg'}` : null, createdAt: new Date().toISOString(),
    minutes: Math.round((Date.now() - job.startedAt) / 6000) / 10,
    usage: { ...job.usage, tokens: job.usage.input + job.usage.output + job.usage.cacheRead + job.usage.cacheWrite, cost: Math.round(job.usage.cost * 10000) / 10000 },
  };
  archiveWork(workDir, archive);
  saveVersion(job.id, workDir, { kind: 'build', by: user.username, message: 'First edition', url: deployed.url, usage: story.usage });
  story.version = 1;
  saveStory(user.account, story);
  rmSync(workDir, { recursive: true, force: true });
  return story;
}

function unguessable(length = 10) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return [...randomBytes(length)].map(b => alphabet[b % alphabet.length]).join('');
}


// Who started a build: from memory, or from the archive when it ran on another instance.
function buildAccount(id) {
  const job = jobs.get(id);
  if (job) return job.account;
  try { return JSON.parse(readFileSync(join(buildsDir(), id, 'meta.json'), 'utf8')).account || null; }
  catch { return null; }
}

// Only the builder who started a build may abort it. Works across instances via the volume flag.
export function abortBuild(id, user) {
  const username = user.username;
  if (!/^[0-9]{8}-[a-z0-9]{6}$/.test(id)) throw Object.assign(new Error('Unknown build'), { status: 404 });
  const archive = join(buildsDir(), id);
  const job = jobs.get(id);
  const owner = buildAccount(id);
  if (!owner) throw Object.assign(new Error('Unknown build'), { status: 404 });
  if (owner !== user.account) throw Object.assign(new Error('Only the person who started this build can abort it'), { status: 403 });
  writeFileSync(join(archive, 'abort'), JSON.stringify({ by: username, at: new Date().toISOString() }));
  if (job && job.status === 'running') { job.abortedBy = username; job.controller.abort(); }
  else if (!job) {
    const state = archiveState(id);
    if (state && !state.terminal && state.stale) markEnded(id, `Aborted by ${username}; the instance running it had already stopped`);
  }
  return { ok: true, local: Boolean(job) };
}

// Events for a build that may be running on another instance: read the archived log.
const STALE_MS = 2 * 60 * 1000;

function readEvents(id) {
  return readFileSync(join(buildsDir(), id, 'events.ndjson'), 'utf8').split('\n').filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
}

// A build with no final event and no heartbeat for STALE_MS died with its instance (redeploy, OOM, lifetime).
export function archiveState(id) {
  let events, meta = {};
  try { events = readEvents(id); } catch { return null; }
  try { meta = JSON.parse(readFileSync(join(buildsDir(), id, 'meta.json'), 'utf8')); } catch {}
  const terminal = events.some(e => e.stage === 'done' || e.stage === 'failed');
  let alive = 0;
  try { alive = Number(readFileSync(join(buildsDir(), id, 'alive'), 'utf8')) || 0; } catch {}
  const last = Math.max(alive, events.at(-1)?.at || 0, meta.startedAt || 0);
  return { events, meta, terminal, stale: !terminal && Date.now() - last > STALE_MS };
}

function markEnded(id, message) {
  const event = { at: Date.now(), stage: 'failed', level: 'error', message };
  appendFileSync(join(buildsDir(), id, 'events.ndjson'), JSON.stringify(event) + '\n');
  return event;
}

// Events for a build that may be running on another instance, or no longer at all.
// Build logs are as private as the books: only the account that started a build can read them.
export function canFollow(id, user) {
  return /^[0-9]{8}-[a-z0-9]{6}$/.test(id) && Boolean(user?.account) && buildAccount(id) === user.account;
}

export function archivedEvents(id) {
  if (!/^[0-9]{8}-[a-z0-9]{6}$/.test(id)) return null;
  const state = archiveState(id);
  if (!state) return null;
  const { events, meta } = state;
  if (state.stale) events.push(markEnded(id, 'Interrupted: the instance running this build stopped (for example a redeploy). Start it again.'));
  const ended = state.terminal || state.stale;
  return [{ stage: 'job', id, title: meta.title || 'your book', status: ended ? 'ended' : 'running' }, ...events];
}
