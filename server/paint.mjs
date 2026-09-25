// Paints art/plan.json backdrops with the OpenAI Images API.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';

const CONCURRENCY = 4;

export function composePrompt(plan, image, look) {
  return [
    `Art style, follow strictly: ${look.directive}`,
    plan.style.trim(),
    `Recurring characters, drawn the same way every time: ${plan.characters.trim()}`,
    `Scene: ${image.prompt.trim()}`,
    'Wide landscape 3:2 illustration, one single image (no panel grid). No text, letters, numbers, speech bubbles, signs, captions, or watermarks anywhere.',
    look.color === 'bw' ? 'Colour rule overrides any colours named above: black and white only.' : '',
  ].filter(Boolean).join('\n\n');
}

async function paintOne(prompt, images, usage) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(`${images.baseUrl}/images/generations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${images.apiKey}` },
        body: JSON.stringify({
          model: images.model, prompt, n: 1, size: '1536x1024',
          quality: config.imageQuality, output_format: 'webp', output_compression: 82,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error?.message || `HTTP ${response.status}`);
      if (usage && body.usage) { usage.imageTokens += body.usage.total_tokens || 0; }
      const b64 = body.data?.[0]?.b64_json;
      if (!b64) throw new Error('No image data returned');
      return Buffer.from(b64, 'base64');
    } catch (error) {
      lastError = error;
      if (/safety|moderation|content policy/i.test(error.message)) break;
      await new Promise(r => setTimeout(r, attempt * 3000));
    }
  }
  throw lastError;
}

export async function paintAll(siteDir, images, look, onEvent = () => {}, { signal, usage } = {}) {
  const plan = JSON.parse(readFileSync(join(siteDir, 'art/plan.json'), 'utf8'));
  const queue = [...plan.images];
  const results = { painted: [], failed: [] };
  onEvent({ stage: 'paint', message: `Painting ${queue.length} backdrops with ${images.model}` });
  async function worker() {
    while (queue.length && !signal?.aborted) {
      const image = queue.shift();
      const started = Date.now();
      try {
        const data = await paintOne(composePrompt(plan, image, look), images, usage);
        if (usage) { usage.images++; onEvent({ stage: 'paint', kind: 'usage', usage: { ...usage } }); }
        writeFileSync(join(siteDir, 'art', `${image.id}.webp`), data);
        results.painted.push(image.id);
        onEvent({ stage: 'paint', message: `Painted ${image.id} (${Math.round(data.length / 1024)} KiB, ${Math.round((Date.now() - started) / 1000)}s)`, image: image.id });
      } catch (error) {
        results.failed.push(image.id);
        onEvent({ stage: 'paint', level: 'warn', message: `Could not paint ${image.id}: ${error.message}` });
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return results;
}
