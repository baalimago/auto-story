// Shelves and build logs are private per Wasmer account. Runs on plain Node against a fake registry:
//   node test/private_shelf.mjs
import http from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const users = {
  'wap_alice_token_0000000000': { id: 'VXNlcjox', username: 'alice' },
  'wap_bob_token_00000000000000': { id: 'VXNlcjoy', username: 'bob' },
};
const registry = http.createServer((req, res) => {
  const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
  const user = users[token];
  res.setHeader('content-type', 'application/json');
  req.resume().on('end', () => res.end(JSON.stringify({ data: { viewer: user ? { ...user, namespaces: { edges: [] } } : null } })));
});
await new Promise(r => registry.listen(0, r));

const data = mkdtempSync(join(tmpdir(), 'auto-story-'));
mkdirSync(join(data, 'stories'), { recursive: true });
mkdirSync(join(data, 'builds', '20261113-aaaaaa'), { recursive: true });
// A book from before private shelves, and a build log for alice.
writeFileSync(join(data, 'stories', '20261101-legacy.json'), JSON.stringify({ id: '20261101-legacy', title: 'Old Raft', user: 'Alice', createdAt: '2026-11-01T00:00:00Z', url: 'https://x' }));
writeFileSync(join(data, 'builds', '20261113-aaaaaa', 'meta.json'), JSON.stringify({ id: '20261113-aaaaaa', user: 'alice', account: 'wasmer:VXNlcjox', title: 't' }));
writeFileSync(join(data, 'builds', '20261113-aaaaaa', 'events.ndjson'), JSON.stringify({ at: Date.now(), stage: 'done', message: 'secret result' }) + '\n');
mkdirSync(join(data, 'builds', '20261113-aaaaaa', 'transcripts'));
writeFileSync(join(data, 'builds', '20261113-aaaaaa', 'transcripts', '01-brief.ndjson'), [
  { type: 'run', role: 'Analyst', stage: 'understand', model: 'm', api: 'openai-responses', input: 'INPUT {}' },
  { type: 'session_info', model: { id: 'm' }, systemPrompt: 'secret system prompt' },
  { type: 'message_end', message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'thinking', thinking: 'secret thought' }, { type: 'text', text: 'Reading.' }] } },
  { type: 'tool_execution_start', toolName: 'bash', args: { command: 'ls source' } },
  { type: 'tool_execution_end', toolName: 'bash', isError: false, result: { content: [{ type: 'text', text: 'part-01.txt' }] } },
  { type: 'exit', code: 0, ok: true, messages: 1, bashCalls: 1, stopReason: 'stop' },
].map(e => JSON.stringify(e)).join('\n') + '\n');

process.env.DATA_DIR = data;
process.env.PORT = '18089';
process.env.PUBLIC_DIR = new URL('../public', import.meta.url).pathname;
process.env.WASMER_REGISTRY_URL = `http://127.0.0.1:${registry.address().port}/graphql`;
await import('../server/server.mjs');
await new Promise(r => setTimeout(r, 200));

const call = (path, token, init = {}) => fetch(`http://127.0.0.1:18089${path}`, {
  ...init, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers || {}) },
});
const [alice, bob] = Object.keys(users);

assert.equal((await call('/api/stories')).status, 401, 'anonymous shelf is refused');

const a = await (await call('/api/stories', alice)).json();
assert.deepEqual(a.stories.map(s => s.title), ['Old Raft'], 'alice adopts her legacy book');
assert.ok(!('account' in a.stories[0]), 'account key is not exposed');
assert.ok(!existsSync(join(data, 'stories', '20261101-legacy.json')), 'legacy file moved');

const b = await (await call('/api/stories', bob)).json();
assert.deepEqual(b.stories, [], 'bob sees nothing of alice');

assert.equal((await call('/api/builds/20261113-aaaaaa/events')).status, 401, 'anonymous log refused');
assert.equal((await call('/api/builds/20261113-aaaaaa/events', bob)).status, 404, 'bob cannot read alice log');
const log = await (await call('/api/builds/20261113-aaaaaa/events', alice)).text();
assert.match(log, /secret result/, 'alice reads her own log');

assert.equal((await call('/api/builds/20261113-aaaaaa/transcripts')).status, 401, 'anonymous transcripts refused');
assert.equal((await call('/api/builds/20261113-aaaaaa/transcripts', bob)).status, 404, 'bob cannot list alice transcripts');
assert.equal((await call('/api/builds/20261113-aaaaaa/transcripts.zip', bob)).status, 404, 'bob cannot download alice transcripts');
const list = await (await call('/api/builds/20261113-aaaaaa/transcripts', alice)).json();
assert.deepEqual(list.transcripts.map(t => [t.name, t.role]), [['transcripts/01-brief.ndjson', 'Analyst']], 'alice lists her transcripts');
const readable = await (await call(`/api/builds/20261113-aaaaaa/transcripts/${encodeURIComponent('transcripts/01-brief.txt')}`, alice)).text();
for (const bit of ['secret system prompt', 'secret thought', 'ls source', 'part-01.txt', 'exit 0']) assert.ok(readable.includes(bit), `readable transcript shows ${bit}`);
assert.equal((await call(`/api/builds/20261113-aaaaaa/transcripts/${encodeURIComponent('../meta.json')}`, alice)).status, 404, 'no path tricks');
const zip = await call('/api/builds/20261113-aaaaaa/transcripts.zip', alice);
assert.equal(zip.headers.get('content-type'), 'application/zip');
const zipText = Buffer.from(await zip.arrayBuffer()).toString('latin1');
for (const f of ['20261113-aaaaaa/events.ndjson', '20261113-aaaaaa/transcripts/01-brief.ndjson', '20261113-aaaaaa/transcripts/01-brief.txt']) assert.ok(zipText.includes(f), `zip has ${f}`);

const abort = await call('/api/builds/20261113-aaaaaa/abort', bob, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
assert.equal(abort.status, 403, 'bob cannot abort alice build');

const who = await (await call('/api/auth/token', null, { method: 'POST', body: JSON.stringify({ token: alice }), headers: { 'content-type': 'application/json' } })).json();
assert.deepEqual(Object.keys(who.user).sort(), ['allowed', 'namespaces', 'username']);

console.log('private shelf: all checks passed');
process.exit(0);
