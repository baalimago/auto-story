// Image model choice: the key's model list decides, missing models fall back, rejected fields are dropped.
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paintAll, prepareImages } from '../server/paint.mjs';

let failures = 0;
const expect = (label, cond, extra = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${cond ? '' : ` ${extra}`}`); if (!cond) failures++; };

let mode = {};
const calls = [];
const server = createServer((req, res) => {
  let body = '';
  req.setEncoding('latin1');
  req.on('data', c => { body += c; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    const reply = (status, json) => { res.statusCode = status; res.end(JSON.stringify(json)); };
    if (req.method === 'GET') return mode.list ? reply(200, { data: mode.list.map(id => ({ id })) }) : reply(500, { error: { message: 'down' } });
    const fields = req.url.endsWith('generations') ? JSON.parse(body) : Object.fromEntries([...body.matchAll(/name="([^"]+)"\r\n\r\n([^\r]*)/g)].map(m => [m[1], m[2]]));
    calls.push({ url: req.url, model: fields.model, format: fields.output_format });
    if (!mode.works.includes(fields.model)) return reply(404, { error: { message: `The model '${fields.model}' does not exist.` } });
    if (mode.noWebp && fields.output_format) return reply(400, { error: { message: "Unknown parameter: 'output_format'.", param: 'output_format' } });
    reply(200, { data: [{ b64_json: Buffer.from('img').toString('base64') }] });
  });
});
await new Promise(ok => server.listen(0, ok));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const look = { directive: 'watercolor', color: 'color' };

function site() {
  const dir = mkdtempSync(join(tmpdir(), 'paint-'));
  mkdirSync(join(dir, 'art'));
  writeFileSync(join(dir, 'art', 'plan.json'), JSON.stringify({
    style: 'soft watercolor with warm light and gentle paper texture throughout',
    characters: [{ id: 'tod', name: 'Tod', look: 'a small round beaver with a red scarf and big friendly eyes, always carrying a pencil' }],
    images: [{ id: 'lodge', characters: ['tod'], prompt: 'Tod builds a lodge by the river at dawn' }],
  }));
  return dir;
}

// 1. The key lists a newer preferred model: that one paints, no failed calls.
mode = { list: ['dall-e-3', 'gpt-image-2.6-flare', 'gpt-image-1'], works: ['gpt-image-2.6-flare', 'gpt-image-1'] };
let images = { baseUrl, apiKey: 'k-12345678', model: 'gpt-image-2.6-sunburst' };
let dir = site();
let r = await paintAll(dir, images, look);
expect('picks the best model the key lists', images.model === 'gpt-image-2.6-flare' && calls.every(c => c.model === 'gpt-image-2.6-flare'), JSON.stringify(calls));
expect('both pictures painted', r.painted.includes('lodge') && existsSync(join(dir, 'art', 'char-tod.webp')), JSON.stringify(r));

// 2. No model list (endpoint down): a missing model falls back to the next one while painting.
calls.length = 0;
mode = { list: null, works: ['gpt-image-1.5'] };
images = { baseUrl, apiKey: 'k-12345678', model: 'gpt-image-2.6-sunburst' };
r = await paintAll(site(), images, look);
expect('falls back past missing models', images.model === 'gpt-image-1.5' && r.painted.includes('lodge'), `${images.model} ${JSON.stringify(r.errors)}`);

// 3. A model that rejects webp output: the field is dropped and the picture still paints.
calls.length = 0;
mode = { list: ['gpt-image-1'], works: ['gpt-image-1'], noWebp: true };
images = { baseUrl, apiKey: 'k-12345678', model: 'gpt-image-2.6-sunburst' };
r = await paintAll(site(), images, look);
expect('drops a rejected field and paints', r.painted.includes('lodge') && calls.at(-1).format === undefined, JSON.stringify(calls));

// 4. A listed model is preferred over the configured default even if newer ones are unlisted.
mode = { list: ['gpt-image-1'], works: ['gpt-image-1'] };
images = { baseUrl, apiKey: 'k-12345678', model: 'gpt-image-2.6-sunburst' };
const prepared = await prepareImages(images);
expect('only a listed model is used', prepared.model === 'gpt-image-1' && prepared.listed, JSON.stringify(prepared));

server.close();
console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
