// Integration test inside the package: start a build against a model endpoint that never answers, then abort it.
import { writeFileSync } from 'node:fs';
import { abortBuild, startBuild } from '/app/build.mjs';

const [endpoint, mode = 'local'] = process.argv.slice(2);
const job = startBuild({
  user: { username: 'tester', namespaces: [], allowed: true },
  title: 'Abort test', filename: 'abort.txt', text: 'Raft keeps a replicated log consistent. '.repeat(20),
  llm: { api: 'openai-completions', model: 'hang-model', baseUrl: endpoint, apiKey: 'sk-test-abort-123456' },
  images: null, wasmerToken: 'wap_unused_token_1234567890', look: { theme: 'watercolor', color: 'color', label: 'test', directive: 'test' },
});
const seen = [];
job.listeners.add(event => { if (event) seen.push(event); });
setTimeout(() => {
  if (mode === 'flag') {
    // Simulates an abort that reached another instance: only the volume flag is written.
    writeFileSync(`/data/builds/${job.id}/abort`, JSON.stringify({ by: 'tester' }));
    console.log('wrote abort flag only');
    return;
  }
  console.log('abort by stranger:', (() => { try { abortBuild(job.id, 'someone-else'); return 'allowed?!'; } catch (e) { return e.message; } })());
  console.log('abort by owner:', JSON.stringify(abortBuild(job.id, 'tester')));
}, 10000);
const started = Date.now();
const timer = setInterval(() => {
  if (job.status !== 'running' || Date.now() - started > 60000) {
    clearInterval(timer);
    console.log(`status=${job.status} after ${Math.round((Date.now() - started) / 1000)}s: ${job.error}`);
    for (const e of seen.slice(-4)) console.log(' ', e.stage, e.kind || '', (e.message || '').slice(0, 100));
    process.exit(0);
  }
}, 500);
