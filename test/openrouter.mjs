// Log in with OpenRouter: its provider preset, and the PKCE code exchange against a fake OpenRouter.
import { createServer } from 'node:http';
import { PROVIDERS, parseProviders } from '../server/providers.mjs';

let failures = 0;
const expect = (label, cond, extra = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${cond ? '' : ` ${extra}`}`); if (!cond) failures++; };

expect('OpenRouter is a provider', PROVIDERS.openrouter?.baseUrl === 'https://openrouter.ai/api/v1');
expect('OpenRouter has a default model', PROVIDERS.openrouter?.model === 'openai/gpt-6-luna', PROVIDERS.openrouter?.model);
const { llm, images } = parseProviders({ llm: { api: 'openrouter', model: 'anthropic/claude-sonnet-4.5', apiKey: 'sk-or-v1-12345678' } });
expect('OpenRouter keeps its own base URL', llm.baseUrl === 'https://openrouter.ai/api/v1' && llm.api === 'openrouter');
expect('OpenRouter ignores a base URL the request names',
  parseProviders({ llm: { api: 'openrouter', model: 'openai/gpt-6-luna', apiKey: 'sk-or-v1-12345678', baseUrl: 'https://attacker.example/collect' } }).llm.baseUrl === 'https://openrouter.ai/api/v1');
expect('OpenRouter without an image key draws SVGs', images === null);
expect('OpenRouter paints with an image key', parseProviders({ llm: { api: 'openrouter', model: 'm', apiKey: 'sk-or-v1-12345678' }, images: { apiKey: 'sk-img-12345678' } }).images?.apiKey === 'sk-img-12345678');

let seen = null;
let reply = { status: 200, body: {} };
let keyReply = { status: 200, body: { data: { expires_at: '2099-01-01T00:00:00Z', limit_remaining: 5 } } };
let keyDelay = 0;
let listings = 0;
const catalogue = { data: [
  { id: 'openai/gpt-6-luna', supported_parameters: ['tools'] },
  { id: 'openai/gpt-6-luna:batch', supported_parameters: ['tools'] },
  { id: 'thinkingmachines/inkling-2-mini' },
  { id: 'anthropic/claude-sonnet-5', supported_parameters: ['tools', 'reasoning'] },
  { id: 'acme/picture-only', supported_parameters: ['response_format'] },
] };
let listing = { status: 200, body: catalogue };
const server = createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET' && req.url === '/api/v1/key') {
      seen = { url: req.url, auth: req.headers.authorization };
      return setTimeout(() => { res.statusCode = keyReply.status; res.end(JSON.stringify(keyReply.body)); }, keyDelay);
    }
    if (req.method === 'GET') { listings++; res.statusCode = listing.status; return res.end(JSON.stringify(listing.body)); }
    seen = { url: req.url, body: JSON.parse(body || '{}') };
    res.statusCode = reply.status;
    res.end(JSON.stringify(reply.body));
  });
});
await new Promise(ok => server.listen(0, ok));
process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${server.address().port}`;
const { exchangeCode, keyStatus, listModels } = await import('../server/openrouter.mjs');

const verifier = 'A'.repeat(43);
reply = { status: 200, body: { key: 'sk-or-v1-abcdef123456' } };
const { key } = await exchangeCode({ code: 'a-code-12345678', verifier });
expect('the code is traded for the key', key === 'sk-or-v1-abcdef123456', key);
expect('the exchange posts the verifier with S256', seen.url === '/api/v1/auth/keys' && seen.body.code_verifier === verifier && seen.body.code_challenge_method === 'S256', JSON.stringify(seen));

reply = { status: 403, body: { error: { message: 'Invalid code or code_verifier' } } };
await exchangeCode({ code: 'a-code-12345678', verifier }).then(
  () => expect('a refused exchange fails', false),
  error => expect('a refused exchange keeps the reason', error.message === 'Invalid code or code_verifier' && error.status === 400, error.message));

await exchangeCode({ code: 'a-code-12345678' }).then(
  () => expect('a missing verifier fails', false),
  error => expect('a missing verifier fails before the request', error.status === 400, error.message));

reply = { status: 200, body: { key: 'not a key' } };
await exchangeCode({ code: 'a-code-12345678', verifier }).then(
  () => expect('an unusable key fails', false),
  error => expect('an unusable key fails', error.status === 400, error.message));

listing = { status: 503, body: {} };
await listModels().then(
  () => expect('an unreachable catalogue fails', false),
  error => expect('an unreachable catalogue fails', error.status === 502, error.message));
listing = { status: 200, body: { data: [{ id: 'acme/picture-only', supported_parameters: ['response_format'] }] } };
await listModels().then(
  () => expect('a catalogue without a model that calls tools fails', false),
  error => expect('a catalogue without a model that calls tools fails', error.status === 502, error.message));
listing = { status: 200, body: catalogue };
const models = await listModels();
expect('only models that call tools are listed', models.join(',') === 'openai/gpt-6-luna,anthropic/claude-sonnet-5', models.join(','));
await listModels();
expect('the catalogue is cached', listings === 3, String(listings));

const ping = (key) => keyStatus({ key }).then(status => status, error => ({ error }));
const good = await ping('sk-or-v1-abcdef123456');
expect('the key status asks with the key as a bearer', seen.url === '/api/v1/key' && seen.auth === 'Bearer sk-or-v1-abcdef123456', JSON.stringify(seen));
expect('a usable key reports no expiry trouble', good.ok === true && good.expired === false && good.exhausted === false && good.expiresAt === '2099-01-01T00:00:00Z', JSON.stringify(good));
keyReply = { status: 200, body: { data: { expires_at: '2000-01-01T00:00:00Z', limit_remaining: 5 } } };
expect('an expired key is flagged', (await ping('sk-or-v1-abcdef123456')).expired === true);
keyReply = { status: 200, body: { data: { expires_at: null, limit_remaining: 0 } } };
const spent = await ping('sk-or-v1-abcdef123456');
expect('a key without credit is flagged', spent.exhausted === true && spent.expired === false, JSON.stringify(spent));
keyReply = { status: 401, body: { error: { message: 'Invalid API key' } } };
expect('a rejected key is not usable', (await ping('sk-or-v1-abcdef123456')).ok === false);
keyReply = { status: 503, body: {} };
expect('an unreachable key status fails', (await ping('sk-or-v1-abcdef123456')).error?.status === 502);
seen = null;
keyReply = { status: 200, body: { data: {} } };
expect('a malformed key fails before the request', (await ping('short')).error?.status === 400 && seen === null);

keyDelay = 150;
const flood = await Promise.all(Array.from({ length: 12 }, () => ping('sk-or-v1-abcdef123456')));
expect('a flood of probes stops at the upstream cap',
  flood.filter(r => r.error?.status === 429).length === 4 && flood.filter(r => r.ok === true).length === 8,
  flood.map(r => r.error?.status ?? 'ok').join(','));
keyDelay = 0;

server.close();
console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);