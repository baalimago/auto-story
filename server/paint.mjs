// Paints art/plan.json with the OpenAI Images API: one model sheet per character first,
// then every backdrop from the sheets of the characters in it, so they look the same on every page.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';

const CONCURRENCY = 4;
const NO_TEXT = 'No text, letters, numbers, speech bubbles, signs, captions, or watermarks anywhere.';
const CALM = {
  left: 'the left 40% of the picture',
  right: 'the right 40% of the picture',
  bottom: 'the bottom third of the picture',
};

const characterList = plan => Array.isArray(plan.characters) ? plan.characters : [];

export function composeCharacterPrompt(plan, character, look) {
  return [
    `Art style, follow strictly: ${look.directive}`,
    plan.style.trim(),
    `Character model sheet for ${character.name}: ${character.look.trim()}`,
    'One full-body figure in a friendly neutral pose, three-quarter front view, centred with space all around it, on a plain light paper background with nothing else in the picture.',
    'This sheet is the reference for every later picture, so show every detail of the description clearly.',
    NO_TEXT,
    look.color === 'bw' ? 'Colour rule overrides any colours named above: black and white only.' : '',
  ].filter(Boolean).join('\n\n');
}

export function composePrompt(plan, image, look, { sides = [], refs = [] } = {}) {
  const all = characterList(plan);
  const present = (image.characters || []).map(id => all.find(c => c.id === id)).filter(Boolean);
  const calm = sides.map(side => CALM[side]).filter(Boolean);
  return [
    `Art style, follow strictly: ${look.directive}`,
    plan.style.trim(),
    // Legacy plans described all characters in one string.
    typeof plan.characters === 'string' ? `Recurring characters, drawn the same way every time: ${plan.characters.trim()}` : '',
    present.length ? `Characters in this picture, drawn exactly the same way as everywhere else in the book:\n${present.map(c => `- ${c.name}: ${c.look.trim()}`).join('\n')}` : '',
    refs.length ? `The attached images are the model sheets of ${refs.map(r => r.name).join(', ')}, in that order. Draw each of them exactly as on their sheet: same body shape, proportions, colours, clothing and props. Do not copy the sheets' plain background or pose.` : '',
    `Scene: ${image.prompt.trim()}`,
    calm.length ? `Keep ${calm.join(' and ')} calm and mostly empty (soft sky, wall, water or ground), because the page's words are printed there. Put the characters and the action elsewhere.` : '',
    `Wide landscape 3:2 illustration, one single image (no panel grid). ${NO_TEXT}`,
    look.color === 'bw' ? 'Colour rule overrides any colours named above: black and white only.' : '',
  ].filter(Boolean).join('\n\n');
}

async function request(path, init, images, usage) {
  const response = await fetch(`${images.baseUrl}${path}`, { method: 'POST', ...init, headers: { authorization: `Bearer ${images.apiKey}`, ...init.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.error?.message || `HTTP ${response.status}`), { status: response.status });
  if (usage && body.usage) usage.imageTokens += body.usage.total_tokens || 0;
  const b64 = body.data?.[0]?.b64_json;
  if (!b64) throw new Error('No image data returned');
  return Buffer.from(b64, 'base64');
}

function generate(prompt, size, images, usage) {
  return request('/images/generations', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: images.model, prompt, n: 1, size, quality: config.imageQuality, output_format: 'webp', output_compression: 82 }),
  }, images, usage);
}

// The edits endpoint takes reference images; high input fidelity keeps faces and outfits closest to the sheets.
async function edit(prompt, size, refs, images, usage, fidelity = true) {
  const form = new FormData();
  form.append('model', images.model);
  form.append('prompt', prompt);
  form.append('size', size);
  form.append('quality', config.imageQuality);
  form.append('output_format', 'webp');
  form.append('output_compression', '82');
  if (fidelity) form.append('input_fidelity', 'high');
  for (const ref of refs) form.append('image[]', new Blob([ref.data], { type: 'image/webp' }), `${ref.id}.webp`);
  try {
    return await request('/images/edits', { body: form }, images, usage);
  } catch (error) {
    if (fidelity && /input_fidelity/i.test(error.message)) return edit(prompt, size, refs, images, usage, false);
    throw error;
  }
}

async function withRetries(fn) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { return await fn(); } catch (error) {
      lastError = error;
      if (/safety|moderation|content policy/i.test(error.message) || error.status === 400) break;
      await new Promise(r => setTimeout(r, attempt * 3000));
    }
  }
  throw lastError;
}

async function pool(items, fn, signal) {
  const queue = [...items];
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length && !signal?.aborted) await fn(queue.shift());
  }));
}

// sides maps an image id to where the words sit on the pages that use it (from check.mjs).
// only = { sheets: Set<character id>, images: Set<image id> } repaints just those (an owner's tweak);
// the other model sheets are read from disk and still serve as references.
export async function paintAll(siteDir, images, look, onEvent = () => {}, { signal, usage, sides = {}, only } = {}) {
  const plan = JSON.parse(readFileSync(join(siteDir, 'art/plan.json'), 'utf8'));
  const allCharacters = characterList(plan);
  const characters = only ? allCharacters.filter(c => only.sheets.has(c.id)) : allCharacters;
  const backdrops = only ? plan.images.filter(i => only.images.has(i.id)) : plan.images;
  const results = { painted: [], failed: [], sheets: [] };
  const sheets = new Map();
  if (only) for (const c of allCharacters.filter(c => !only.sheets.has(c.id))) {
    const file = join(siteDir, 'art', `char-${c.id}.webp`);
    if (existsSync(file)) sheets.set(c.id, { id: `char-${c.id}`, name: c.name, data: readFileSync(file) });
  }
  const save = (id, data, started, what) => {
    writeFileSync(join(siteDir, 'art', `${id}.webp`), data);
    onEvent({ stage: 'paint', message: `Painted ${what} (${Math.round(data.length / 1024)} KiB, ${Math.round((Date.now() - started) / 1000)}s)`, image: id });
    if (usage) { usage.images++; onEvent({ stage: 'paint', kind: 'usage', usage: { ...usage } }); }
  };

  if (characters.length) {
    onEvent({ stage: 'paint', message: `Painting ${characters.length} character model sheets with ${images.model}` });
    await pool(characters, async character => {
      const id = `char-${character.id}`;
      const started = Date.now();
      try {
        const data = await withRetries(() => generate(composeCharacterPrompt(plan, character, look), '1024x1024', images, usage));
        save(id, data, started, `the model sheet for ${character.name}`);
        sheets.set(character.id, { id, name: character.name, data });
        results.sheets.push(id);
      } catch (error) {
        onEvent({ stage: 'paint', level: 'warn', message: `Could not paint ${character.name}'s model sheet: ${error.message}. That character will be painted from its description only.` });
      }
    }, signal);
  }

  if (backdrops.length) onEvent({ stage: 'paint', message: `Painting ${backdrops.length} backdrop${backdrops.length === 1 ? '' : 's'}${sheets.size ? ' from the model sheets' : ''}` });
  let editsBroken = false;
  await pool(backdrops, async image => {
    const started = Date.now();
    const refs = editsBroken ? [] : (image.characters || []).map(id => sheets.get(id)).filter(Boolean);
    try {
      let data;
      if (refs.length) {
        try {
          data = await withRetries(() => edit(composePrompt(plan, image, look, { sides: sides[image.id], refs }), '1536x1024', refs, images, usage));
        } catch (error) {
          if (/safety|moderation|content policy/i.test(error.message)) throw error;
          editsBroken = true;
          onEvent({ stage: 'paint', level: 'warn', message: `Painting from model sheets failed (${error.message}); painting from descriptions instead` });
        }
      }
      data ??= await withRetries(() => generate(composePrompt(plan, image, look, { sides: sides[image.id] }), '1536x1024', images, usage));
      save(image.id, data, started, image.id);
      results.painted.push(image.id);
    } catch (error) {
      results.failed.push(image.id);
      onEvent({ stage: 'paint', level: 'warn', message: `Could not paint ${image.id}: ${error.message}` });
    }
  }, signal);
  // The cast page links to every sheet; drop links to sheets that were never painted.
  for (const c of allCharacters) if (!existsSync(join(siteDir, 'art', `char-${c.id}.webp`))) results.failed.push(`char-${c.id}`);
  return results;
}
