// Offline test of the owner's edit view with a scripted stand-in for Pi and a fake Wasmer registry:
// build -> board -> tweak a character's look (rebuild, repaint only what changed, redeploy the same app)
// -> repaint one picture -> roll back -> another account sees none of it.
// Usage: node test/edit.mjs   (from the repo root)
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = resolve(new URL('..', import.meta.url).pathname);
const tmp = mkdtempSync(join(tmpdir(), 'pipeline-'));
const fixtures = join(tmp, 'fixtures');
mkdirSync(fixtures);
const raft = readFileSync(join(root, 'test/fixtures/raft.md'), 'utf8');
const ev = quote => ({ part: 'part-01', quote });
const brief = {
  topic: 'How a group of computers agrees on one list of commands even when some crash.',
  question: 'How can a team of computers agree on the same list when some of them break?',
  answer: 'They elect one leader that writes the list, and an entry only counts once most of the team has copied it.',
  concepts: [
    { id: 'roles', name: 'One leader', plain: 'One computer is the boss of the list and the others copy what it says.', precise: 'Each server is a leader, follower or candidate; one leader handles all client requests.', how: ['one leader'], depends_on: [], evidence: [ev('each server is in one of three states: leader, follower, or candidate')] },
    { id: 'election', name: 'Elections', plain: 'If the boss goes quiet, someone asks for votes and wins with more than half.', precise: 'Followers time out, become candidates and win with a majority.', how: ['timeout', 'votes'], depends_on: ['roles'], evidence: [ev('A candidate wins if it receives votes from a majority of the servers in the full cluster.')] },
    { id: 'replication', name: 'Copying the list', plain: 'The boss sends each new line to everyone and it counts once most have it.', precise: 'The leader appends entries and replicates them with AppendEntries.', how: ['append', 'send'], depends_on: ['election'], evidence: [ev('The leader appends the command to its log as a new entry')] },
  ],
  facts: [{ claim: 'Random timeouts', ...ev('for example 150 to 300 milliseconds') }],
  misconceptions: [{ wrong: 'Everyone votes on every entry.', right: 'Only the leader proposes.' }],
  left_out: [], coverage: [{ part: 'part-01', gist: 'The whole Raft summary.', quote: 'Raft is a consensus algorithm for managing a replicated log.' }],
};
const page = (idea, text, extra = {}) => ({ idea, scene: 'lodge', side: 'left', text, teaches: 'Something new.', note: 'Grown-up detail.', ...extra });
const script = {
  title: 'The Busy Beavers', subtitle: 'Who keeps the list?', question: brief.question, answer: brief.answer,
  metaphor: { world: 'A beaver lodge that keeps one shared building plan.', map: brief.concepts.map(c => ({ concept: c.id, thing: 'x', behaves: 'y', mirrors: 'z', breaks: 'w' })) },
  ideas: [{ id: 'boss', title: 'One boss', text: 'One beaver keeps the plan.', concepts: ['roles'] }, { id: 'vote', title: 'Voting', text: 'Votes pick a new boss.', concepts: ['election'] }, { id: 'copy', title: 'Copying', text: 'Copies make it count.', concepts: ['replication'] }],
  characters: [{ id: 'bea', name: 'Bea', is: 'The leader', personality: 'Fair', look: 'A plump brown beaver about knee high, with a green woollen cap, a pencil behind her ear and a white chest patch.' },
               { id: 'tod', name: 'Tod', is: 'A follower', personality: 'Curious', look: 'A thin young beaver with sandy fur, round red glasses, a striped blue scarf and a satchel of bark sheets.' }],
  scenes: [{ id: 'cover', characters: ['bea', 'tod'], shows: 'The two beavers on a lodge roof at dusk, the river on the right calm and empty.' },
           { id: 'lodge', characters: ['bea'], shows: 'Inside the lodge, Bea at a bark table; the left side is a calm plain wooden wall.' }],
  pages: [{ scene: 'cover', side: 'right', text: 'The beavers have one plan.' },
    page('boss', 'Bea keeps the plan.', { interaction: { type: 'compare', plan: 'With a boss vs without: chips show the order of logs.' } }), page('boss', 'Everyone copies Bea.'),
    page('vote', 'Bea fell asleep.'), page('vote', 'Tod asked for votes.', { interaction: { type: 'stepper', plan: 'Timeout, ask for votes, count to three of five, win.' } }),
    page('copy', 'Bea sends each line.'), page('copy', 'Three of five have it.'), page('copy', 'Now you know.', { interaction: { type: 'quiz', plan: 'When does a line count? When most have copied it.' } })],
};
const widget = {
  compare: { type: 'compare', title: 'Boss or no boss?', a: { label: 'No boss', caption: 'Everyone builds in a different order.' }, b: { label: 'One boss', caption: 'Everyone follows one plan.' } },
  stepper: { type: 'stepper', title: 'Follow the vote', steps: [{ label: 'Quiet', caption: 'Bea stops calling.' }, { label: 'Votes', caption: 'Tod wins three of five.' }] },
  quiz: { type: 'quiz', title: 'Quick check', question: 'When does a line count?', choices: [{ text: 'When Bea writes it', correct: false, why: 'Most must copy it first.' }, { text: 'When most have copied it', correct: true, why: 'That is the majority rule.' }] },
};
const story = {
  title: script.title, subtitle: script.subtitle, byline: 'A picture book about Raft', question: script.question, answer: script.answer,
  ideas: script.ideas.map(({ id, title, text }) => ({ id, title, text })), theme: 'watercolor', noteLabel: 'For grown-ups',
  pages: script.pages.map(p => ({ idea: p.idea, art: p.scene, side: p.side, text: p.text, note: p.note, alt: 'A beaver lodge', ...(p.interaction ? { widget: widget[p.interaction.type] } : {}) })),
  cast: [{ name: 'Bea', is: 'The leader', explain: 'Keeps the plan.', art: 'char-bea' }, { name: 'Tod', is: 'A follower', explain: 'Copies the plan.', art: 'char-tod' }, { name: 'The plan', is: 'The replicated log', explain: 'One list for all.' }],
};
const artPlan = { style: "gentle watercolor and ink children's picture book illustration, river light",
  characters: script.characters.map(({ id, name, look }) => ({ id, name, look })),
  images: script.scenes.map(s => ({ id: s.id, characters: s.characters, prompt: s.shows })) };
writeFileSync(join(fixtures, 'brief.json'), JSON.stringify(brief));
writeFileSync(join(fixtures, 'script.json'), JSON.stringify(script));
writeFileSync(join(fixtures, 'story.js'), `export default ${JSON.stringify(story, null, 2)};\n`);
writeFileSync(join(fixtures, 'plan.json'), JSON.stringify(artPlan));

// A copy of the server whose pi_entry.mjs plays every role from the fixtures.
const app = join(tmp, 'app');
cpSync(join(root, 'server'), app, { recursive: true });
cpSync(join(root, 'agent'), join(tmp, 'agent'), { recursive: true });
writeFileSync(join(app, 'pi_entry.mjs'), `
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
const [systemPath, inputPath] = process.argv.slice(2);
const role = basename(systemPath, '.md');
const input = JSON.parse(readFileSync(inputPath, 'utf8').replace(/^INPUT\\n/, ''));
const F = ${JSON.stringify(fixtures)};
const ws = input.paths.workspace;
const out = o => process.stdout.write(JSON.stringify(o) + '\\n');
out({ type: 'agent_start' });
const qs = Array.from({ length: 10 }, (_, i) => ({ asked_by: i % 2 ? 'child' : 'expert', question: 'Why?', brief_answer: 'Because.', source_answer: 'Because.', part: 'part-01', ok: true }));
if (role === 'analyst') { const b = JSON.parse(readFileSync(join(F, 'brief.json'), 'utf8')); if (input.revise) b.answer += ' Revised.'; writeFileSync(join(ws, 'brief.json'), JSON.stringify(b)); }
if (role === 'examiner') {
  const first = !existsSync(join(ws, 'reviews', 'brief-1.json'));
  writeFileSync(input.review, JSON.stringify(first
    ? { verdict: 'revise', summary: 'The answer misses why a majority matters.', questions: qs, issues: [{ severity: 'major', where: 'answer', problem: 'Vague', fix: 'Say why' }] }
    : { verdict: 'pass', summary: 'Clear and accurate now.', questions: qs, issues: [] }));
}
if (role === 'writer') copyFileSync(join(F, 'script.json'), join(ws, 'script.json'));
if (role === 'critic') writeFileSync(input.review, JSON.stringify({ verdict: 'pass', summary: 'A child would get it.', issues: [], reader_test: [1, 2, 3, 4].map(() => ({ question: 'Q', answer_from_pages: 'A', correct: true })) }));
if (role === 'builder') {
  const s = JSON.parse(readFileSync(join(ws, 'script.json'), 'utf8'));
  const plan = JSON.parse(readFileSync(join(F, 'plan.json'), 'utf8'));
  plan.characters = s.characters.map(({ id, name, look }) => ({ id, name, look }));
  writeFileSync(join(ws, 'site', 'art', 'plan.json'), JSON.stringify(plan));
  writeFileSync(join(ws, 'site', 'story.js'), readFileSync(join(F, 'story.js'), 'utf8').replace('"The Busy Beavers"', JSON.stringify(s.title)));
  if (input.owner_notes) writeFileSync(join(ws, 'owner_notes_seen.txt'), input.owner_notes);
  writeFileSync(join(ws, 'site', 'scenes.js'), 'export default {};');
  writeFileSync(join(ws, 'site', 'story.css'), '');
}
const final = role === 'builder' ? { title: JSON.parse(readFileSync(join(ws, 'script.json'), 'utf8')).title, summary: 'Beavers explain Raft.' } : { done: role };
out({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify(final) }], usage: { input: 10, output: 5 } } });
out({ type: 'agent_end' });
`);


// Fake image API: records what was painted.
const painted = [];
const imageApi = createServer((req, res) => {
  let body = '';
  req.setEncoding('latin1');
  req.on('data', c => { body += c; });
  req.on('end', () => {
    if (req.method === 'GET') { res.setHeader('content-type', 'application/json'); return res.end('{"data":[]}'); }
    const prompt = req.url.includes('generations') ? JSON.parse(body).prompt : (body.match(/name="prompt"\r\n\r\n([\s\S]*?)\r\n--/) || [])[1] || '';
    painted.push(prompt.includes('Character model sheet') ? `sheet:${prompt.match(/model sheet for (\w+)/)[1]}` : `scene:${prompt.match(/Scene: ([^\n]*)/)[1].slice(0, 20)}`);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ b64_json: Buffer.from(`img-${painted.length}`).toString('base64') }] }));
  });
});
await new Promise(ok => imageApi.listen(0, ok));

// Fake Wasmer: whoami, signed upload, autobuild, and the deployed app itself.
const users = { 'wap_alice_token_0000000000': { id: 'VXNlcjox', username: 'alice' }, 'wap_bob_token_00000000000000': { id: 'VXNlcjoy', username: 'bob' } };
const deploys = [];
let reg;
const artChecks = [];
const registry = createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const base = `http://127.0.0.1:${reg.address().port}`;
    res.setHeader('content-type', 'application/json');
    if (req.method === 'PUT') { deploys.push({ size: body.length, stamped: /id="art-versions">{"[a-z0-9-]+":"[0-9a-f]{10}"/.test(body), engine: body.includes('const artUrl = ') }); return res.end('{}'); }
    if (req.url.startsWith('/app/')) { res.setHeader('x-edge-app-version-id', `v${deploys.length}`); if (/\/art\/[^?]+\.webp\?v=/.test(req.url)) { artChecks.push(req.url); res.setHeader('content-type', 'image/webp'); return res.end('img'); } return res.end('{}'); }
    const { query, variables } = JSON.parse(body || '{}');
    const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
    let data;
    if (query.includes('viewer')) data = { viewer: users[token] ? { ...users[token], namespaces: { edges: [] } } : null };
    else if (query.includes('generateUploadUrl')) data = { generateUploadUrl: { signedUrl: { url: `${base}/upload/${variables.name}` } } };
    else if (query.includes('autobuildConfigForZipUpload')) data = { autobuildConfigForZipUpload: { buildConfig: { presetName: 'static-website' } } };
    else if (query.includes('deployViaAutobuild')) { deploys.at(-1).app = variables.appName; data = { deployViaAutobuild: { success: true, buildId: '00000000-0000-0000-0000-000000000000' } }; }
    else if (query.includes('autobuildDeploymentStatus')) data = { autobuildDeploymentStatus: { status: 'SUCCESS', appVersion: { id: `v${deploys.length}`, url: `${base}/app/x`, app: { id: 'app1', url: `${base}/app/x` } } } };
    else if (query.includes('getDeployApp')) data = { getDeployApp: { id: 'app1', url: `${base}/app/${variables.name}`, adminUrl: null } };
    res.end(JSON.stringify({ data }));
  });
});
reg = registry;
await new Promise(ok => registry.listen(0, ok));

Object.assign(process.env, { DATA_DIR: join(tmp, 'data'), AGENT_DIR: join(tmp, 'agent'), NODE_BIN: process.execPath, WORK_ROOT: join(tmp, 'work'),
  OPENAI_IMAGES_BASE_URL: `http://127.0.0.1:${imageApi.address().port}`, WASMER_REGISTRY_URL: `http://127.0.0.1:${registry.address().port}/graphql`, PORT: '18097', PUBLIC_DIR: join(root, 'public') });
writeFileSync(join(app, 'allowlist.json'), JSON.stringify({ users: ['alice', 'bob'], namespaces: [] }));
const { startBuild } = await import(join(app, 'build.mjs'));
await import(join(app, 'server.mjs'));
await new Promise(r => setTimeout(r, 200));
const [alice, bob] = Object.keys(users);
const imageKeys = { baseUrl: `http://127.0.0.1:${imageApi.address().port}`, apiKey: 'k-fake-1234567890', model: 'gpt-image-1' };
const done = job => new Promise(ok => job.listeners.add(e => { if (!e) ok(); }));

// 1. The first edition.
const job = startBuild({
  user: { username: 'alice', account: 'wasmer:VXNlcjox' }, title: 'Raft', filename: 'raft.md', text: raft,
  llm: { api: 'openai-responses', model: 'fake', apiKey: 'sk-fake-1234567890' }, images: { ...imageKeys },
  wasmerToken: alice, look: { style: 'picturebook', theme: 'watercolor', color: 'color', label: 'test', directive: 'watercolor' },
});
await done(job);
assert.equal(job.status, 'done', job.error);
const appName = job.result.appName;
painted.length = 0;

const call = async (path, token, body) => {
  const res = await fetch(`http://127.0.0.1:18097${path}`, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  if (!res.headers.get('content-type')?.includes('ndjson')) return { status: res.status, json: await res.json() };
  const events = (await res.text()).trim().split('\n').map(l => JSON.parse(l));
  return { status: res.status, events, end: events.at(-1) };
};
let failures = 0;
const expect = (label, cond, extra = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${cond ? '' : ` ${extra}`}`); if (!cond) failures++; };

// 2. The board.
let board = (await call(`/api/stories/${job.id}/board`, alice)).json;
expect('board has brief, script, plan and art', board.editable && board.brief.concepts.length === 3 && board.script.characters.length === 2 && board.art.includes('char-bea.webp'), JSON.stringify(board).slice(0, 300));
expect('first edition is version 1', board.version === 1 && board.versions.length === 1);
expect('bob cannot see alice\'s board', (await call(`/api/stories/${job.id}/board`, bob)).status === 404);
expect('bob cannot tweak alice\'s book', (await call(`/api/stories/${job.id}/tweaks`, bob, { message: 'hi', llm: { api: 'openai-responses', apiKey: 'sk-fake-1234567890' } })).status === 404);

// 3. Tweak: give Tod a new look and ask for a change. Only Tod's sheet and the scenes Tod is in are repainted.
const edited = structuredClone(board.script);
edited.characters[1].look = 'A thin young beaver with sandy fur, square purple glasses, a yellow raincoat and a satchel of bark sheets.';
edited.title = 'The Busy Beavers Return';
const llm = { api: 'openai-responses', baseUrl: 'https://api.openai.com/v1', model: 'fake', apiKey: 'sk-fake-1234567890' };
let r = await call(`/api/stories/${job.id}/tweaks`, alice, { message: 'Make Tod braver.', script: edited, llm });
expect('tweak finishes', r.end?.stage === 'done', JSON.stringify(r.end || r.json));
const roles = r.events.filter(e => e.kind === 'start').map(e => e.role);
expect('script edit re-runs only the builder', roles.join(',') === 'Builder', roles.join(','));
expect('only Tod and the scene he is in are repainted', painted.sort().join(',') === 'scene:The two beavers on a,sheet:Tod', painted.join(','));
expect('redeployed to the same app', deploys.at(-1).app === appName, JSON.stringify(deploys.at(-1)));
board = (await call(`/api/stories/${job.id}/board`, alice)).json;
expect('tweak is version 2 with the edit', board.version === 2 && board.versions[0].message === 'Make Tod braver.' && board.script.characters[1].look.includes('purple'));
expect('shelf shows the new title', board.story.title === 'The Busy Beavers Return' && board.story.version === 2, board.story.title);

// 4. A second tweak hears about the first.
painted.length = 0;
r = await call(`/api/stories/${job.id}/tweaks`, alice, { message: 'Shorter sentences.', llm });
expect('message-only tweak finishes with nothing repainted', r.end.stage === 'done' && painted.length === 0, JSON.stringify(r.end) + painted);
const notes = readdirSync(join(tmp, 'data', 'builds')).length;
expect('earlier requests reach the builder', r.events.some(e => e.stage === 'prepare' && /Your request: Shorter/.test(e.message)) && notes > 0);

// 5. Repaint one picture, no model needed (called directly, so the painter can point at the fake image API).
painted.length = 0;
const { startTweak } = await import(join(app, 'edit.mjs'));
const repaint = startTweak({ user: { username: 'alice', account: 'wasmer:VXNlcjox' }, wasmerToken: alice, id: job.id, body: { repaint: ['lodge'] }, llm: null, images: { ...imageKeys } });
await done(repaint);
expect('repaint-only runs no agent and paints just that picture', repaint.status === 'done' && painted.join(',') === 'scene:Inside the lodge, Be', `${repaint.error} ${painted}`);
expect('a model-less request with nothing to repaint is refused', (await call(`/api/stories/${job.id}/tweaks`, alice, {})).status === 400);

// 5b. Chat with the editor agent (a fake Chat Completions model): its edits stream back and protected fields stay put.
const seen = [];
const model = createServer((req, res) => {
  let raw = ''; req.on('data', c => raw += c); req.on('end', () => {
    const body = JSON.parse(raw); seen.push(body);
    const last = body.messages.at(-1);
    const message = last.role === 'tool' ? { role: 'assistant', content: 'Tod now wears a green scarf, and I marked his sheet for repainting.' }
      : { role: 'assistant', content: null, tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'edit', arguments: JSON.stringify({ changes: [
            { file: 'script', path: 'characters.1.look', value: 'A thin young beaver with sandy fur, a green scarf and a satchel.' },
            { file: 'brief', path: 'concepts.0.evidence', value: [] },
            { file: 'script', path: 'pages.8', value: { scene: 'lodge', side: 'left', idea: 'copy', text: 'The end.' } }] }) } },
          { id: 'c2', type: 'function', function: { name: 'mark_repaint', arguments: JSON.stringify({ ids: ['char-tod'] }) } }] };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message }], usage: {} }));
  });
});
await new Promise(ok => model.listen(0, ok));
const chatLlm = { api: 'openai-completions', baseUrl: `http://127.0.0.1:${model.address().port}/v1`, model: 'fake', apiKey: 'sk-fake-1234567890' };
r = await call(`/api/stories/${job.id}/chat`, alice, { messages: [{ role: 'user', text: 'Give Tod a green scarf' }], llm: chatLlm });
const edits = (r.events || []).filter(e => e.type === 'edit');
expect('chat streams the edits it makes', edits.length === 2 && edits[0].path === 'characters.1.look' && edits[1].path === 'pages.8', JSON.stringify(r.events || r.json));
expect('chat cannot touch evidence', !edits.some(e => e.file === 'brief') && seen[1].messages.at(-2).content.includes('protected'), JSON.stringify(seen[1]?.messages.slice(-2)));
expect('chat marks pictures and replies', r.events.some(e => e.type === 'repaint' && e.ids.includes('char-tod')) && r.events.some(e => e.type === 'text' && /green scarf/.test(e.text)));
expect('chat returns the edited files', r.end.type === 'done' && r.end.script.characters[1].look.includes('green') && r.end.script.pages.length === 9 && r.end.brief.concepts[0].evidence.length === 1);
expect('chat sees the board in the system prompt', seen[0].messages[0].role === 'system' && seen[0].messages[0].content.includes('The Busy Beavers'));
expect('bob cannot chat about alice\'s book', (await call(`/api/stories/${job.id}/chat`, bob, { messages: [{ role: 'user', text: 'hi' }], llm: chatLlm })).status === 404);
const before = (await call(`/api/stories/${job.id}/board`, alice)).json;
expect('chatting changes nothing until a rebuild', !before.script.characters[1].look.includes('green') && before.script.pages.length === 8, before.script.characters[1].look);
model.close();

// 6. Roll back to version 1.
r = await call(`/api/stories/${job.id}/rollback`, alice, { version: 1 });
expect('rollback finishes', r.end.stage === 'done', JSON.stringify(r.end));
expect('deploys stamp picture versions and pack the current engine', deploys.length > 1 && deploys.every(d => d.stamped && d.engine), JSON.stringify(deploys));
expect('each deploy fetches a live picture', artChecks.length >= deploys.length, artChecks.join(','));
board = (await call(`/api/stories/${job.id}/board`, alice)).json;
const last = board.versions[0];
expect('versions so far: build, 2 tweaks, repaint, rollback', board.versions.length === 5, board.versions.length);
expect('rollback is a new version with the old script', last.kind === 'rollback' && last.to === 1 && board.script.title === 'The Busy Beavers' && board.story.title === 'The Busy Beavers', JSON.stringify(last));
expect('nothing to change is refused', (await call(`/api/stories/${job.id}/tweaks`, alice, { llm })).status === 400);

if (process.env.KEEP) { console.log(`KEEP ${alice} ${job.id}`); await new Promise(() => {}); }
imageApi.close(); registry.close();
console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
