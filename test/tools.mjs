// The agents' sandbox helpers: the grep/rg stand-in, the shell shims and the page printer.
// Usage: node test/tools.mjs   (needs bash)
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const ws = mkdtempSync(join(tmpdir(), 'tools-'));
mkdirSync(join(ws, 'site'));
mkdirSync(join(ws, '.tmp'));
writeFileSync(join(ws, 'notes.md'), '# Notes\nThe leader writes.\nfollowers copy (slowly)\n');
writeFileSync(join(ws, 'site', 'story.js'), "export default { pages: [{ text: 'Hi' }, { text: 'needs label and caption' }] };\n");
writeFileSync(join(ws, '.tmp', 'hidden.txt'), 'leader in a hidden dir\n');
writeFileSync(join(ws, 'brief.json'), JSON.stringify({ question: 'Why?', concepts: [{ id: 'a', name: 'Alpha', plain: 'secret plain' }] }));
writeFileSync(join(ws, 'script.json'), JSON.stringify({ title: 'T', question: 'Q?', pages: [{ scene: 'cover', side: 'right', text: 'Cover.' }, { idea: 'x', side: 'left', text: 'Page one.', interaction: { type: 'quiz' } }] }));

const bash = cmd => {
  const r = spawnSync('bash', ['-c', cmd], { cwd: ws, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, BASH_ENV: join(root, 'agent', 'tools', 'shell.sh'), AUTO_STORY_TOOLS: join(root, 'agent', 'tools') } });
  return { out: r.stdout, err: r.stderr, code: r.status };
};
let failures = 0;
const expect = (label, cond, extra = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${cond ? '' : ` ${JSON.stringify(extra)}`}`); if (!cond) failures++; };

let r = bash("grep -n 'leader\\|copy' notes.md");
expect('grep basic alternation with line numbers', r.out === '2:The leader writes.\n3:followers copy (slowly)\n', r);
r = bash("grep -c '(slowly)' notes.md");
expect('grep treats ( ) literally in basic mode', r.out === '1\n', r);
r = bash("grep -E 'lead(er)?' -o notes.md");
expect('grep -E -o', r.out === 'leader\n', r);
r = bash('grep -rl leader .');
expect('grep -r searches hidden dirs too', r.out.split('\n').filter(Boolean).sort().join(',') === '.tmp/hidden.txt,notes.md', r);
r = bash("rg -l 'leader|label'");
expect('rg recurses, skips hidden, prints names', r.out.split('\n').filter(Boolean).sort().join(',') === 'notes.md,site/story.js', r);
r = bash("rg -n 'needs label' site");
expect('rg prints path:line:text', r.out === 'site/story.js:1:' + "export default { pages: [{ text: 'Hi' }, { text: 'needs label and caption' }] };\n", r);
r = bash('grep -q nothing-here notes.md');
expect('no match exits 1', r.code === 1, r);
r = bash("printf 'a\\nB\\nc\\n' | grep -i -v b");
expect('grep reads a pipe', r.out === 'a\nc\n', r);
r = bash('grep -A1 leader notes.md');
expect('grep after-context', r.out === 'The leader writes.\nfollowers copy (slowly)\n', r);
r = bash('python3 -c 1');
expect('python says what to use instead', r.code === 127 && /Node.js is the only runtime/.test(r.err), r);
r = bash("node --input-type=module <<'JS'\nimport s from './site/story.js';\nconsole.log(s.pages.length);\nJS");
expect('node --input-type=module heredoc runs as a file', r.out === '2\n' && r.code === 0, r);
expect('and leaves no temp file behind', !readdirSync(ws).some(f => f.startsWith('.stdin-')));
r = bash("node -e 'console.log(1 + 1)'");
expect('node -e passes through', r.out === '2\n', r);
r = bash(`node ${join(root, 'agent', 'tools', 'pages.mjs')} . --brief`);
expect('pages prints texts and concept names only', /pages\[1\] \(x · left · interaction: quiz · 9 chars\)\nPage one\./.test(r.out) && /- a: Alpha/.test(r.out) && !/secret plain/.test(r.out), r);

console.log(failures ? `${failures} FAILED` : 'tools: all passed');
process.exit(failures ? 1 : 0);
