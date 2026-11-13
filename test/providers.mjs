// The key that paints: with OpenAI's own API it is always the model key, never a leftover one.
import { parseProviders, parseImagesOnly } from '../server/providers.mjs';

let failures = 0;
const expect = (label, cond, extra = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${cond ? '' : ` ${extra}`}`); if (!cond) failures++; };
const openai = { api: 'openai-responses', model: 'gpt-x', apiKey: 'sk-model-12345678' };

let { images } = parseProviders({ llm: openai, images: { apiKey: 'sk-stale-12345678' } });
expect('OpenAI model key paints even when a stale image key is sent', images?.apiKey === 'sk-model-12345678', images?.apiKey);
({ images } = parseProviders({ llm: openai }));
expect('OpenAI model key paints without an image key', images?.apiKey === 'sk-model-12345678');
({ images } = parseProviders({ llm: { api: 'anthropic-messages', apiKey: 'sk-ant-12345678' }, images: { apiKey: 'sk-img-12345678' } }));
expect('other providers paint with the image key', images?.apiKey === 'sk-img-12345678');
({ images } = parseProviders({ llm: { api: 'anthropic-messages', apiKey: 'sk-ant-12345678' } }));
expect('other providers without an image key draw SVGs', images === null);
expect('repaint-only uses the image key', parseImagesOnly({ images: { apiKey: 'sk-img-12345678' } })?.apiKey === 'sk-img-12345678');
console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
