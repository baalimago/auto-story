// The owner's edit view: a book's mood board (brief, characters, plot, scenes), tweaks and rollbacks.
//
// A tweak restores the latest version into a fresh workspace, applies the owner's edits to brief.json
// and script.json, re-runs the pipeline from the earliest stage those edits affect (with the owner's
// message as INPUT.owner_notes), repaints only the pictures whose plan changed, and redeploys the same
// app, so the book keeps its URL. Every result is a new version; a rollback redeploys an old one.
import { existsSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startJob, deploySite, archiveState, WORK_ROOT } from './build.mjs';
import { createContext, runStages, runStage, runCheck, STAGES } from './stages.mjs';
import { getStory, updateStory } from './stories.mjs';
import { parseLook, LOOKS } from './looks.mjs';
import {
  bookDir, ensureFirstVersion, latestVersion, listVersions, restoreVersion, saveVersion, copyVersion, versionDir, readJson,
} from './versions.mjs';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const MAX_MESSAGE = 4000;
export const TWEAK_FROM = ['understand', 'script', 'build'];

function ownedStory(user, id) {
  const story = getStory(user.account, id);
  if (!story) throw fail('Unknown book', 404);
  return story;
}

// The look a book was made with. Books from before lookOptions was stored are parsed from their label.
function bookLook(id, story) {
  const meta = readJson(join(bookDir(id), 'meta.json'), {});
  if (meta.lookOptions?.style) return parseLook(meta.lookOptions);
  const label = String(story.look || meta.look || '');
  const style = Object.keys(LOOKS).find(k => label.startsWith(LOOKS[k].label)) || 'picturebook';
  const year = Number(label.match(/\b(1[89]\d\d|20\d\d)\b/)?.[1]) || undefined;
  return parseLook({ style, year, color: /black & white/.test(label) ? 'bw' : 'color' });
}

// One tweak or rollback at a time per book, across instances: a lock file naming the running job.
const lockFile = id => join(bookDir(id), 'tweak.lock');
function runningJob(id) {
  const lock = readJson(lockFile(id));
  if (!lock?.job) return null;
  const state = archiveState(lock.job);
  // A job that has not logged anything yet has no state; trust a fresh lock.
  if (!state && Date.now() - Date.parse(lock.at) < 2 * 60 * 1000) return lock.job;
  if (state && !state.terminal && !state.stale) return lock.job;
  try { unlinkSync(lockFile(id)); } catch {}
  return null;
}

export function getBoard(user, id) {
  const story = ownedStory(user, id);
  const hasArchive = ensureFirstVersion(id, story);
  const current = latestVersion(id);
  const work = current ? join(versionDir(id, current.n), 'work') : null;
  const site = current ? join(versionDir(id, current.n), 'site') : null;
  const brief = work && readJson(join(work, 'brief.json'));
  const script = work && readJson(join(work, 'script.json'));
  const plan = site && readJson(join(site, 'art', 'plan.json'));
  let art = [];
  try { art = readdirSync(join(site, 'art')).filter(f => /\.(webp|svg)$/.test(f)); } catch {}
  const editable = Boolean(brief && script);
  const { account, ...shown } = story;
  return {
    story: shown, version: current?.n || null, versions: listVersions(id).reverse(),
    brief, script, plan, art, editable, canRollback: hasArchive,
    reason: !hasArchive ? 'This book has no archive on this server, so it cannot be changed here.'
      : !editable ? 'This book was made before mood boards existed. You can roll back versions, but to tweak it, make it again.' : null,
    running: runningJob(id),
  };
}

// Which pictures a new plan needs repainted, compared with the plan of the version it came from.
export function planChanges(oldPlan, newPlan, oldSides = {}, newSides = {}) {
  const sheets = new Set(), images = new Set();
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const chars = p => Array.isArray(p?.characters) ? p.characters : [];
  if (!oldPlan || oldPlan.style !== newPlan.style || !same(typeof oldPlan.characters, typeof newPlan.characters) ||
      (typeof newPlan.characters === 'string' && oldPlan.characters !== newPlan.characters)) {
    chars(newPlan).forEach(c => sheets.add(c.id));
    (newPlan.images || []).forEach(i => images.add(i.id));
    return { sheets, images, all: true };
  }
  for (const c of chars(newPlan)) {
    const before = chars(oldPlan).find(o => o.id === c.id);
    if (!before || before.look !== c.look || before.name !== c.name) sheets.add(c.id);
  }
  for (const image of newPlan.images || []) {
    const before = (oldPlan.images || []).find(o => o.id === image.id);
    if (!before || before.prompt !== image.prompt || !same(before.characters, image.characters) ||
        !same(oldSides[image.id], newSides[image.id]) || (image.characters || []).some(c => sheets.has(c))) images.add(image.id);
  }
  return { sheets, images, all: false };
}

// Fill in pictures the site lacks (new ids, or a paint that failed last time).
function missingArt(siteDir, plan, sets) {
  const has = f => existsSync(join(siteDir, 'art', f));
  for (const c of Array.isArray(plan.characters) ? plan.characters : []) if (!has(`char-${c.id}.webp`)) sets.sheets.add(c.id);
  for (const i of plan.images || []) if (!has(`${i.id}.webp`)) sets.images.add(i.id);
}

function validJsonObject(value, name) {
  if (value === undefined || value === null) return null;
  const parsed = typeof value === 'string' ? (() => { try { return JSON.parse(value); } catch { throw fail(`${name} is not valid JSON`); } })() : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw fail(`${name} must be a JSON object`);
  if (JSON.stringify(parsed).length > 400000) throw fail(`${name} is too large`);
  return parsed;
}

// Parse and check the owner's request before any job starts, so mistakes come back as plain errors.
export function parseTweak(body, board) {
  const message = String(body.message || '').replace(/\u0000/g, '').trim().slice(0, MAX_MESSAGE);
  const brief = validJsonObject(body.brief, 'brief.json');
  const script = validJsonObject(body.script, 'script.json');
  const briefChanged = brief && JSON.stringify(brief) !== JSON.stringify(board.brief);
  const scriptChanged = script && JSON.stringify(script) !== JSON.stringify(board.script);
  const repaint = [...new Set((Array.isArray(body.repaint) ? body.repaint : []).map(String))].filter(r => /^[a-z0-9-]{1,40}$/.test(r)).slice(0, 40);
  // The earliest stage the change touches: edits to the brief rewrite the script; edits to the script rebuild the book.
  const earliest = briefChanged ? 'script' : scriptChanged ? 'build' : message ? 'build' : null;
  let from = TWEAK_FROM.includes(body.from) ? body.from : earliest;
  if (from && earliest && TWEAK_FROM.indexOf(earliest) < TWEAK_FROM.indexOf(from)) from = earliest;
  if (from === 'understand' && briefChanged) from = 'script'; // re-reading the document would overwrite the owner's brief
  if (!from && !repaint.length) throw fail('Nothing to change: write what you want, edit the board, or pick pictures to repaint');
  return { message, brief: briefChanged ? brief : null, script: scriptChanged ? script : null, repaint, from };
}

function ownerNotes(id, tweak) {
  const earlier = listVersions(id).filter(v => v.kind === 'tweak' && v.message).map(v => v.message);
  const parts = [];
  if (earlier.length) parts.push(`Earlier requests from the owner, already applied to this book (keep them):\n${earlier.map((m, i) => `${i + 1}. ${m}`).join('\n')}`);
  if (tweak.message) parts.push(`The owner's request now:\n${tweak.message}`);
  const edited = [tweak.brief && 'brief.json', tweak.script && 'script.json'].filter(Boolean);
  if (edited.length) parts.push(`The owner edited ${edited.join(' and ')} by hand. Treat their edits as decisions: keep them, and carry them through everything that depends on them.`);
  if (tweak.from === 'script') parts.push('script.json already holds the current script. Change what the request and the edited brief need, and keep the rest.');
  if (tweak.from === 'understand') parts.push('brief.json already holds the current brief. Re-read the document and improve it where the request asks.');
  return parts.join('\n\n');
}

function lockAndStart(user, id, job) {
  writeFileSync(lockFile(id), JSON.stringify({ job: job.id, by: user.username, at: new Date().toISOString() }));
  return job;
}

function writeMeta(archive, job, user, story, extra) {
  writeFileSync(join(archive, 'meta.json'), JSON.stringify({
    id: job.id, kind: extra.kind, book: story.id, user: user.username, account: user.account, title: story.title, startedAt: job.startedAt, ...extra,
  }));
}

export function startTweak({ user, wasmerToken, id, body, llm, images }) {
  const board = getBoard(user, id);
  if (!board.editable) throw fail(board.reason, 409);
  if (board.running) throw fail('This book is already being changed; wait for that to finish', 409);
  const tweak = parseTweak(body, board);
  if (tweak.from && !llm) throw fail('Add your model settings to change the book');
  const story = getStory(user.account, id);
  const base = board.version;
  const job = startJob({ user, title: story.title, llm, images, wasmerToken, extra: { book: id, kind: 'tweak' } }, async (job, { llm, images, emit, archive, wasmer }) => {
    try {
      writeMeta(archive, job, user, story, { kind: 'tweak', base, from: tweak.from, message: tweak.message, api: llm?.api, model: llm?.model });
      return await runTweak({ job, user, story, base, tweak, llm, images, emit, archive, token: wasmer.token });
    } finally { try { unlinkSync(lockFile(id)); } catch {} }
  });
  return lockAndStart(user, id, job);
}

async function runTweak({ job, user, story, base, tweak, llm, images, emit, archive, token }) {
  const id = story.id;
  const workDir = join(WORK_ROOT, job.id);
  const signal = job.controller.signal;
  restoreVersion(id, base, workDir);
  const siteDir = join(workDir, 'site');
  const oldPlan = readJson(join(siteDir, 'art', 'plan.json'));
  const oldSides = readJson(join(workDir, 'check.json'), {})?.sides || {};
  if (tweak.brief) writeFileSync(join(workDir, 'brief.json'), JSON.stringify(tweak.brief, null, 2));
  if (tweak.script) writeFileSync(join(workDir, 'script.json'), JSON.stringify(tweak.script, null, 2));
  const edited = [tweak.brief && 'the concept summary', tweak.script && 'the script'].filter(Boolean);
  emit({ stage: 'prepare', message: `Starting from version ${base}${edited.length ? `, with your edits to ${edited.join(' and ')}` : ''}` });
  if (tweak.message) emit({ stage: 'prepare', message: `Your request: ${tweak.message}` });

  const look = bookLook(id, story);
  const ctx = createContext({ workDir, logDir: archive, emit, signal, llm, images, look, usage: job.usage, notes: ownerNotes(id, tweak) });
  ctx.artMode = story.artMode === 'svg' ? 'svg' : 'painted';
  let report = readJson(join(workDir, 'check.json'), {});
  if (tweak.from) {
    emit({ stage: 'prepare', message: `Re-running ${STAGES.slice(STAGES.indexOf(tweak.from), STAGES.indexOf('build') + 1).join(' → ')}` });
    report = (await runStages(ctx, { from: tweak.from, to: 'build' })).build;
  } else {
    // Only repaints: the book itself is unchanged, but check it like any other version.
    const checked = await runCheck(siteDir, ctx.artMode, look);
    if (!checked.ok) throw new Error(`The book failed its checks: ${checked.errors.slice(0, 4).join('; ')}`);
    report = { ...checked, final: report.final };
  }
  if (signal.aborted) throw new Error('Aborted');

  let repainted = [];
  const newPlan = readJson(join(siteDir, 'art', 'plan.json'));
  if (ctx.artMode === 'painted' && newPlan) {
    const sets = planChanges(oldPlan, newPlan, oldSides, report.sides || {});
    missingArt(siteDir, newPlan, sets);
    const ids = new Set([...(newPlan.images || []).map(i => i.id)]);
    for (const r of tweak.repaint) {
      if (r.startsWith('char-')) sets.sheets.add(r.slice(5));
      else if (ids.has(r)) sets.images.add(r);
    }
    // A new model sheet changes how that character looks in every picture it is in.
    for (const image of newPlan.images || []) if ((image.characters || []).some(c => sets.sheets.has(c))) sets.images.add(image.id);
    const count = sets.sheets.size + sets.images.size;
    if (!count) emit({ stage: 'paint', message: 'No picture needs repainting' });
    else if (!images) emit({ stage: 'paint', level: 'warn', message: `${count} picture${count === 1 ? '' : 's'} changed or missing, but there is no OpenAI key for paintings; keeping the old ones` });
    else {
      emit({ stage: 'paint', message: `Repainting ${[...sets.sheets].map(c => `char-${c}`).concat([...sets.images]).join(', ')}` });
      ctx.only = sets;
      const painted = await runStage('paint', ctx);
      repainted = [...painted.sheets, ...painted.painted];
    }
  }
  if (signal.aborted) throw new Error('Aborted');

  const deployed = await deploySite({ siteDir, appName: story.appName, owner: story.owner, token, emit, signal, artMode: ctx.artMode });
  const changed = [tweak.brief && 'brief', tweak.script && 'script', tweak.from && 'book'].filter(Boolean);
  const usage = { ...job.usage, tokens: job.usage.input + job.usage.output + job.usage.cacheRead + job.usage.cacheWrite, cost: Math.round(job.usage.cost * 10000) / 10000 };
  const version = saveVersion(id, workDir, { kind: 'tweak', by: user.username, job: job.id, base, message: tweak.message, from: tweak.from, changed, repainted, url: deployed.url, usage });
  rmSync(workDir, { recursive: true, force: true });
  const final = report.final || {};
  const script = readJson(join(versionDir(id, version.n), 'work', 'script.json'), {});
  const updated = updateStory(user.account, id, {
    title: String(final.title || script.title || story.title).slice(0, 120), question: script.question || story.question,
    metaphor: typeof final.metaphor === 'string' ? final.metaphor : story.metaphor, summary: final.summary || story.summary,
    pages: report.pages || story.pages, version: version.n, updatedAt: version.at, url: deployed.url,
    cover: story.cover ? `${story.cover.split('?')[0]}?v=${version.n}` : story.cover,
  });
  return { ...updated, account: undefined, version: version.n, kind: 'tweak', usage };
}

export function startRollback({ user, wasmerToken, id, version }) {
  const board = getBoard(user, id);
  if (!board.canRollback) throw fail(board.reason, 409);
  if (board.running) throw fail('This book is already being changed; wait for that to finish', 409);
  const n = Number(version);
  if (!board.versions.some(v => v.n === n)) throw fail(`Version ${version} does not exist`, 404);
  if (n === board.version) throw fail(`Version ${n} is already live`);
  const story = getStory(user.account, id);
  const job = startJob({ user, title: story.title, wasmerToken, extra: { book: id, kind: 'rollback' } }, async (job, { emit, archive, wasmer }) => {
    try {
      writeMeta(archive, job, user, story, { kind: 'rollback', base: board.version, to: n });
      emit({ stage: 'prepare', message: `Rolling back to version ${n}` });
      const signal = job.controller.signal;
      const deployed = await deploySite({ siteDir: join(versionDir(id, n), 'site'), appName: story.appName, owner: story.owner, token: wasmer.token, emit, signal, artMode: story.artMode === 'svg' ? 'svg' : 'painted' });
      const old = listVersions(id).find(v => v.n === n);
      const saved = copyVersion(id, n, { kind: 'rollback', by: user.username, job: job.id, base: board.version, to: n, message: `Back to version ${n}${old?.message ? ` (${old.message.slice(0, 80)})` : ''}`, url: deployed.url });
      const script = readJson(join(versionDir(id, saved.n), 'work', 'script.json'), {});
      const updated = updateStory(user.account, id, {
        title: script.title || story.title, version: saved.n, updatedAt: saved.at, url: deployed.url,
        cover: story.cover ? `${story.cover.split('?')[0]}?v=${saved.n}` : story.cover,
      });
      return { ...updated, account: undefined, version: saved.n, kind: 'rollback', usage: job.usage };
    } finally { try { unlinkSync(lockFile(id)); } catch {} }
  });
  return lockAndStart(user, id, job);
}
