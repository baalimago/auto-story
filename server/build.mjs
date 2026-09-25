// One build: document -> Pi-authored storybook -> painted backdrops -> new Wasmer Edge app.
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';
import { runPi, redact } from './pi_run.mjs';
import { terminateChild } from './terminate_child.mjs';
import { paintAll } from './paint.mjs';
import { listFiles, zipDirectory } from './zip.mjs';
import { deployZip, waitLive } from './wasmer_api.mjs';
import { LIMITS, ENGINE_FILES, ART_MODES, LOOK_INSTRUCTIONS } from '../agent/limits.mjs';

const WORK_ROOT = process.env.WORK_ROOT || '/tmp/auto-story';
const MAX_ACTIVE = Number(process.env.MAX_ACTIVE_BUILDS || 2);
const jobs = new Map();

export const buildsDir = () => join(config.dataDir, 'builds');
export const storiesDir = () => join(config.dataDir, 'stories');

export function activeBuilds() {
  return [...jobs.values()].filter(j => j.status === 'running').length;
}

export function getJob(id) { return jobs.get(id); }


// fs.cpSync/copyFileSync fail with EACCES inside the WASIX guest.
function copyFile(from, to) { writeFileSync(to, readFileSync(from)); }
function copyDir(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.isDirectory()) copyDir(join(from, entry.name), join(to, entry.name));
    else if (entry.isFile()) copyFile(join(from, entry.name), join(to, entry.name));
  }
}

export function slugify(text, max = 28) {
  return String(text).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '') || 'book';
}

function runCheck(siteDir, artMode, look) {
  return new Promise(resolve => {
    const child = spawn(config.nodeBin, [join(config.agentDir, 'check.mjs'), siteDir, '--art', artMode, '--theme', look.theme, '--color', look.color],
      { env: { PATH: '/bin:/usr/bin' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    const timer = setTimeout(() => { terminateChild(child); err += '\nValidator killed after 60s'; }, 60000);
    child.on('error', error => resolve({ ok: false, errors: [error.message] }));
    child.on('close', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(out)); } catch { resolve({ ok: false, errors: [`Validator crashed: ${(err || out).slice(-800)}`] }); }
    });
  });
}

export function renderInput({ title, filename, chars, truncated, workDir, artMode, look }) {
  const input = {
    document: { title, filename, characters: chars, truncated },
    paths: {
      workspace: workDir,
      document: join(workDir, 'source.txt'),
      notebook: join(workDir, 'notes.md'),
      site: join(workDir, 'site'),
      engine_readme: join(config.agentDir, 'ENGINE.md'),
      example: join(config.agentDir, 'example'),
    },
    commands: { check: `node ${join(config.agentDir, 'check.mjs')} site --art ${artMode} --theme ${look.theme} --color ${look.color}` },
    art: ART_MODES[artMode],
    look: { label: look.label, theme: look.theme, color: look.color, directive: look.directive, instructions: LOOK_INSTRUCTIONS },
    limits: LIMITS,
    audience: 'Curious adults who want the intuition first, told like a gentle children\'s picture book.',
  };
  return `INPUT\n${JSON.stringify(input, null, 2)}\n`;
}

export function startBuild({ user, title, filename, text, llm, images, wasmerToken, look }) {
  if (activeBuilds() >= MAX_ACTIVE) throw Object.assign(new Error('This instance is busy with other books; try again in a few minutes'), { status: 429 });
  const id = `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).slice(2, 8)}`;
  const wasmer = { token: wasmerToken, owner: config.storyOwner || user.username };
  const job = { id, user: user.username, title, filename, status: 'running', events: [], listeners: new Set(), startedAt: Date.now(), controller: new AbortController(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, images: 0, imageTokens: 0 } };
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
    const full = { at: Date.now(), ...event, message: redact(event.message ?? '', [llm.apiKey, images?.apiKey, wasmer.token]) };
    job.events.push(full);
    if (job.events.length > 2000) job.events.splice(0, job.events.length - 2000);
    try { appendFileSync(join(archive, 'events.ndjson'), JSON.stringify(full) + '\n'); } catch {}
    for (const listener of job.listeners) listener(full);
  };
  run(job, { user, title, filename, text, llm, images, wasmer, look }, emit, archive)
    .then(result => { job.status = 'done'; job.result = result; emit({ stage: 'done', kind: 'result', message: `Live at ${result.url}`, result }); })
    .catch(error => {
      job.status = 'failed';
      job.error = job.controller.signal.aborted ? `Aborted by ${job.abortedBy || 'its builder'}` : error.message;
      emit({ stage: 'failed', level: 'error', message: job.error, usage: { ...job.usage } });
    })
    .finally(() => {
      clearInterval(abortWatch);
      llm.apiKey = null;
      wasmer.token = null;
      if (images) images.apiKey = null;
      for (const listener of job.listeners) listener(null);
      job.listeners.clear();
      setTimeout(() => jobs.delete(id), 60 * 60 * 1000);
    });
  return job;
}

async function run(job, { user, title, filename, text, llm, images, wasmer, look }, emit, archive) {
  const artMode = images ? 'painted' : 'svg';
  const workDir = join(WORK_ROOT, job.id);
  const siteDir = join(workDir, 'site');
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(join(siteDir, 'art'), { recursive: true });
  copyDir(join(config.agentDir, 'template'), siteDir);
  const truncated = text.length > config.maxDocumentChars;
  const source = truncated ? text.slice(0, config.maxDocumentChars) : text;
  writeFileSync(join(workDir, 'source.txt'), source);
  writeFileSync(join(workDir, 'notes.md'), `# Notes for "${title}"\n\n`);
  const input = renderInput({ title, filename, chars: source.length, truncated, workDir, artMode, look });
  writeFileSync(join(workDir, 'input.txt'), input);
  writeFileSync(join(archive, 'meta.json'), JSON.stringify({ id: job.id, user: user.username, title, filename, chars: text.length, startedAt: job.startedAt, api: llm.api, model: llm.model, baseUrl: llm.baseUrl, artMode, look: look.label }));
  emit({ stage: 'prepare', message: `Read ${source.length.toLocaleString('en')} characters from ${filename || 'your text'}${truncated ? ' (trimmed)' : ''}` });

  const { owner } = wasmer;
  emit({ stage: 'prepare', message: `The finished book will be deployed under ${owner}` });
  emit({ stage: 'prepare', message: `Look: ${look.label}` });
  emit({ stage: 'prepare', message: images ? `Backdrops will be painted with ${images.model}` : 'No image key: Pi will draw the backdrops as SVG' });

  const signal = job.controller.signal;
  const stop = () => { if (signal.aborted) throw new Error('Aborted'); };
  const pi = await runPi({
    workDir, systemPath: join(config.agentDir, 'system.md'), inputPath: join(workDir, 'input.txt'),
    logPath: join(archive, 'pi.ndjson'), onEvent: emit, signal, llm, usage: job.usage,
  });
  archiveWork(workDir, archive);
  stop();
  if (!pi.ok) throw new Error(pi.timedOut ? 'Pi ran out of time' : 'Pi did not finish the book');

  for (const file of ENGINE_FILES.filter(f => f !== 'index.html')) copyFile(join(config.agentDir, 'template', file), join(siteDir, file));
  emit({ stage: 'check', message: 'Checking the book' });
  const report = await runCheck(siteDir, artMode, look);
  writeFileSync(join(archive, 'check.json'), JSON.stringify(report, null, 2));
  if (!report.ok) throw new Error(`The book failed its checks: ${report.errors.slice(0, 4).join('; ')}`);
  emit({ stage: 'check', message: `Book passes: ${report.pages} pages, ${report.images} backdrops${report.warnings.length ? `, ${report.warnings.length} warnings` : ''}` });

  const bookTitle = String(pi.final?.title || title).slice(0, 120);
  stop();
  const painted = images ? await paintAll(siteDir, images, look, emit, { signal, usage: job.usage }) : { painted: [], failed: [] };
  stop();
  if (images && !painted.painted.length) emit({ stage: 'paint', level: 'warn', message: 'No backdrops were painted; the book will use its watercolor fallbacks' });

  const files = listFiles(siteDir);
  const zip = zipDirectory(siteDir, files);
  emit({ stage: 'deploy', message: `Packed ${files.length} files` });
  const appName = `story-${slugify(bookTitle)}-${job.id.slice(-4)}`;
  const deployed = await deployZip({ zip, appName, owner, token: wasmer.token, onEvent: emit, signal });
  emit({ stage: 'deploy', message: `Waiting for ${deployed.url} to answer` });
  const live = await waitLive(deployed.url, deployed.versionId);
  if (!live) emit({ stage: 'deploy', level: 'warn', message: 'The app is deployed but not answering yet; it may need another minute' });

  const story = {
    id: job.id, title: bookTitle, summary: pi.final?.summary || '', metaphor: pi.final?.metaphor || '',
    url: deployed.url, appName, owner, adminUrl: deployed.adminUrl || null, user: user.username,
    question: pi.final?.question || '', look: look.label, pages: report.pages, images: images ? painted.painted.length : report.images, artMode, model: llm.model,
    cover: report.cover && (!images || painted.painted.includes(report.cover)) ? `${deployed.url.replace(/\/$/, '')}/art/${report.cover}.${images ? 'webp' : 'svg'}` : null, createdAt: new Date().toISOString(),
    minutes: Math.round((Date.now() - job.startedAt) / 6000) / 10,
    usage: { ...job.usage, tokens: job.usage.input + job.usage.output + job.usage.cacheRead + job.usage.cacheWrite, cost: Math.round(job.usage.cost * 10000) / 10000 },
  };
  mkdirSync(storiesDir(), { recursive: true });
  writeFileSync(join(storiesDir(), `${job.id}.json`), JSON.stringify(story, null, 2));
  archiveWork(workDir, archive);
  rmSync(workDir, { recursive: true, force: true });
  return story;
}

function archiveWork(workDir, archive) {
  try {
    if (existsSync(join(workDir, 'notes.md'))) copyFile(join(workDir, 'notes.md'), join(archive, 'notes.md'));
    if (existsSync(join(workDir, 'input.txt'))) copyFile(join(workDir, 'input.txt'), join(archive, 'input.txt'));
    copyDir(join(workDir, 'site'), join(archive, 'site'));
  } catch (error) { console.warn(`Archive failed: ${error.message}`); }
}

// Only the builder who started a build may abort it. Works across instances via the volume flag.
export function abortBuild(id, username) {
  if (!/^[0-9]{8}-[a-z0-9]{6}$/.test(id)) throw Object.assign(new Error('Unknown build'), { status: 404 });
  const archive = join(buildsDir(), id);
  const job = jobs.get(id);
  let owner = job?.user;
  if (!owner) {
    try { owner = JSON.parse(readFileSync(join(archive, 'meta.json'), 'utf8')).user; }
    catch { throw Object.assign(new Error('Unknown build'), { status: 404 }); }
  }
  if (owner !== username) throw Object.assign(new Error('Only the person who started this build can abort it'), { status: 403 });
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
function archiveState(id) {
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
export function archivedEvents(id) {
  if (!/^[0-9]{8}-[a-z0-9]{6}$/.test(id)) return null;
  const state = archiveState(id);
  if (!state) return null;
  const { events, meta } = state;
  if (state.stale) events.push(markEnded(id, 'Interrupted: the instance running this build stopped (for example a redeploy). Start it again.'));
  const ended = state.terminal || state.stale;
  return [{ stage: 'job', id, title: meta.title || 'your book', status: ended ? 'ended' : 'running' }, ...events];
}
