// Offline end-to-end run of the staged build with a scripted stand-in for Pi:
// analyst -> examiner (sends it back once) -> analyst revises -> examiner passes -> writer -> critic -> builder -> check -> paint.
// The deploy step then fails without a registry, which is where this test stops.
// Usage: node test/pipeline.mjs   (from the repo root)
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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
out({ type: 'session_info', model: { id: 'fake' }, note: 'fake endpoint', systemPrompt: readFileSync(systemPath, 'utf8') });
out({ type: 'agent_start' });
out({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'ls' } });
out({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'bash', isError: false, result: { content: [{ type: 'text', text: 'brief.json' }] } });
process.stderr.write('a warning on stderr\\n');
const qs = Array.from({ length: 10 }, (_, i) => ({ asked_by: i % 2 ? 'child' : 'expert', question: 'Why?', brief_answer: 'Because.', source_answer: 'Because.', part: 'part-01', ok: true }));
if (role === 'analyst') { const b = JSON.parse(readFileSync(join(F, 'brief.json'), 'utf8')); if (input.revise) b.answer += ' Revised.'; writeFileSync(join(ws, 'brief.json'), JSON.stringify(b)); }
if (role === 'examiner') {
  const first = !existsSync(join(ws, 'reviews', 'brief-1.json'));
  writeFileSync(input.review, JSON.stringify(first
    ? { verdict: 'revise', summary: 'The answer misses why a majority matters.', questions: qs, issues: [{ severity: 'major', where: 'answer', problem: 'Vague', fix: 'Say why' }] }
    : { verdict: 'pass', summary: 'Clear and accurate now.', questions: qs, issues: [] }));
}
if (role === 'writer') copyFileSync(join(F, 'script.json'), join(ws, 'script.json'));
if (role === 'critic') writeFileSync(join(ws, 'reviews', 'draft.txt'), 'scratch');
if (role === 'critic') writeFileSync(input.review, JSON.stringify({ verdict: 'pass', summary: 'A child would get it.', issues: [], reader_test: [1, 2, 3, 4].map(() => ({ question: 'Q', answer_from_pages: 'A', correct: true })) }));
if (role === 'builder') {
  copyFileSync(join(F, 'story.js'), join(ws, 'site', 'story.js'));
  copyFileSync(join(F, 'plan.json'), join(ws, 'site', 'art', 'plan.json'));
  writeFileSync(join(ws, 'site', 'scenes.js'), 'export default {};');
  writeFileSync(join(ws, 'site', 'story.css'), '');
}
const final = role === 'builder' ? { title: 'The Busy Beavers', summary: 'Beavers explain Raft.' } : { done: role };
out({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify(final) }], usage: { input: 10, output: 5 } } });
out({ type: 'agent_end' });
`);

const images = [];
let refuseImages = false, refuseKey = false;
const server = createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET') { res.statusCode = refuseKey ? 401 : 200; return res.end(JSON.stringify(refuseKey ? { error: { message: 'Your API key has been invalidated.' } } : { data: [] })); }
    images.push(req.url);
    if (refuseImages) { res.statusCode = 403; return res.end(JSON.stringify({ error: { message: 'Your organization must be verified to use this model' } })); }
    res.end(JSON.stringify({ data: [{ b64_json: Buffer.from('img').toString('base64') }] }));
  });
});
await new Promise(ok => server.listen(0, ok));
Object.assign(process.env, { DATA_DIR: join(tmp, 'data'), AGENT_DIR: join(tmp, 'agent'), NODE_BIN: process.execPath, WORK_ROOT: join(tmp, 'work'), WASMER_REGISTRY_URL: 'http://127.0.0.1:9/graphql' });
const { startBuild } = await import(join(app, 'build.mjs'));
const build = async () => {
  const job = startBuild({
    user: { username: 'tester', account: 'acct-1' }, title: 'Raft', filename: 'raft.md', text: raft,
    llm: { api: 'openai-responses', model: 'fake', apiKey: 'sk-fake-1234567890' },
    images: { baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'k-fake-1234567890', model: 'gpt-image-1' },
    wasmerToken: 'wap_fake_1234567890', look: { theme: 'watercolor', color: 'color', label: 'test', directive: 'watercolor' },
  });
  const events = [];
  await new Promise(done => job.listeners.add(e => { if (e) events.push(e); else done(); }));
  return { job, events };
};
const { job, events } = await build();
const firstImages = images.splice(0);
// Every painting refused: the build must stop before deploying a book without pictures.
refuseImages = true;
const refused = await build();
// A dead key is caught before any agent runs.
refuseImages = false; refuseKey = true;
const deadKey = await build();
server.close();
const lines = events.filter(e => !['tool', 'tool-result', 'usage'].includes(e.kind)).map(e => `${e.stage.padEnd(10)} ${e.role ? `[${e.role}] ` : ''}${String(e.message).slice(0, 140)}`);
console.log(lines.join('\n'));
const archive = join(tmp, 'data', 'builds', job.id);
const roles = events.filter(e => e.kind === 'start').map(e => e.role);
let failures = 0;
const expect = (label, cond, extra = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${cond ? '' : ` ${extra}`}`); if (!cond) failures++; };
expect('roles ran in order with one revision', roles.join(',') === 'Analyst,Examiner,Analyst,Examiner,Writer,Critic,Builder', roles.join(','));
expect('book passed its checks', events.some(e => e.stage === 'check' && /Book passes/.test(e.message)));
expect('two sheets then two backdrops painted from them', firstImages.join(',') === '/images/generations,/images/generations,/images/edits,/images/edits', firstImages.join(','));
expect('reached deploy', events.some(e => e.stage === 'deploy'));
const failed = refused.events.find(e => e.stage === 'failed');
expect('refused paintings fail the build loudly', /Painting failed for \d+ pictures.*art\/char-.*organization must be verified/.test(failed?.message || ''), failed?.message);
expect('a book without pictures is not deployed', !refused.events.some(e => e.stage === 'deploy' || e.stage === 'upload'));
const transcripts = existsSync(join(archive, 'transcripts')) ? readdirSync(join(archive, 'transcripts')).sort() : [];
expect('one transcript per agent session', transcripts.length === 7 && transcripts[0] === '01-brief.ndjson' && transcripts.at(-1) === '07-build.ndjson', transcripts.join(','));
const t1 = transcripts.length ? readFileSync(join(archive, 'transcripts', transcripts[0]), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
expect('transcript has input, system prompt, tool output, stderr and exit',
  t1[0]?.type === 'run' && /INPUT/.test(t1[0].input) && t1.some(e => e.type === 'session_info' && e.systemPrompt) &&
  t1.some(e => e.type === 'tool_execution_end' && e.result.content[0].text === 'brief.json') && t1.some(e => e.type === 'stderr' && /warning/.test(e.text)) && t1.at(-1)?.type === 'exit',
  JSON.stringify(t1.map(e => e.type)));
expect('transcripts hold no API key', !transcripts.some(f => readFileSync(join(archive, 'transcripts', f), 'utf8').includes('sk-fake-1234567890')));
expect('start message names the model note', events.some(e => e.kind === 'start' && /fake endpoint/.test(e.message)));
expect('stray review draft removed', !existsSync(join(archive, 'reviews', 'draft.txt')) && events.some(e => /stray reviews\/draft.txt/.test(e.message)));
const deadFail = deadKey.events.find(e => e.stage === 'failed');
expect('a refused image key stops the build before any agent', /refused: Your API key has been invalidated/.test(deadFail?.message || '') && !deadKey.events.some(e => e.kind === 'start'), deadFail?.message);
expect('brief, script and reviews archived', ['brief.json', 'script.json', 'reviews/brief-1.json', 'reviews/brief-2.json', 'reviews/script-1.json'].every(f => existsSync(join(archive, f))), readdirSync(archive).join(','));
console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
