// The book's stages. Each one reads only files in the workspace and writes its own, so any stage
// can be re-run from its predecessor's files (for example after the owner edits script.json):
//
//   prepare     source.txt                    -> source/part-NN.txt, workspace.json
//   understand  source/ (+ digests/)          -> brief.json, reviews/brief-N.json   (analyst, examiner)
//   script      brief.json                    -> script.json, reviews/script-N.json (writer, critic)
//   build       script.json, brief.json       -> site/ incl. site/art/plan.json, check.json (builder)
//   paint       site/art/plan.json, check.json -> site/art/char-<id>.webp, site/art/<id>.webp
//
// Owner notes (free text) reach the authoring agents as INPUT.owner_notes.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';
import { runPi } from './pi_run.mjs';
import { terminateChild } from './terminate_child.mjs';
import { paintAll } from './paint.mjs';
import { splitParts, writeParts, groupParts } from './source.mjs';
import { LIMITS, PLAN_LIMITS, AUDIENCE, ENGINE_FILES, ART_MODES, LOOK_INSTRUCTIONS } from '../agent/limits.mjs';

export const STAGES = ['understand', 'script', 'build', 'paint'];

// fs.cpSync/copyFileSync fail with EACCES inside the WASIX guest.
export function copyFile(from, to) { writeFileSync(to, readFileSync(from)); }
export function copyDir(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.isDirectory()) copyDir(join(from, entry.name), join(to, entry.name));
    else if (entry.isFile()) copyFile(join(from, entry.name), join(to, entry.name));
  }
}

const readJson = file => JSON.parse(readFileSync(file, 'utf8'));

function runNode(script, args) {
  return new Promise(resolve => {
    const child = spawn(config.nodeBin, [join(config.agentDir, script), ...args],
      { env: { PATH: config.childPath }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    const timer = setTimeout(() => { terminateChild(child); err += '\nValidator killed after 60s'; }, 60000);
    child.on('error', error => resolve({ ok: false, errors: [error.message], warnings: [] }));
    child.on('close', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(out)); } catch { resolve({ ok: false, errors: [`Validator crashed: ${(err || out).slice(-800)}`], warnings: [] }); }
    });
  });
}

export const runCheck = (siteDir, artMode, look) => runNode('check.mjs', [siteDir, '--art', artMode, '--theme', look.theme, '--color', look.color]);
// Which pictures the book shows but the site lacks (art/<id>.webp or .svg). Run after painting and before every deploy.
export async function missingPictures(siteDir, artMode) {
  const report = await runNode('check.mjs', [siteDir, '--art', artMode, '--final']);
  if (Array.isArray(report.missingArt)) return report.missingArt;
  throw new Error(`Could not check the book's pictures: ${(report.errors || []).slice(0, 2).join('; ')}`);
}
const planCheckArgs = (workDir, stage, extra = []) => [workDir, '--stage', stage, ...extra];
const planCheckCommand = (workDir, stage, extra = []) => `node ${join(config.agentDir, 'check_plan.mjs')} ${planCheckArgs(workDir, stage, extra).join(' ')}`;
export const runPlanCheck = (workDir, stage, extra = []) => runNode('check_plan.mjs', planCheckArgs(workDir, stage, extra));

// Splits the document into parts and records what every stage needs to know about it in workspace.json.
export function prepareWorkspace({ workDir, title, filename, text }) {
  const siteDir = join(workDir, 'site');
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(join(siteDir, 'art'), { recursive: true });
  copyDir(join(config.agentDir, 'template'), siteDir);
  const truncated = text.length > config.maxDocumentChars;
  const source = truncated ? text.slice(0, config.maxDocumentChars) : text;
  writeFileSync(join(workDir, 'source.txt'), source);
  const parts = writeParts(join(workDir, 'source'), splitParts(source)).map(({ id, chars }) => ({ id, chars }));
  const mode = source.length > config.singlePassChars ? 'digest' : 'full';
  for (const dir of ['inputs', 'reviews', 'digests']) mkdirSync(join(workDir, dir), { recursive: true });
  writeFileSync(join(workDir, 'notes.md'), `# Notes for "${title}"\n\n`);
  const doc = { title, filename, characters: source.length, originalCharacters: text.length, truncated, mode, parts };
  writeFileSync(join(workDir, 'workspace.json'), JSON.stringify(doc, null, 2));
  return doc;
}

// What every agent is told about the document and the workspace. Paths are rebuilt from workDir,
// so a workspace restored from the archive into another directory still works.
function baseInput(workDir, doc) {
  return {
    document: { title: doc.title, filename: doc.filename, characters: doc.characters, truncated: doc.truncated, parts: doc.parts.length },
    audience: AUDIENCE,
    mode: doc.mode,
    parts: doc.parts.map(p => join(workDir, 'source', `${p.id}.txt`)),
    digests: doc.mode === 'digest' ? doc.parts.map(p => join(workDir, 'digests', `${p.id}.json`)) : [],
    paths: {
      workspace: workDir,
      notebook: join(workDir, 'notes.md'),
      brief: join(workDir, 'brief.json'),
      script: join(workDir, 'script.json'),
      site: join(workDir, 'site'),
      engine_readme: join(config.agentDir, 'ENGINE.md'),
      example: join(config.agentDir, 'example'),
      example_files: ['story.js', 'scenes.js'].map(f => join(config.agentDir, 'example', f)),
      scratch: join(workDir, '.tmp'),
    },
    tools: { pages: `node ${join(config.agentDir, 'tools', 'pages.mjs')} ${workDir}` },
    limits: { ...LIMITS, ...PLAN_LIMITS },
  };
}

// ctx: { workDir, archive?, emit, signal?, llm, images?, look, usage, notes?, only? }
// logDir, when set without archive, receives the agent transcripts only (tweaks snapshot versions instead).
// only limits painting to some sheets and backdrops (see paintAll); set it after the build stage.
// notes is the owner's free-text instruction for this run; archive, when set, receives logs and copies of the files.
export function createContext(options) {
  const ctx = { emit: () => {}, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, images: 0, imageTokens: 0 }, ...options };
  ctx.doc = readJson(join(ctx.workDir, 'workspace.json'));
  ctx.base = baseInput(ctx.workDir, ctx.doc);
  ctx.artMode = ctx.images ? 'painted' : 'svg';
  ctx.siteDir = join(ctx.workDir, 'site');
  ctx.runs = existsSync(join(ctx.workDir, 'inputs')) ? readdirSync(join(ctx.workDir, 'inputs')).length : 0;
  return ctx;
}

const stop = ctx => { if (ctx.signal?.aborted) throw new Error('Aborted'); };
const withNotes = (ctx, input) => ctx.notes ? { ...input, owner_notes: ctx.notes } : input;

export function archiveWork(workDir, archive) {
  if (!archive) return;
  try {
    for (const file of ['workspace.json', 'notes.md', 'brief.json', 'script.json', 'check.json']) {
      if (existsSync(join(workDir, file))) copyFile(join(workDir, file), join(archive, file));
    }
    for (const dir of ['inputs', 'reviews', 'digests', 'site']) {
      if (existsSync(join(workDir, dir))) copyDir(join(workDir, dir), join(archive, dir));
    }
  } catch (error) { console.warn(`Archive failed: ${error.message}`); }
}

// One fresh agent session per step, so reviewers judge the files, not the author's reasoning.
async function agent(ctx, { name, prompt, stage, role, input }) {
  stop(ctx);
  const n = String(++ctx.runs).padStart(2, '0');
  const inputPath = join(ctx.workDir, 'inputs', `${n}-${name}.txt`);
  mkdirSync(join(ctx.workDir, 'inputs'), { recursive: true });
  writeFileSync(inputPath, `INPUT\n${JSON.stringify(input, null, 2)}\n`);
  // The full transcript of every agent session is kept with the job's archive (transcripts.mjs serves it).
  const pi = await runPi({
    workDir: ctx.workDir, systemPath: join(config.agentDir, 'prompts', `${prompt}.md`), inputPath, stage, role,
    transcriptPath: join(ctx.logDir || ctx.archive || ctx.workDir, 'transcripts', `${n}-${name}.ndjson`), onEvent: ctx.emit, signal: ctx.signal, llm: ctx.llm, usage: ctx.usage,
  });
  archiveWork(ctx.workDir, ctx.archive);
  stop(ctx);
  if (!pi.ok) throw new Error(pi.timedOut ? `The ${role.toLowerCase()} ran out of time` : `The ${role.toLowerCase()} did not finish`);
  return pi;
}

async function mustPass(ctx, check, what, extra) {
  const report = await runPlanCheck(ctx.workDir, check, extra);
  if (!report.ok) throw new Error(`${what} failed its checks: ${report.errors.slice(0, 4).join('; ')}`);
  return report;
}

// reviews/ holds only <stage>-<round>.json; a reviewer's drafts there would be archived as if they were reviews.
// (Its transcript still has whatever it wrote.)
function dropStrayReviews(ctx, stage) {
  const dir = join(ctx.workDir, 'reviews');
  for (const f of readdirSync(dir)) {
    if (/^(brief|script)-\d+\.json$/.test(f)) continue;
    rmSync(join(dir, f), { recursive: true, force: true });
    if (ctx.archive) rmSync(join(ctx.archive, 'reviews', f), { recursive: true, force: true });
    ctx.emit({ stage, level: 'warn', message: `Removed stray reviews/${f}; reviewers write only their review` });
  }
}

// The latest script review, when it is newer than script.json: a passing critic may still list minor issues,
// and the builder is the next agent who can act on them (for example a widget the engine cannot show as planned).
export function openScriptReview(workDir) {
  const dir = join(workDir, 'reviews');
  if (!existsSync(dir)) return null;
  const rounds = readdirSync(dir).map(f => f.match(/^script-(\d+)\.json$/)).filter(Boolean).sort((a, b) => b[1] - a[1]);
  if (!rounds.length) return null;
  const file = join(dir, rounds[0][0]);
  try {
    if (statSync(file).mtimeMs < statSync(join(workDir, 'script.json')).mtimeMs) return null;
    const issues = (readJson(file).issues || []);
    return issues.length ? file : null;
  } catch { return null; }
}

// Author, then an adversarial reviewer; send it back with the review until it passes or the rounds run out.
async function reviewed(ctx, { name, stage, author, reviewer, check, reviewCheck, input, what }) {
  for (const f of readdirSync(join(ctx.workDir, 'reviews')).filter(f => f.startsWith(`${name}-`))) rmSync(join(ctx.workDir, 'reviews', f));
  await agent(ctx, { name, prompt: author.prompt, stage, role: author.role, input: withNotes(ctx, input) });
  await mustPass(ctx, check, what);
  for (let round = 1; ; round++) {
    const review = join(ctx.workDir, 'reviews', `${name}-${round}.json`);
    const reviewInput = { ...input, review, commands: { check: planCheckCommand(ctx.workDir, reviewCheck, ['--review', review]) } };
    await agent(ctx, { name: `${name}-review-${round}`, prompt: reviewer.prompt, stage, role: reviewer.role, input: reviewInput });
    dropStrayReviews(ctx, stage);
    const verdict = await runPlanCheck(ctx.workDir, reviewCheck, ['--review', review]);
    if (!verdict.ok) {
      ctx.emit({ stage, level: 'warn', message: `The ${reviewer.role.toLowerCase()}'s review was malformed (${verdict.errors[0]}); continuing with the ${what.toLowerCase()} as it is` });
      return { verdict: 'unknown', rounds: round };
    }
    let summary = '';
    try { summary = readJson(review).summary || ''; } catch {}
    const passed = verdict.verdict === 'pass';
    ctx.emit({ stage, message: `${reviewer.role}, round ${round}: ${passed ? 'pass' : 'needs work'} (${verdict.major} major issue${verdict.major === 1 ? '' : 's'}, ${verdict.failed} failed question${verdict.failed === 1 ? '' : 's'}). ${summary}` });
    if (passed) return { verdict: 'pass', rounds: round };
    if (round > config.reviewRounds) {
      ctx.emit({ stage, level: 'warn', message: `The ${what.toLowerCase()} still has open issues after ${config.reviewRounds} revisions; continuing with the best version` });
      return { verdict: 'revise', rounds: round };
    }
    await agent(ctx, { name: `${name}-revise-${round}`, prompt: author.prompt, stage, role: author.role, input: withNotes(ctx, { ...input, revise: review }) });
    await mustPass(ctx, check, what);
  }
}

const stages = {
  // Read the whole document; the examiner quizzes the brief until it holds up.
  async understand(ctx) {
    const { workDir, base, doc } = ctx;
    if (doc.mode === 'digest') {
      const parts = doc.parts.map(p => ({ ...p, file: join(workDir, 'source', `${p.id}.txt`) }));
      const groups = groupParts(parts, Math.floor(config.singlePassChars / 2));
      ctx.emit({ stage: 'understand', message: `The document is long, so ${groups.length} readers digest it part by part first` });
      for (const [n, group] of groups.entries()) {
        const ids = group.map(p => p.id).join(',');
        await agent(ctx, { name: `digest-${n + 1}`, prompt: 'digest', stage: 'understand', role: `Reader ${n + 1}/${groups.length}`,
          input: { ...base, parts: group.map(p => p.file), commands: { check: planCheckCommand(workDir, 'digest', ['--parts', ids]) } } });
        await mustPass(ctx, 'digest', `The digest of ${group[0].id}..${group.at(-1).id}`, ['--parts', ids]);
      }
    }
    const result = await reviewed(ctx, { name: 'brief', stage: 'understand', what: 'The brief', check: 'brief', reviewCheck: 'brief-review',
      author: { prompt: 'analyst', role: 'Analyst' }, reviewer: { prompt: 'examiner', role: 'Examiner' },
      input: { ...base, commands: { check: planCheckCommand(workDir, 'brief') } } });
    try {
      const brief = readJson(join(workDir, 'brief.json'));
      ctx.emit({ stage: 'understand', message: `Question: ${brief.question} Core concepts: ${brief.concepts.map(c => c.name).join(', ')}` });
    } catch {}
    return result;
  },

  // Write the script from the brief; the critic attacks it before anything is built.
  async script(ctx) {
    await mustPass(ctx, 'brief', 'The brief');
    return reviewed(ctx, { name: 'script', stage: 'script', what: 'The script', check: 'script', reviewCheck: 'script-review',
      author: { prompt: 'writer', role: 'Writer' }, reviewer: { prompt: 'critic', role: 'Critic' },
      input: { ...ctx.base, look: { label: ctx.look.label, directive: ctx.look.directive }, commands: { check: planCheckCommand(ctx.workDir, 'script') } } });
  },

  // Build the site from the approved script, then check it.
  async build(ctx) {
    const { workDir, siteDir, artMode, look } = ctx;
    await mustPass(ctx, 'script', 'The script');
    const input = {
      ...ctx.base,
      commands: { check: `node ${join(config.agentDir, 'check.mjs')} site --art ${artMode} --theme ${look.theme} --color ${look.color}` },
      art: ART_MODES[artMode],
      look: { label: look.label, theme: look.theme, color: look.color, directive: look.directive, instructions: LOOK_INSTRUCTIONS },
      rebuild: existsSync(join(siteDir, 'story.js')),
    };
    const review = openScriptReview(workDir);
    if (review) input.open_issues = review;
    const pi = await agent(ctx, { name: 'build', prompt: 'builder', stage: 'build', role: 'Builder', input: withNotes(ctx, input) });
    for (const file of ENGINE_FILES.filter(f => f !== 'index.html')) copyFile(join(config.agentDir, 'template', file), join(siteDir, file));
    ctx.emit({ stage: 'check', message: 'Checking the book' });
    const report = await runCheck(siteDir, artMode, look);
    report.final = pi.final || null;
    writeFileSync(join(workDir, 'check.json'), JSON.stringify(report, null, 2));
    archiveWork(workDir, ctx.archive);
    if (!report.ok) throw new Error(`The book failed its checks: ${report.errors.slice(0, 4).join('; ')}`);
    ctx.emit({ stage: 'check', message: `Book passes: ${report.pages} pages, ${report.images} backdrops, ${report.characters} characters${report.warnings.length ? `, ${report.warnings.length} warnings` : ''}` });
    return report;
  },

  // Paint character model sheets, then backdrops from them. Without an image key the builder drew SVGs already.
  async paint(ctx) {
    if (!ctx.images) return { painted: [], failed: [], sheets: [] };
    const report = readJson(join(ctx.workDir, 'check.json'));
    const painted = await paintAll(ctx.siteDir, ctx.images, ctx.look, ctx.emit, { signal: ctx.signal, usage: ctx.usage, sides: report.sides || {}, only: ctx.only });
    stop(ctx);
    archiveWork(ctx.workDir, ctx.archive);
    // A book with holes in it is not finished: give the missing pictures one more try, then stop
    // here instead of publishing broken pictures.
    let missing = await missingPictures(ctx.siteDir, 'painted');
    const retryable = missing.length && !painted.keyRefused && Object.values(painted.errors || {}).some(m => !/safety|moderation|content policy|verif|billing|quota|api key|unauthori[sz]ed|forbidden/i.test(m));
    if (retryable) {
      const ids = missing.map(f => f.replace(/^art\//, '').replace(/\.webp$/, ''));
      ctx.emit({ stage: 'paint', level: 'warn', message: `Trying ${ids.join(', ')} once more` });
      const only = { sheets: new Set(ids.filter(i => i.startsWith('char-')).map(i => i.slice(5))), images: new Set(ids.filter(i => !i.startsWith('char-'))) };
      const again = await paintAll(ctx.siteDir, ctx.images, ctx.look, ctx.emit, { signal: ctx.signal, usage: ctx.usage, sides: report.sides || {}, only });
      stop(ctx);
      painted.painted.push(...again.painted);
      painted.sheets.push(...again.sheets);
      Object.assign(painted.errors, again.errors);
      archiveWork(ctx.workDir, ctx.archive);
      missing = await missingPictures(ctx.siteDir, 'painted');
    }
    if (missing.length) {
      const reasons = [...new Set(Object.values(painted.errors || {}))].slice(0, 3);
      if (painted.keyRefused) throw new Error(`Painting failed: the image API refused the key (${painted.keyRefused}). ${missing.length} picture${missing.length === 1 ? '' : 's'} are missing, so the book was not published`);
      throw new Error(`Painting failed for ${missing.length} picture${missing.length === 1 ? '' : 's'} the book shows (${missing.join(', ')})${reasons.length ? `. The image API said: ${reasons.join(' | ')}` : ''}`);
    }
    return painted;
  },
};

export function runStage(name, ctx) {
  if (!stages[name]) throw new Error(`Unknown stage ${name}`);
  return stages[name](ctx);
}

// Runs from one stage through another, inclusive. Returns each stage's result by name.
export async function runStages(ctx, { from = STAGES[0], to = STAGES.at(-1) } = {}) {
  const results = {};
  for (const name of STAGES.slice(STAGES.indexOf(from), STAGES.indexOf(to) + 1)) results[name] = await runStage(name, ctx);
  return results;
}
