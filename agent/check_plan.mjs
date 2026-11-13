// Usage: node /agent/check_plan.mjs <workspace> --stage digest|brief|brief-review|script|script-review [--review <file>] [--parts a,b]
// Checks the understanding and script stages before any book code is written. Prints one JSON report; exit 1 on errors.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { LIMITS, PLAN_LIMITS } from './limits.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const stage = flag('--stage', 'brief');
const workspace = resolve(args.find((a, i) => !a.startsWith('--') && !String(args[i - 1]).startsWith('--')) || '.');
const errors = [];
const warnings = [];
const fail = message => errors.push(message);
const report = extra => {
  console.log(JSON.stringify({ ok: errors.length === 0, stage, errors, warnings, ...extra }, null, 2));
  process.exit(errors.length ? 1 : 0);
};

const WIDGETS = ['stepper', 'squeeze', 'compare', 'slider', 'quiz'];
const str = (v, max = 2000, min = 1) => typeof v === 'string' && v.trim().length >= min && v.length <= max;
const slug = v => typeof v === 'string' && /^[a-z0-9-]{1,32}$/.test(v);
const list = v => Array.isArray(v) ? v : [];

function readJson(file, label) {
  if (!existsSync(file)) { fail(`missing ${label}`); return null; }
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { fail(`${label} is not valid JSON: ${error.message}`); return null; }
}

// Quotes are compared after folding case, whitespace, quote marks, dashes and line-break hyphenation.
const fold = s => String(s).normalize('NFKC').toLowerCase()
  .replace(/[‘’‚‛`´]/g, "'").replace(/[“”„‟]/g, '"')
  .replace(/[‐-―−]/g, '-').replace(/­/g, '')
  .replace(/(\w)-\s*\n\s*(\w)/g, '$1$2').replace(/\s+/g, ' ').trim();
const loose = s => fold(s).replace(/[^a-z0-9]+/g, '');

const sourceDir = join(workspace, 'source');
const partIds = existsSync(sourceDir) ? readdirSync(sourceDir).filter(f => /^part-\d+\.txt$/.test(f)).map(f => f.slice(0, -4)).sort() : [];
const partText = new Map();
const part = id => {
  if (!partText.has(id)) {
    const file = join(sourceDir, `${id}.txt`);
    partText.set(id, existsSync(file) ? { folded: fold(readFileSync(file, 'utf8')), loose: loose(readFileSync(file, 'utf8')) } : null);
  }
  return partText.get(id);
};

let quotes = 0, badQuotes = 0;
function checkQuote(where, ref) {
  if (!ref || typeof ref !== 'object') { fail(`${where}: needs { part, quote }`); return; }
  if (!partIds.includes(ref.part)) { fail(`${where}: part ${JSON.stringify(ref.part)} is not one of ${partIds[0]}..${partIds.at(-1)}`); return; }
  if (!str(ref.quote, PLAN_LIMITS.maxQuoteChars, PLAN_LIMITS.minQuoteChars)) { fail(`${where}: quote must be ${PLAN_LIMITS.minQuoteChars}-${PLAN_LIMITS.maxQuoteChars} chars copied from ${ref.part}`); return; }
  quotes++;
  const text = part(ref.part);
  const q = ref.quote.replace(/^\s*(\.\.\.|…)\s*|\s*(\.\.\.|…)\s*$/g, '');
  // Allow an ellipsis inside a quote: every piece must appear, in order.
  const pieces = q.split(/\s*(?:\.\.\.|…)\s*/).filter(Boolean);
  let from = 0, found = true;
  for (const piece of pieces) {
    const at = text.folded.indexOf(fold(piece), from);
    if (at === -1) { found = false; break; }
    from = at + 1;
  }
  if (!found && !pieces.every(piece => text.loose.includes(loose(piece)))) {
    badQuotes++;
    fail(`${where}: quote not found in ${ref.part}; copy it exactly: ${JSON.stringify(ref.quote.slice(0, 80))}`);
  }
}

function checkDigest() {
  const wanted = String(flag('--parts', '')).split(',').filter(Boolean);
  if (!wanted.length) fail('pass --parts');
  for (const id of wanted) {
    const digest = readJson(join(workspace, 'digests', `${id}.json`), `digests/${id}.json`);
    if (!digest) continue;
    if (digest.part !== id) fail(`digests/${id}.json: part must be "${id}"`);
    if (!str(digest.gist, 600, 20)) fail(`digests/${id}.json: gist must be 20-600 chars`);
    const points = list(digest.points);
    if (points.length < 2 || points.length > 15) fail(`digests/${id}.json: need 2-15 points`);
    points.forEach((p, i) => {
      if (!str(p?.point, 600, 10)) fail(`digests/${id}.json points[${i}]: point is required`);
      checkQuote(`digests/${id}.json points[${i}]`, { part: id, quote: p?.quote });
    });
  }
  report({ parts: wanted.length, quotes, badQuotes });
}

function loadBrief() {
  const brief = readJson(join(workspace, 'brief.json'), 'brief.json');
  if (!brief) return null;
  for (const field of ['topic', 'question', 'answer']) if (!str(brief[field], 400, 10)) fail(`brief.${field} is required: one or two plain sentences`);
  const concepts = list(brief.concepts);
  if (concepts.length < PLAN_LIMITS.minConcepts || concepts.length > PLAN_LIMITS.maxConcepts)
    fail(`brief.concepts has ${concepts.length}; need ${PLAN_LIMITS.minConcepts}-${PLAN_LIMITS.maxConcepts}`);
  const ids = new Set();
  concepts.forEach((c, i) => {
    const where = `brief.concepts[${i}]`;
    if (!slug(c?.id)) fail(`${where}: id must be a short slug`);
    else if (ids.has(c.id)) fail(`${where}: duplicate id ${c.id}`);
    ids.add(c?.id);
    if (!str(c?.name, 60)) fail(`${where}: name is required`);
    if (!str(c?.plain, 500, 30)) fail(`${where}: plain must explain it to a 10-12 year old (30-500 chars)`);
    if (!str(c?.precise, 1200, 30)) fail(`${where}: precise must explain it accurately with the real terms (30-1200 chars)`);
    if (!Array.isArray(c?.how) || c.how.length < 1 || !c.how.every(s => str(s, 300))) fail(`${where}: how must list the steps of the mechanism`);
    const evidence = list(c?.evidence);
    if (!evidence.length) fail(`${where}: needs at least one evidence quote`);
    evidence.forEach((e, n) => checkQuote(`${where}.evidence[${n}]`, e));
  });
  concepts.forEach((c, i) => list(c?.depends_on).forEach(d => { if (!ids.has(d)) fail(`brief.concepts[${i}].depends_on: unknown concept ${d}`); }));
  list(brief.facts).forEach((f, i) => {
    if (!str(f?.claim, 400)) fail(`brief.facts[${i}]: claim is required`);
    checkQuote(`brief.facts[${i}]`, f);
  });
  if (!list(brief.misconceptions).length) warnings.push('brief.misconceptions is empty; the examiner and critic use it to catch misleading metaphors');
  list(brief.misconceptions).forEach((m, i) => { if (!str(m?.wrong, 300) || !str(m?.right, 400)) fail(`brief.misconceptions[${i}]: needs wrong and right`); });
  const covered = new Map(list(brief.coverage).map(c => [c?.part, c]));
  for (const id of partIds) {
    const c = covered.get(id);
    if (!c) { fail(`brief.coverage: ${id} is missing; read it and add its gist and a quote`); continue; }
    if (!str(c.gist, 400, 10)) fail(`brief.coverage ${id}: gist is required`);
    checkQuote(`brief.coverage ${id}`, c);
  }
  if (!partIds.length) fail('no source parts found in source/');
  return { brief, conceptIds: ids };
}

function checkBrief() {
  const loaded = loadBrief();
  report({ concepts: loaded ? list(loaded.brief.concepts).length : 0, parts: partIds.length, quotes, badQuotes });
}

function checkVerdict(review, label) {
  if (!['pass', 'revise'].includes(review.verdict)) fail(`${label}: verdict must be "pass" or "revise"`);
  if (!str(review.summary, 800, 10)) fail(`${label}: summary is required`);
  const issues = list(review.issues);
  issues.forEach((issue, i) => {
    if (!['major', 'minor'].includes(issue?.severity)) fail(`${label} issues[${i}]: severity must be major or minor`);
    if (!str(issue?.problem, 600) || !str(issue?.fix, 600)) fail(`${label} issues[${i}]: problem and fix are required`);
  });
  return issues.filter(i => i?.severity === 'major').length;
}

function checkBriefReview() {
  const file = resolve(workspace, flag('--review', ''));
  const review = readJson(file, file.replace(`${workspace}/`, ''));
  if (!review) return report({});
  const questions = list(review.questions);
  if (questions.length < PLAN_LIMITS.minExamQuestions) fail(`questions has ${questions.length}; ask at least ${PLAN_LIMITS.minExamQuestions}`);
  for (const who of ['child', 'expert']) if (questions.filter(q => q?.asked_by === who).length < 4) fail(`ask at least 4 questions with asked_by "${who}"`);
  questions.forEach((q, i) => {
    if (!str(q?.question, 300)) fail(`questions[${i}]: question is required`);
    if (!str(q?.brief_answer, 800)) fail(`questions[${i}]: brief_answer is required ("not covered" if the brief has none)`);
    if (!str(q?.source_answer, 800)) fail(`questions[${i}]: source_answer is required`);
    if (typeof q?.ok !== 'boolean') fail(`questions[${i}]: ok must be true or false`);
    if (q?.ok === false && !str(q?.problem, 600)) fail(`questions[${i}]: explain the problem when ok is false`);
  });
  const major = checkVerdict(review, 'review');
  const failed = questions.filter(q => q?.ok === false).length;
  if (review.verdict === 'pass' && (major || failed > PLAN_LIMITS.maxFailedQuestions))
    fail(`verdict cannot be "pass" with ${major} major issues and ${failed} failed questions`);
  report({ verdict: review.verdict, major, failed, questions: questions.length });
}

function loadScript(conceptIds) {
  const script = readJson(join(workspace, 'script.json'), 'script.json');
  if (!script) return null;
  for (const field of ['title', 'question', 'answer']) if (!str(script[field], 300, 3)) fail(`script.${field} is required`);
  const metaphor = script.metaphor || {};
  if (!str(metaphor.world, 600, 20)) fail('script.metaphor.world must describe the metaphor world');
  const mapped = new Set();
  list(metaphor.map).forEach((m, i) => {
    if (!conceptIds.has(m?.concept)) fail(`script.metaphor.map[${i}]: concept must be a brief concept id`);
    mapped.add(m?.concept);
    for (const k of ['thing', 'behaves', 'mirrors', 'breaks']) if (!str(m?.[k], 600)) fail(`script.metaphor.map[${i}]: ${k} is required`);
  });
  for (const id of conceptIds) if (!mapped.has(id)) fail(`script.metaphor.map: concept ${id} has no metaphor`);

  const ideas = list(script.ideas);
  if (ideas.length < LIMITS.minIdeas || ideas.length > LIMITS.maxIdeas) fail(`script.ideas has ${ideas.length}; need ${LIMITS.minIdeas}-${LIMITS.maxIdeas}`);
  const ideaIds = new Set(), taught = new Set();
  ideas.forEach((idea, i) => {
    if (!slug(idea?.id)) fail(`script.ideas[${i}]: id must be a short slug`);
    ideaIds.add(idea?.id);
    if (!str(idea?.title, 40)) fail(`script.ideas[${i}]: title is required, at most 40 chars`);
    if (!str(idea?.text, 200)) fail(`script.ideas[${i}]: text is required, at most 200 chars`);
    const cs = list(idea?.concepts);
    if (!cs.length) fail(`script.ideas[${i}]: concepts must list the brief concepts it teaches`);
    cs.forEach(c => { if (!conceptIds.has(c)) fail(`script.ideas[${i}]: unknown concept ${c}`); else taught.add(c); });
  });
  for (const id of conceptIds) if (!taught.has(id)) fail(`brief concept ${id} is not taught by any idea`);

  const characters = list(script.characters);
  if (characters.length < LIMITS.minCharacters || characters.length > LIMITS.maxCharacters)
    fail(`script.characters has ${characters.length}; need ${LIMITS.minCharacters}-${LIMITS.maxCharacters}`);
  const charIds = new Set();
  characters.forEach((c, i) => {
    if (!slug(c?.id)) fail(`script.characters[${i}]: id must be a short slug`);
    charIds.add(c?.id);
    if (!str(c?.name, 60)) fail(`script.characters[${i}]: name is required`);
    if (!str(c?.is, 200)) fail(`script.characters[${i}]: is must say what it stands for`);
    if (!str(c?.look, 700, 80)) fail(`script.characters[${i}]: look must be a full visual model (80-700 chars): body, size, colours, clothing, a distinctive prop or mark`);
  });

  const scenes = list(script.scenes);
  if (!scenes.length || scenes.length > LIMITS.maxImages) fail(`script.scenes has ${scenes.length}; need 1-${LIMITS.maxImages}`);
  const sceneIds = new Set();
  scenes.forEach((s, i) => {
    if (!slug(s?.id)) fail(`script.scenes[${i}]: id must be a short slug`);
    sceneIds.add(s?.id);
    if (!str(s?.shows, 800, LIMITS.minPromptChars)) fail(`script.scenes[${i}]: shows must describe the composition (${LIMITS.minPromptChars}+ chars)`);
    list(s?.characters).forEach(c => { if (!charIds.has(c)) fail(`script.scenes[${i}]: unknown character ${c}`); });
  });

  const pages = list(script.pages);
  if (pages.length < LIMITS.minPages || pages.length > LIMITS.maxPages) fail(`script.pages has ${pages.length}; need ${LIMITS.minPages}-${LIMITS.maxPages}`);
  let interactions = 0;
  const usedIdeas = new Set();
  pages.forEach((p, i) => {
    const where = `script.pages[${i}]`;
    if (i > 0) { if (!ideaIds.has(p?.idea)) fail(`${where}: idea must be one of script.ideas ids`); else usedIdeas.add(p.idea); }
    if (!sceneIds.has(p?.scene)) fail(`${where}: scene must be one of script.scenes ids`);
    if (!str(p?.text, LIMITS.maxTextChars)) fail(`${where}: text is required, at most ${LIMITS.maxTextChars} chars (it is ${String(p?.text ?? '').length})`);
    if (i > 0 && !str(p?.teaches, 300)) fail(`${where}: teaches must say what the reader understands after this page`);
    if (p?.side && !['left', 'right', 'bottom'].includes(p.side)) fail(`${where}: side must be left, right or bottom`);
    if (p?.interaction) {
      if (!WIDGETS.includes(p.interaction.type)) fail(`${where}: interaction.type must be one of ${WIDGETS.join(', ')}`);
      if (!str(p.interaction.plan, 1200, 30)) fail(`${where}: interaction.plan must spell out the real content`);
      interactions++;
    }
    const sentences = String(p?.text || '').split(/[.!?]+\s/).filter(s => s.trim());
    const long = sentences.filter(s => s.split(/\s+/).length > 22);
    if (long.length) warnings.push(`${where}: a sentence has more than 22 words; 10-12 year olds read shorter ones`);
  });
  for (const id of ideaIds) if (!usedIdeas.has(id)) fail(`idea ${id} is never taught by a page`);
  if (interactions < LIMITS.minInteractions) fail(`only ${interactions} pages plan an interaction; need ${LIMITS.minInteractions}`);
  const lastInteractive = [...pages].reverse().find(p => p?.interaction);
  if (lastInteractive && lastInteractive.interaction.type !== 'quiz') fail('the last interactive page must be a quiz on the central question');
  return { script, pages: pages.length };
}

function checkScript() {
  const loaded = loadBrief();
  // Quote problems in the brief were the analyst's; only structural ones block the script.
  errors.length = 0;
  warnings.length = 0;
  const result = loaded ? loadScript(loaded.conceptIds) : null;
  report({ pages: result?.pages ?? 0 });
}

function checkScriptReview() {
  const file = resolve(workspace, flag('--review', ''));
  const review = readJson(file, file.replace(`${workspace}/`, ''));
  if (!review) return report({});
  const tests = list(review.reader_test);
  if (tests.length < 3) fail('reader_test needs the central question and one entry per brief concept');
  tests.forEach((t, i) => {
    if (!str(t?.question, 300)) fail(`reader_test[${i}]: question is required`);
    if (!str(t?.answer_from_pages, 800)) fail(`reader_test[${i}]: answer_from_pages is required`);
    if (typeof t?.correct !== 'boolean') fail(`reader_test[${i}]: correct must be true or false`);
  });
  list(review.issues).forEach((issue, i) => {
    if (!['clarity', 'metaphor', 'accuracy', 'story', 'age', 'interaction', 'art'].includes(issue?.kind))
      fail(`review issues[${i}]: kind must be clarity, metaphor, accuracy, story, age, interaction or art`);
  });
  const major = checkVerdict(review, 'review');
  const failed = tests.filter(t => t?.correct === false).length;
  if (review.verdict === 'pass' && (major || failed)) fail(`verdict cannot be "pass" with ${major} major issues and ${failed} failed reader tests`);
  report({ verdict: review.verdict, major, failed });
}

({ digest: checkDigest, brief: checkBrief, 'brief-review': checkBriefReview, script: checkScript, 'script-review': checkScriptReview }[stage]
  || (() => { fail(`unknown stage ${stage}`); report({}); }))();
