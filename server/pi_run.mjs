// Runs Pi in a child process and turns its JSON event lines into build events.
// Every line Pi prints is also kept, unabridged, as the agent's transcript (see transcripts.mjs).
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from './config.mjs';
import { terminateChild } from './terminate_child.mjs';

const MAX_EVENT_TEXT = 4000;
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

export function redact(text, extra = []) {
  let out = String(text);
  for (const secret of extra.filter(v => v && v.length > 8)) out = out.split(secret).join('[REDACTED]');
  return out;
}

function toolSummary(name, args = {}, workDir = '') {
  if (name === 'bash') return String(args.command || '').slice(0, 400);
  const path = String(args.path || args.file_path || '').replace(`${workDir}/`, '');
  if (name === 'read' && (args.offset || args.limit)) {
    const from = Number(args.offset || 1);
    return `${path} · lines ${from}–${args.limit ? from + Number(args.limit) - 1 : 'end'}`;
  }
  if (['read', 'write', 'edit'].includes(name)) return path;
  return JSON.stringify(args).slice(0, 300);
}

export function runPi({ workDir, systemPath, inputPath, transcriptPath, onEvent, signal, llm, usage, stage = 'agent', role = 'Pi', timeoutSeconds = config.piTimeoutSeconds }) {
  const home = join(workDir, '.home');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(workDir, '.tmp'), { recursive: true });
  const env = {
    PATH: config.childPath,
    HOME: home,
    TMPDIR: join(workDir, '.tmp'),
    PI_CODING_AGENT_DIR: join(home, '.pi'),
    PI_API: llm.api,
    PI_MODEL: llm.model,
    PI_BASE_URL: llm.baseUrl || '',
    AGENT_DIR: config.agentDir,
    [llm.api === 'anthropic-messages' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY']: llm.apiKey,
    ...(existsSync('/etc/ssl/certs') ? { SSL_CERT_DIR: '/etc/ssl/certs' } : {}),
    ...(existsSync('/etc/ssl/certs/ca-bundle.crt') ? { SSL_CERT_FILE: '/etc/ssl/certs/ca-bundle.crt' } : {}),
    ...(process.env.SSL_CERT_FILE && !existsSync('/etc/ssl/certs/ca-bundle.crt') ? { SSL_CERT_FILE: process.env.SSL_CERT_FILE } : {}),
  };
  const summary = { bashCalls: 0, successfulBashCalls: 0, messages: 0, ended: false, failed: false, lastText: '' };
  const tools = new Map();
  const emit = event => onEvent({ ...event, stage, role, message: redact(event.message ?? '', [llm.apiKey]).slice(0, MAX_EVENT_TEXT) });
  // The transcript: a header, every Pi event as it arrived, stderr, and how the process ended.
  let transcriptBytes = 0;
  const record = entry => {
    if (!transcriptPath || transcriptBytes > MAX_TRANSCRIPT_BYTES) return;
    try {
      const line = redact(JSON.stringify({ at: new Date().toISOString(), ...entry }), [llm.apiKey]) + '\n';
      transcriptBytes += line.length;
      appendFileSync(transcriptPath, transcriptBytes > MAX_TRANSCRIPT_BYTES ? JSON.stringify({ type: 'truncated', reason: 'transcript reached 64 MiB' }) + '\n' : line);
    } catch {}
  };
  if (transcriptPath) mkdirSync(dirname(transcriptPath), { recursive: true });
  const readText = path => { try { return readFileSync(path, 'utf8'); } catch { return null; } };
  record({ type: 'run', stage, role, model: llm.model, api: llm.api, baseUrl: llm.baseUrl || null, workDir, systemPath, inputPath, input: readText(inputPath) });
  let modelNote = '';

  function handle(event) {
    if (event.type === 'session_info') { modelNote = event.note || ''; return; }
    if (event.type === 'agent_start') emit({ stage: 'agent', kind: 'start', message: `${role} started with ${llm.model} (${llm.api}${modelNote ? `, ${modelNote}` : ''})` });
    if (event.type === 'tool_execution_start') {
      tools.set(event.toolCallId, event.toolName);
      if (event.toolName === 'bash') summary.bashCalls++;
      emit({ stage: 'agent', kind: 'tool', tool: event.toolName, message: toolSummary(event.toolName, event.args, workDir) });
    }
    if (event.type === 'tool_execution_end') {
      const name = tools.get(event.toolCallId);
      tools.delete(event.toolCallId);
      if (name === 'bash' && !event.isError) summary.successfulBashCalls++;
      const text = (event.result?.content ?? []).filter(p => p.type === 'text').map(p => p.text).join('\n');
      const lines = text ? text.split('\n').length : 0;
      // Bash failures show at the end; file contents are best read from the start.
      const shown = text.length <= 3000 ? text : name === 'bash' ? `…\n${text.slice(-3000)}` : `${text.slice(0, 3000)}\n…`;
      emit({ stage: 'agent', kind: event.isError ? 'tool-error' : 'tool-result', tool: name, lines, message: shown });
    }
    if (event.type === 'message_end' && event.message?.role === 'assistant') {
      summary.messages++;
      summary.lastStopReason = event.message.stopReason;
      const u = event.message.usage;
      if (u && usage) {
        usage.input += u.input || 0; usage.output += u.output || 0;
        usage.cacheRead += u.cacheRead || 0; usage.cacheWrite += u.cacheWrite || 0;
        usage.cost += u.cost?.total || 0;
        emit({ stage: 'agent', kind: 'usage', usage: { ...usage } });
      }
      const text = (event.message.content ?? []).filter(p => p.type === 'text').map(p => p.text).join('\n').trim();
      if (text) { summary.lastText = text; emit({ stage: 'agent', kind: 'message', message: text }); }
      if (['error', 'aborted', 'length'].includes(event.message.stopReason)) {
        summary.failed = true;
        emit({ stage: 'agent', kind: 'error', level: 'error', message: event.message.errorMessage || event.message.stopReason });
      }
    }
    if (event.type === 'agent_end') { summary.ended = true; emit({ stage: 'agent', kind: 'done', message: `${role} finished` }); }
  }

  return new Promise(resolve => {
    const child = spawn(config.nodeBin, [join(config.appDir, 'pi_entry.mjs'), systemPath, inputPath],
      { cwd: workDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let pending = '';
    let stderr = '';
    let timedOut = false;
    let lastActivity = Date.now();
    const timer = setTimeout(() => {
      timedOut = true;
      emit({ stage: 'agent', kind: 'error', level: 'error', message: `${role} reached its time limit` });
      terminateChild(child);
    }, timeoutSeconds * 1000);
    const heartbeat = setInterval(() => {
      if (Date.now() - lastActivity > 25000) emit({ stage: 'agent', kind: 'heartbeat', message: `${role} is thinking…` });
    }, 25000);
    const abort = () => { summary.failed = true; summary.aborted = true; terminateChild(child); };
    signal?.addEventListener('abort', abort, { once: true });

    const line = text => {
      if (!text.trim()) return;
      lastActivity = Date.now();
      let event;
      try { event = JSON.parse(text); } catch {
        summary.failed = true;
        record({ type: 'unreadable', text: text.slice(0, 100000) });
        emit({ stage: 'agent', kind: 'error', message: 'Unreadable Pi event' });
        return;
      }
      record(event);
      handle(event);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      pending += chunk;
      let end;
      while ((end = pending.indexOf('\n')) !== -1) { line(pending.slice(0, end)); pending = pending.slice(end + 1); }
      if (pending.length > 8 * 1024 * 1024) { summary.failed = true; terminateChild(child); pending = ''; }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); record({ type: 'stderr', text: chunk }); });
    child.on('error', error => { summary.failed = true; emit({ stage: 'agent', kind: 'error', level: 'error', message: error.message }); });
    child.on('close', code => {
      clearTimeout(timer);
      clearInterval(heartbeat);
      signal?.removeEventListener('abort', abort);
      line(pending);
      if (stderr.trim()) emit({ stage: 'agent', kind: 'stderr', message: stderr.trim() });
      const ok = code === 0 && !timedOut && !summary.failed && summary.ended && summary.lastStopReason === 'stop';
      record({ type: 'exit', code, timedOut, ok, aborted: Boolean(summary.aborted), bashCalls: summary.bashCalls, messages: summary.messages, stopReason: summary.lastStopReason || null });
      resolve({ ...summary, code, timedOut, ok, final: parseFinal(summary.lastText) });
    });
  });
}

export function parseFinal(text) {
  const start = text.lastIndexOf('{');
  for (let i = text.indexOf('{'); i !== -1 && i <= start; i = text.indexOf('{', i + 1)) {
    try { return JSON.parse(text.slice(i, text.lastIndexOf('}') + 1)); } catch {}
  }
  return null;
}
