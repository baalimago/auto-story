// Usage: node /agent/check.mjs <site-dir> [--art painted|svg] [--final]. Prints one JSON report; exit 1 on errors.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LIMITS, ENGINE_FILES, AUTHORED_FILES, MAX_SVG_BYTES } from './limits.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const artMode = flag('--art', 'painted');
const theme = flag('--theme', null);
const colorMode = flag('--color', 'color');
// --final: the pictures must be on disk too (after painting, before deploying).
const final = args.includes('--final');
// Always end with a report, even if something above never settles.
let reported = false;
const watchdog = setTimeout(() => {
  if (reported) return;
  reported = true;
  console.log(JSON.stringify({ ok: false, errors: ['check.mjs timed out after 45s; a scene or module keeps running'], warnings: [] }, null, 2));
  process.exit(1);
}, 45000);
const site = resolve(args.find((a, i) => !a.startsWith('--') && !String(args[i - 1]).startsWith('--')) || '.');
const errors = [];
const warnings = [];
const missingArt = [];
const fail = message => errors.push(message);

function fake() {
  const target = function () {};
  return new Proxy(target, {
    get(_, key) {
      if (key === Symbol.toPrimitive) return () => 0;
      if (key === 'then') return undefined;
      if (key === 'length') return 0;
      if (key === Symbol.iterator) return function* () {};
      return fake();
    },
    set() { return true; },
    apply() { return fake(); },
    construct() { return fake(); },
  });
}

const SCENE_MS = 3000;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function within(ms, promise, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })])
    .finally(() => clearTimeout(timer));
}

const str = (v, max = 400) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const chipList = list => list === undefined || (Array.isArray(list) && list.length <= 12 &&
  list.every(c => str(c, 40) || (c && str(c.text, 40) && (c.state === undefined || ['new', 'ok', 'wrong', 'dim'].includes(c.state)))));

function widgetProblems(w) {
  const p = [];
  if (!str(w.title, 60)) p.push('title is required (at most 60 chars)');
  switch (w.type) {
    case 'stepper':
      if (!Array.isArray(w.steps) || w.steps.length < 2 || w.steps.length > 8) p.push('stepper needs 2-8 steps');
      else w.steps.forEach((s, n) => {
        if (!str(s.label, 60) || !str(s.caption, 220)) p.push(`step ${n} needs label and caption`);
        if (!chipList(s.chips)) p.push(`step ${n} chips must be up to 12 short strings or {text, state}`);
      });
      break;
    case 'squeeze':
      if (!Number.isInteger(w.capacity) || w.capacity < 1 || w.capacity > 5) p.push('squeeze capacity must be 1-5');
      if (!Array.isArray(w.items) || w.items.length <= (w.capacity || 0) || w.items.length > 9) p.push('squeeze needs more items than capacity, at most 9');
      else {
        if (!w.items.every(it => str(it.text, 40) && typeof it.important === 'boolean')) p.push('squeeze items need text and important: true|false');
        const important = w.items.filter(it => it.important).length;
        if (important < 1 || important > w.capacity) p.push('squeeze needs 1..capacity important items');
      }
      if (!str(w.good, 220) || !str(w.bad, 220)) p.push('squeeze needs good and bad feedback');
      break;
    case 'compare':
      for (const side of ['a', 'b']) {
        if (!w[side] || !str(w[side].label, 30) || !str(w[side].caption, 220)) p.push(`compare.${side} needs label and caption`);
        else if (!chipList(w[side].chips)) p.push(`compare.${side}.chips invalid`);
      }
      break;
    case 'slider':
      if (!str(w.label, 40)) p.push('slider needs a label');
      if (!(Number.isFinite(w.min) && Number.isFinite(w.max) && w.max > w.min)) p.push('slider needs numeric min < max');
      if (!Array.isArray(w.points) || w.points.length < 2 || w.points.length > 6) p.push('slider needs 2-6 points');
      else if (!w.points.every(pt => Number.isFinite(pt.at) && pt.at >= w.min && pt.at <= w.max && str(pt.outcome, 200) && Number.isFinite(pt.meter)))
        p.push('slider points need at (within min..max), outcome, meter 0-100');
      break;
    case 'quiz':
      if (!str(w.question, 200)) p.push('quiz needs a question');
      if (!Array.isArray(w.choices) || w.choices.length < 2 || w.choices.length > 4) p.push('quiz needs 2-4 choices');
      else {
        if (w.choices.filter(c => c.correct === true).length !== 1) p.push('quiz needs exactly one correct choice');
        if (!w.choices.every(c => str(c.text, 120) && str(c.why, 220))) p.push('quiz choices need text and why');
      }
      break;
    default:
      p.push(`type must be one of stepper, squeeze, compare, slider, quiz (got ${JSON.stringify(w.type)})`);
  }
  return p;
}

async function smokeScene(name, scene, page, palette) {
  const handlers = [];
  const timers = [];
  const frames = [];
  let pendingTimers = 0;
  // Timers fire asynchronously, like a browser, so code awaiting them can settle.
  const schedule = fn => { timers.push(fn); pendingTimers++; setTimeout(() => { pendingTimers--; try { fn(); } catch (error) { fail(`scene ${name} timer threw: ${error?.message || error}`); } }, 0); return 0; };
  const api = {
    svg: fake(), palette, page,
    el: () => fake(), text: () => fake(), hint() {}, card: () => fake(),
    area: { x: 60, y: 140, w: 820, h: 720 },
    on: (_target, _type, fn) => { handlers.push(fn); },
    after: (_ms, fn) => schedule(fn),
    every: (_ms, fn) => schedule(fn),
    frame: fn => { frames.push(fn); },
    animate: () => fake(),
    point: () => ({ x: 750, y: 500 }),
    cleanup() {}, next() {}, prev() {},
  };
  try {
    await within(SCENE_MS, (async () => {
      await scene(api);
      for (const fn of handlers) await fn(fake());
      for (const fn of frames) for (let i = 0; i < 3; i++) fn(0.016, i * 16);
      await wait(10);
    })(), `scene ${name} did not settle within ${SCENE_MS / 1000}s (a handler may await something that never resolves)`);
  } catch (error) {
    fail(`scene ${name} failed the smoke test: ${error?.message || error}`);
  }
  if (!handlers.length && !frames.length && !timers.length) warnings.push(`scene ${name} registers no interaction or animation`);
}

for (const file of [...ENGINE_FILES, ...AUTHORED_FILES]) {
  if (!existsSync(join(site, file))) fail(`missing ${file}`);
}

let story, scenes, plan;
if (!errors.length) {
  const globals = ['document', 'window', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'];
  const saved = Object.fromEntries(globals.map(g => [g, globalThis[g]]));
  for (const g of globals) { try { if (g !== 'performance') globalThis[g] = fake(); } catch {} }
  try {
    story = (await import(pathToFileURL(join(site, 'story.js')).href)).default;
  } catch (error) { fail(`story.js does not import: ${error.message}`); }
  try {
    scenes = (await import(pathToFileURL(join(site, 'scenes.js')).href)).default;
  } catch (error) { fail(`scenes.js does not import: ${error.message}`); }
  try {
    plan = JSON.parse(readFileSync(join(site, 'art/plan.json'), 'utf8'));
  } catch (error) { fail(`art/plan.json is not valid JSON: ${error.message}`); }

  if (story && typeof story === 'object') {
    const pages = Array.isArray(story.pages) ? story.pages : [];
    if (typeof story.title !== 'string' || !story.title.trim()) fail('story.title is required');
    if (pages.length < LIMITS.minPages || pages.length > LIMITS.maxPages) {
      fail(`story.pages has ${pages.length} pages; need ${LIMITS.minPages}-${LIMITS.maxPages}`);
    }
    if (pages[0] && !pages[0].art) fail('page 0 (cover) needs art');
    for (const field of ['question', 'answer']) {
      if (typeof story[field] !== 'string' || story[field].trim().length < 10) fail(`story.${field} is required: one plain sentence`);
    }
    const ideas = Array.isArray(story.ideas) ? story.ideas : [];
    if (ideas.length < LIMITS.minIdeas || ideas.length > LIMITS.maxIdeas) fail(`story.ideas has ${ideas.length} ideas; need ${LIMITS.minIdeas}-${LIMITS.maxIdeas}`);
    const ideaIds = new Set();
    ideas.forEach((idea, n) => {
      if (!/^[a-z0-9-]{1,32}$/.test(idea?.id || '')) fail(`ideas[${n}]: id must be a short slug`);
      if (ideaIds.has(idea?.id)) fail(`ideas[${n}]: duplicate id ${idea.id}`);
      ideaIds.add(idea?.id);
      if (!idea?.title || idea.title.length > 40) fail(`ideas[${n}]: title is required, at most 40 chars`);
      if (!idea?.text || idea.text.length > 200) fail(`ideas[${n}]: text is required, at most 200 chars`);
    });
    const usedIdeas = new Set();
    const imageIds = new Set((plan?.images || []).map(i => i.id));
    let interactions = 0, freeform = 0, noteCount = 0;
    pages.forEach((page, i) => {
      const where = `page ${i}`;
      if (['cast', 'learn', 'answer'].includes(page.kind)) return;
      if (i > 0) {
        if (!ideaIds.has(page.idea)) fail(`${where}: idea must be one of story.ideas ids`);
        else usedIdeas.add(page.idea);
      }
      if (page.widget && page.scene) fail(`${where}: use a widget or a scene, not both`);
      if (page.widget) { interactions++; for (const problem of widgetProblems(page.widget)) fail(`${where}: widget ${problem}`); }
      if (typeof page.text !== 'string' || !page.text.trim()) fail(`${where}: text is required`);
      else if (page.text.length > LIMITS.maxTextChars) fail(`${where}: text is ${page.text.length} chars; max ${LIMITS.maxTextChars}`);
      if (page.art && !imageIds.has(page.art)) fail(`${where}: art "${page.art}" is not in art/plan.json`);
      if (page.side && !['left', 'right', 'bottom'].includes(page.side)) fail(`${where}: side must be left, right or bottom`);
      if (page.note) {
        noteCount++;
        if (page.note.length > LIMITS.maxNoteChars) fail(`${where}: note is ${page.note.length} chars; max ${LIMITS.maxNoteChars}`);
      }
      if (page.scene) {
        interactions++;
        freeform++;
        if (typeof scenes?.[page.scene] !== 'function') fail(`${where}: scene "${page.scene}" is not a function exported by scenes.js`);
      }
    });
    if (interactions < LIMITS.minInteractions) fail(`only ${interactions} pages have a widget or scene; need ${LIMITS.minInteractions}`);
    if (freeform > LIMITS.maxFreeformScenes) fail(`${freeform} freeform scenes; use widgets, at most ${LIMITS.maxFreeformScenes} freeform scenes`);
    for (const id of ideaIds) if (!usedIdeas.has(id)) fail(`idea "${id}" is never taught by a page`);
    if (noteCount < Math.floor((pages.length - 1) / 2)) fail(`only ${noteCount} pages have a grown-up note; need at least half`);
    const cast = Array.isArray(story.cast) ? story.cast : [];
    if (cast.length < LIMITS.minCast) fail(`story.cast has ${cast.length} entries; need ${LIMITS.minCast}`);
    cast.forEach((c, i) => { if (!c?.name || !c?.is || !c?.explain) fail(`cast ${i}: name, is and explain are required`); });
    const palette = story.palette || {};
    for (const [key, value] of Object.entries(palette)) {
      if (!/^#[0-9a-f]{6}$/i.test(value)) fail(`palette.${key} must be a #rrggbb color`);
      else if (colorMode === 'bw') {
        const [r, g, b] = [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16));
        if (Math.max(r, g, b) - Math.min(r, g, b) > 12) fail(`palette.${key} must be a grey for a black & white book`);
      }
    }
    if (theme && story.theme !== theme) fail(`story.theme must be "${theme}"`);
    if (colorMode === 'bw' && story.mono !== true) fail('story.mono must be true for a black & white book');
    if (colorMode !== 'bw' && story.mono) fail('story.mono must be unset for a colour book');
    if (scenes && typeof scenes === 'object') {
      const used = new Set(pages.map(p => p.scene).filter(Boolean));
      for (const [name, scene] of Object.entries(scenes)) {
        if (!used.has(name)) warnings.push(`scene ${name} is never used`);
        else if (typeof scene === 'function') await smokeScene(name, scene, pages.find(p => p.scene === name), palette);
      }
    } else if (scenes !== undefined) fail('scenes.js must export default an object of functions');
  } else if (story !== undefined) fail('story.js must export default an object');

  if (plan) {
    const images = Array.isArray(plan.images) ? plan.images : [];
    if (typeof plan.style !== 'string' || plan.style.length < 40) fail('art/plan.json: style must describe the shared look (40+ chars)');
    const characters = Array.isArray(plan.characters) ? plan.characters : [];
    if (characters.length < LIMITS.minCharacters || characters.length > LIMITS.maxCharacters)
      fail(`art/plan.json: characters must list ${LIMITS.minCharacters}-${LIMITS.maxCharacters} recurring characters as { id, name, look }`);
    const charIds = new Set();
    for (const c of characters) {
      if (!/^[a-z0-9-]{1,32}$/.test(c?.id || '')) fail(`art/plan.json: bad character id ${JSON.stringify(c?.id)}`);
      if (charIds.has(c?.id)) fail(`art/plan.json: duplicate character id ${c.id}`);
      charIds.add(c?.id);
      if (typeof c?.name !== 'string' || !c.name.trim()) fail(`art/plan.json: character ${c?.id} needs a name`);
      if (typeof c?.look !== 'string' || c.look.length < 60) fail(`art/plan.json: character ${c?.id} needs a full visual look (60+ chars)`);
    }
    if (!images.length || images.length > LIMITS.maxImages) fail(`art/plan.json: need 1-${LIMITS.maxImages} images, found ${images.length}`);
    const ids = new Set();
    for (const image of images) {
      if (!/^[a-z0-9-]{1,32}$/.test(image?.id || '')) fail(`art/plan.json: bad image id ${JSON.stringify(image?.id)}`);
      if (ids.has(image.id)) fail(`art/plan.json: duplicate image id ${image.id}`);
      ids.add(image.id);
      if (typeof image.prompt !== 'string' || image.prompt.length < LIMITS.minPromptChars) fail(`art/plan.json: image ${image.id} prompt is too short`);
      if (image.characters !== undefined && !Array.isArray(image.characters)) fail(`art/plan.json: image ${image.id} characters must be a list of character ids`);
      for (const c of image.characters || []) if (!charIds.has(c)) fail(`art/plan.json: image ${image.id} lists unknown character ${c}`);
    }
    for (const c of story?.cast || []) {
      if (c?.art && !(c.art.startsWith('char-') && charIds.has(c.art.slice(5)))) fail(`cast ${c.name}: art must be "char-<id>" of a plan character`);
    }
    const used = new Set((story?.pages || []).map(p => p.art).filter(Boolean));
    for (const id of ids) if (!used.has(id)) warnings.push(`image ${id} is planned but unused`);
    if (artMode === 'svg') {
      if (story?.artExtension !== 'svg') fail("story.artExtension must be 'svg' when you draw the backdrops");
      for (const id of [...ids, ...[...charIds].map(c => `char-${c}`)]) {
        const file = join(site, 'art', `${id}.svg`);
        if (!existsSync(file)) { fail(`missing art/${id}.svg`); continue; }
        const svg = readFileSync(file, 'utf8');
        if (svg.length > MAX_SVG_BYTES) fail(`art/${id}.svg is ${svg.length} bytes; max ${MAX_SVG_BYTES}`);
        if (!/<svg[\s>]/.test(svg) || !/viewBox=/.test(svg)) fail(`art/${id}.svg needs an <svg> root with a viewBox`);
        if (/<script|<image|<foreignObject|\bon[a-z]+=|href=["']https?:/i.test(svg)) fail(`art/${id}.svg must not contain scripts, images, event handlers or external links`);
      }
    } else if (story?.artExtension) fail('leave story.artExtension unset; the coordinator paints webp backdrops');
    if (final) {
      const ext = story?.artExtension || 'webp';
      const wanted = new Set([...used, ...(story?.cast || []).map(c => c?.art).filter(Boolean)]);
      for (const id of wanted) {
        const file = join(site, 'art', `${id}.${ext}`);
        if (!existsSync(file) || !statSync(file).size) missingArt.push(`art/${id}.${ext}`);
      }
      if (missingArt.length) fail(`${missingArt.length} picture${missingArt.length === 1 ? '' : 's'} the book shows ${missingArt.length === 1 ? 'is' : 'are'} missing: ${missingArt.join(', ')}`);
    }
  }

  for (const file of ['story.js', 'scenes.js']) {
    const source = readFileSync(join(site, file), 'utf8');
    const urls = (source.match(/https?:\/\/[^\s'"`)]+/g) || []).filter(u => !u.startsWith('http://www.w3.org/'));
    if (urls.length) fail(`${file} must be self-contained; found ${urls.slice(0, 3).join(', ')}`);
  }
  const html = readFileSync(join(site, 'index.html'), 'utf8');
  for (const ref of ['book.js', 'book.css', 'story.css', 'https://watermark.wasmer.app/watermark.js?url=powered-by-wasmer.svg']) if (!html.includes(ref)) fail(`index.html must reference ${ref}`);
  for (const g of globals) { try { globalThis[g] = saved[g]; } catch {} }
}

const report = {
  ok: errors.length === 0,
  errors,
  warnings,
  pages: story?.pages?.length ?? 0,
  images: plan?.images?.length ?? 0,
  cover: story?.pages?.[0]?.art ?? null,
  missingArt,
  // Where the words sit on each backdrop, so the painter keeps that part calm.
  sides: (story?.pages || []).reduce((sides, page, index) => {
    if (!page?.art) return sides;
    // book.js rules: it inserts a "learn" page after the cover, and alternates sides by rendered index.
    const shift = index > 0 && (story.ideas || []).length && !story.pages.some(p => p.kind === 'learn') ? 1 : 0;
    let side = page.side || ((index + shift) % 2 ? 'right' : 'left');
    if ((page.widget || page.scene) && side === 'bottom') side = 'right';
    sides[page.art] = [...new Set([...(sides[page.art] || []), side])];
    return sides;
  }, {}),
  characters: Array.isArray(plan?.characters) ? plan.characters.length : 0,
  artMode,
  theme,
  colorMode,
};
reported = true;
clearTimeout(watchdog);
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
