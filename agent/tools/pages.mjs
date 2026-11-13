// Prints script.json as a reader meets it: title, question, then every page text in order.
// Usage: node /agent/tools/pages.mjs [workspace or script.json] [--brief] [--json]
//   --brief  also print the brief's question and concept names (not their explanations)
//   --json   print the same as JSON
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const args = process.argv.slice(2);
const target = resolve(args.find(a => !a.startsWith('--')) || '.');
const scriptPath = existsSync(target) && statSync(target).isDirectory() ? join(target, 'script.json') : target;
const workspace = dirname(scriptPath);
const read = (file, label) => {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { console.error(`${label}: ${error.code === 'ENOENT' ? 'not written yet' : error.message}`); process.exit(1); }
};
const script = read(scriptPath, scriptPath);
const pages = (Array.isArray(script.pages) ? script.pages : []).map((p, i) => ({
  page: i, idea: p.idea || (i === 0 ? 'cover' : ''), side: p.side || '', interaction: p.interaction?.type || '',
  chars: String(p.text ?? '').length, text: String(p.text ?? ''),
}));
const brief = args.includes('--brief') ? read(join(workspace, 'brief.json'), 'brief.json') : null;
const concepts = brief ? (brief.concepts || []).map(c => ({ id: c.id, name: c.name })) : undefined;

if (args.includes('--json')) {
  console.log(JSON.stringify({ title: script.title, question: script.question, pages, ...(brief ? { brief_question: brief.question, concepts } : {}) }, null, 2));
} else {
  console.log(`TITLE: ${script.title ?? ''}`);
  if (script.subtitle) console.log(`SUBTITLE: ${script.subtitle}`);
  console.log(`QUESTION: ${script.question ?? ''}\n`);
  for (const p of pages) {
    const tags = [p.idea, p.side, p.interaction && `interaction: ${p.interaction}`, `${p.chars} chars`].filter(Boolean).join(' · ');
    console.log(`pages[${p.page}] (${tags})\n${p.text}\n`);
  }
  if (brief) {
    console.log(`BRIEF QUESTION: ${brief.question ?? ''}`);
    console.log('CONCEPT NAMES:');
    for (const c of concepts) console.log(`- ${c.id}: ${c.name}`);
  }
}
