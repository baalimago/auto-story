// Offline test of the staged pipeline's validators and painter: no model, no network.
// Usage: node test/stages.mjs   (from the repo root)
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { splitParts, writeParts, groupParts } from '../server/source.mjs';

const root = resolve(new URL('..', import.meta.url).pathname);
const ws = mkdtempSync(join(tmpdir(), 'stages-'));
let failures = 0;
const expect = (label, cond, extra = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${cond ? '' : ` ${extra}`}`); if (!cond) failures++; };
const check = (script, args) => {
  const r = spawnSync(process.execPath, [join(root, 'agent', script), ...args], { encoding: 'utf8' });
  return JSON.parse(r.stdout);
};
const plan = (stage, extra = []) => check('check_plan.mjs', [ws, '--stage', stage, ...extra]);
const write = (file, data) => { mkdirSync(join(ws, file, '..'), { recursive: true }); writeFileSync(join(ws, file), typeof data === 'string' ? data : JSON.stringify(data, null, 2)); };

// Splitting: every character kept, parts within limits.
const raft = readFileSync(join(root, 'test/fixtures/raft.md'), 'utf8');
const big = Array.from({ length: 40 }, (_, i) => `Paragraph ${i}. ${raft}`).join('\n\n');
const bigParts = splitParts(big);
expect('split keeps every character', bigParts.map(p => p.text).join('') === big.replace(/\r\n?/g, '\n'));
expect('split respects the size limit', bigParts.every(p => p.text.length <= 24000), bigParts.map(p => p.text.length).join(','));
const many = splitParts('short line\n'.repeat(5000));
expect('split respects the line limit', many.every(p => p.text.split('\n').length <= 1501));
const files = writeParts(join(ws, 'source'), splitParts(raft, 1500));
expect('groups cover all parts', groupParts(files, 3000).flat().length === files.length);
const q = (part, from, len = 60) => { const t = readFileSync(join(ws, 'source', `${part}.txt`), 'utf8'); const i = t.indexOf(from); return t.slice(i, i + len); };

// Brief.
const coverage = files.map(f => ({ part: f.id, gist: 'What this part of the Raft text says.', quote: readFileSync(f.file, 'utf8').trim().split('\n')[0].slice(0, 80) }));
const where = text => files.find(f => readFileSync(f.file, 'utf8').includes(text)).id;
const ev = text => ({ part: where(text), quote: text });
const brief = {
  topic: 'How a group of computers agrees on one list of commands even when some crash.',
  question: 'How can a team of computers agree on the same list when some of them break?',
  answer: 'They elect one leader that writes the list, and an entry only counts once most of the team has copied it.',
  concepts: [
    { id: 'roles', name: 'One leader', plain: 'One computer is the boss of the list and the others copy what it says.', precise: 'Each server is a leader, follower or candidate; one leader handles all client requests.', how: ['one leader', 'followers respond'], depends_on: [], evidence: [ev('each server is in one of three states: leader, follower, or candidate')] },
    { id: 'election', name: 'Elections', plain: 'If the boss goes quiet, someone asks for votes and wins with more than half.', precise: 'Followers time out, become candidates, and win with votes from a majority.', how: ['timeout', 'request votes', 'majority wins'], depends_on: ['roles'], evidence: [ev('A candidate wins if it receives votes from a majority of the servers in the full cluster.')] },
    { id: 'replication', name: 'Copying the list', plain: 'The boss sends each new line to everyone and it counts once most have it.', precise: 'The leader appends entries and replicates them with AppendEntries.', how: ['append', 'send', 'commit at majority'], depends_on: ['election'], evidence: [{ part: where('The leader appends the command'), quote: 'The leader appends the command to its log as a new entry' }] },
  ],
  facts: [ev('for example 150 to 300 milliseconds')],
  misconceptions: [{ wrong: 'All computers vote on every entry.', right: 'Only the leader proposes; followers copy.' }],
  left_out: ['Snapshots'],
  coverage,
};
brief.facts[0].claim = 'Timeouts are random, e.g. 150-300 ms.';
write('brief.json', brief);
let r = plan('brief');
expect('valid brief passes', r.ok, JSON.stringify(r.errors));
write('brief.json', { ...brief, concepts: [{ ...brief.concepts[0], evidence: [{ part: brief.concepts[0].evidence[0].part, quote: 'Raft elects a president by coin toss every second.' }] }, ...brief.concepts.slice(1)] });
r = plan('brief');
expect('invented quote is caught', !r.ok && r.errors.some(e => e.includes('quote not found')), JSON.stringify(r.errors));
write('brief.json', { ...brief, coverage: coverage.slice(1) });
r = plan('brief');
expect('skipped part is caught', !r.ok && r.errors.some(e => e.includes(`${files[0].id} is missing`)), JSON.stringify(r.errors));
write('brief.json', brief);

// Examiner review.
const questions = Array.from({ length: 10 }, (_, i) => ({ asked_by: i % 2 ? 'child' : 'expert', question: `Question ${i}?`, brief_answer: 'It says so.', source_answer: 'It does.', part: files[0].id, ok: true }));
write('reviews/brief-1.json', { verdict: 'pass', summary: 'The brief is accurate and clear.', questions, issues: [] });
r = plan('brief-review', ['--review', 'reviews/brief-1.json']);
expect('passing review is accepted', r.ok && r.verdict === 'pass', JSON.stringify(r.errors));
write('reviews/brief-1.json', { verdict: 'pass', summary: 'Looks fine to me.', questions, issues: [{ severity: 'major', where: 'answer', problem: 'Wrong', fix: 'Fix it' }] });
r = plan('brief-review', ['--review', 'reviews/brief-1.json']);
expect('pass with a major issue is rejected', !r.ok, JSON.stringify(r));

// Script.
const page = (idea, scene, text, extra = {}) => ({ idea, scene, side: 'left', text, teaches: 'Something new.', note: 'Grown-up detail.', ...extra });
const script = {
  title: 'The Busy Beavers', subtitle: 'Who keeps the list?', question: brief.question, answer: brief.answer,
  metaphor: { world: 'A beaver lodge that keeps one shared building plan on bark sheets.', map: brief.concepts.map(c => ({ concept: c.id, thing: 'x', behaves: 'y', mirrors: 'z', breaks: 'w' })) },
  ideas: [ { id: 'boss', title: 'One boss', text: 'One beaver keeps the plan.', concepts: ['roles'] }, { id: 'vote', title: 'Voting', text: 'Votes pick a new boss.', concepts: ['election'] }, { id: 'copy', title: 'Copying', text: 'Copies make it count.', concepts: ['replication'] } ],
  characters: [ { id: 'bea', name: 'Bea', is: 'The leader', personality: 'Bossy but fair', look: 'A plump brown beaver about knee high, with a green woollen cap, a pencil behind her ear and a white patch on her chest.' },
                { id: 'tod', name: 'Tod', is: 'A follower', personality: 'Curious', look: 'A thin young beaver with sandy fur, round red glasses, a striped blue scarf and a satchel full of bark sheets.' } ],
  scenes: [ { id: 'cover', characters: ['bea', 'tod'], shows: 'The two beavers on a lodge roof at dusk, river on the right side calm and empty.' },
            { id: 'lodge', characters: ['bea'], shows: 'Inside the lodge, Bea at a big bark table, the left side is a calm wooden wall with nothing on it.' } ],
  pages: [ { scene: 'cover', side: 'right', text: 'The beavers have one plan.' },
    page('boss', 'lodge', 'Bea keeps the plan.', { interaction: { type: 'compare', plan: 'With a boss vs without a boss: chips show the order of logs.' } }),
    page('boss', 'lodge', 'Everyone copies Bea.'), page('vote', 'lodge', 'Bea fell asleep.'),
    page('vote', 'lodge', 'Tod asked for votes.', { interaction: { type: 'stepper', plan: 'Timeout, ask for votes, count to a majority of five, win.' } }),
    page('copy', 'lodge', 'Bea sends each line.'), page('copy', 'lodge', 'Three of five have it.'),
    page('copy', 'lodge', 'Now you know.', { interaction: { type: 'quiz', plan: 'When does a line count? Choices: when Bea writes it, when most copy it (correct), when all copy it.' } }) ],
};
write('script.json', script);
r = plan('script');
expect('valid script passes', r.ok, JSON.stringify(r.errors));
write('script.json', { ...script, ideas: script.ideas.slice(0, 2).concat({ ...script.ideas[2], concepts: ['roles'] }) });
r = plan('script');
expect('untaught concept is caught', !r.ok && r.errors.some(e => e.includes('replication is not taught')), JSON.stringify(r.errors));
write('script.json', script);
write('reviews/script-1.json', { verdict: 'revise', summary: 'Pages 3 and 4 jump.', reader_test: [1, 2, 3].map(i => ({ question: `Q${i}`, answer_from_pages: 'A', correct: i !== 2 })), issues: [{ severity: 'major', kind: 'clarity', where: 'pages[3].text', problem: 'Jump', fix: 'Add a beat' }] });
r = plan('script-review', ['--review', 'reviews/script-1.json']);
expect('critic review is read', r.ok && r.verdict === 'revise' && r.major === 1 && r.failed === 1, JSON.stringify(r));

// Site check with characters and sides.
const site = join(ws, 'site');
cpSync(join(root, 'agent/template'), site, { recursive: true });
const story = readFileSync(join(root, 'agent/example/story.js'), 'utf8').replace("explain: 'Wants to reach a site by its name.' }", "explain: 'Wants to reach a site by its name.', art: 'char-pip' }");
writeFileSync(join(site, 'story.js'), story);
cpSync(join(root, 'agent/example/scenes.js'), join(site, 'scenes.js'));
writeFileSync(join(site, 'story.css'), '');
const artPlan = { style: "gentle watercolor and ink children's picture book illustration, warm valley light",
  characters: [ { id: 'pip', name: 'Pip', look: 'A small grey pigeon with a red mail satchel and a blue cap, one white wing tip.' }, { id: 'owl', name: 'Old Owl', look: 'A large tawny owl with round brass glasses and a long green cardigan with patches.' } ],
  images: ['cover', 'p01', 'p02', 'p03'].map(id => ({ id, characters: id === 'p03' ? ['pip'] : ['pip', 'owl'], prompt: `Scene ${id}: Byte Valley houses with numbered doors, wide view, calm open sky on one side.` })) };
mkdirSync(join(site, 'art'), { recursive: true });
writeFileSync(join(site, 'art/plan.json'), JSON.stringify(artPlan));
r = check('check.mjs', [site, '--art', 'painted', '--theme', 'watercolor', '--color', 'color']);
expect('site with character plan passes', r.ok, JSON.stringify(r.errors));
expect('site check reports text sides', Array.isArray(r.sides?.p01) && r.sides.p01.length === 2 && r.sides.cover[0] === 'right', JSON.stringify(r.sides));
writeFileSync(join(site, 'art/plan.json'), JSON.stringify({ ...artPlan, images: [{ ...artPlan.images[0], characters: ['ghost'] }, ...artPlan.images.slice(1)] }));
r = check('check.mjs', [site, '--art', 'painted', '--theme', 'watercolor', '--color', 'color']);
expect('unknown character in a scene is caught', !r.ok && r.errors.some(e => e.includes('ghost')), JSON.stringify(r.errors));
writeFileSync(join(site, 'art/plan.json'), JSON.stringify(artPlan));

// Painter: sheets first, then backdrops from the sheets via the edits endpoint.
const calls = [];
const png = Buffer.from('fake-image').toString('base64');
const server = createServer((req, res) => {
  let body = Buffer.alloc(0);
  req.on('data', c => { body = Buffer.concat([body, c]); });
  req.on('end', () => {
    const text = body.toString('latin1');
    calls.push({ url: req.url, refs: (text.match(/name="image\[\]"/g) || []).length, prompt: req.url.includes('generations') ? JSON.parse(text).prompt : (text.match(/name="prompt"\r\n\r\n([\s\S]*?)\r\n--/) || [])[1] });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ b64_json: png }], usage: { total_tokens: 10 } }));
  });
});
await new Promise(ok => server.listen(0, ok));
process.env.DATA_DIR = ws;
const { paintAll } = await import('../server/paint.mjs');
const result = await paintAll(site, { baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'k', model: 'gpt-image-1' },
  { directive: 'watercolor', color: 'color' }, () => {}, { sides: r.sides });
server.close();
const sheetCalls = calls.filter(c => c.url === '/images/generations' && c.prompt?.includes('Character model sheet'));
const editCalls = calls.filter(c => c.url === '/images/edits');
expect('one sheet per character, painted first', sheetCalls.length === 2 && calls.indexOf(sheetCalls[1]) < calls.indexOf(editCalls[0]));
expect('every backdrop painted from the sheets of its characters', editCalls.length === 4 && editCalls.filter(c => c.refs === 2).length === 3 && editCalls.filter(c => c.refs === 1).length === 1, JSON.stringify(editCalls.map(c => c.refs)));
expect('prompt keeps the words side calm', editCalls.some(c => /Keep the left 40% of the picture and the right 40%|Keep the right 40%/.test(c.prompt || '')));
expect('all painted', result.painted.length === 4 && result.sheets.length === 2 && !result.failed.length, JSON.stringify(result));

console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
