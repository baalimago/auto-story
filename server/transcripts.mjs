// Agent transcripts: every Pi session of a build or tweak, unabridged, for debugging.
//   /data/builds/<job id>/transcripts/<nn>-<step>.ndjson
// Each line is one record: "run" (role, model, the input), "session_info" (resolved model, full system prompt),
// every Pi event (assistant messages with thinking, tool calls with their arguments, full tool results,
// retries, compactions), "stderr" chunks, and "exit". Builds from before transcripts existed have only
// their abridged pi-<nn>-<step>.ndjson event logs, which are listed too.
// Only the account that started the job may read them (server.mjs checks canFollow first).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildsDir } from './build.mjs';
import { zipEntries } from './zip.mjs';

const ID_RE = /^[0-9]{8}-[a-z0-9]{6}$/;
const NAME_RE = /^(?:transcripts\/[0-9]{2,3}-[a-z0-9-]{1,60}|pi-[0-9]{2,3}-[a-z0-9-]{1,60})\.ndjson$/;

function files(id) {
  if (!ID_RE.test(id)) return [];
  const dir = join(buildsDir(), id);
  const found = [];
  try { for (const f of readdirSync(join(dir, 'transcripts'))) if (f.endsWith('.ndjson')) found.push(`transcripts/${f}`); } catch {}
  try { for (const f of readdirSync(dir)) if (/^pi-.*\.ndjson$/.test(f)) found.push(f); } catch {}
  const n = f => Number(f.match(/(\d+)-/)[1]);
  return found.filter(f => NAME_RE.test(f)).sort((a, b) => n(a) - n(b) || a.localeCompare(b));
}

export function listTranscripts(id) {
  return files(id).map(name => {
    const path = join(buildsDir(), id, name);
    let head = {};
    try { head = JSON.parse(readFileSync(path, 'utf8').split('\n', 1)[0]); } catch {}
    return {
      name, step: name.replace(/^.*?\d+-|\.ndjson$/g, ''), legacy: name.startsWith('pi-'),
      role: head.role || null, stage: head.stage || null, model: head.model || null,
      bytes: statSync(path).size,
    };
  });
}

export function readTranscript(id, name) {
  if (!files(id).includes(name)) return null;
  return readFileSync(join(buildsDir(), id, name), 'utf8');
}

const time = at => (typeof at === 'number' ? new Date(at).toISOString() : String(at || '')).slice(11, 19);
const textOf = content => (Array.isArray(content) ? content : [])
  .filter(p => p.type === 'text').map(p => p.text).join('\n');
const block = (title, body) => `\n── ${title}\n${String(body ?? '').replace(/\s+$/, '')}\n`;

// A plain-text reading of one transcript: what the agent was told, thought, ran and saw.
export function renderTranscript(ndjson) {
  const out = [];
  for (const raw of ndjson.split('\n')) {
    if (!raw.trim()) continue;
    let e;
    try { e = JSON.parse(raw); } catch { out.push(block('unreadable line', raw)); continue; }
    const t = time(e.at);
    switch (e.type) {
      case 'run':
        out.push(`# ${e.role} (${e.stage}) · ${e.model} via ${e.api}${e.baseUrl ? ` at ${e.baseUrl}` : ''}\n# started ${e.at}`);
        if (e.input) out.push(block('INPUT', e.input));
        break;
      case 'session_info':
        if (e.note) out.push(`# model ${e.model?.id} · ${e.note}`);
        out.push(block('SYSTEM PROMPT', e.systemPrompt));
        break;
      case 'message_end': {
        const m = e.message || {};
        if (m.role === 'assistant') {
          for (const part of m.content || []) {
            if (part.type === 'thinking' && part.thinking?.trim()) out.push(block(`${t} thinking`, part.thinking));
            if (part.type === 'text' && part.text?.trim()) out.push(block(`${t} assistant`, part.text));
          }
          const u = m.usage;
          out.push(`   [${m.stopReason || '?'}${u ? ` · in ${u.input || 0} · out ${u.output || 0} · cache ${u.cacheRead || 0}${u.cost?.total ? ` · $${u.cost.total.toFixed(4)}` : ''}` : ''}]${m.errorMessage ? ` ${m.errorMessage}` : ''}`);
        } else if (m.role === 'user') {
          out.push(block(`${t} user`, typeof m.content === 'string' ? m.content : textOf(m.content)));
        }
        break;
      }
      case 'tool_execution_start':
        out.push(block(`${t} → ${e.toolName}`, e.toolName === 'bash' ? e.args?.command : JSON.stringify(e.args, null, 2)));
        break;
      case 'tool_execution_end':
        out.push(block(`${t} ← ${e.toolName || 'tool'}${e.isError ? ' ERROR' : ''}`, textOf(e.result?.content) || JSON.stringify(e.result ?? null)));
        break;
      case 'stderr':
        out.push(block(`${t} stderr`, e.text));
        break;
      case 'exit':
        out.push(`\n# exit ${e.code}${e.timedOut ? ' (timed out)' : ''}${e.aborted ? ' (aborted)' : ''} · ${e.ok ? 'ok' : 'not ok'} · stop ${e.stopReason} · ${e.messages} messages, ${e.bashCalls} bash calls`);
        break;
      case 'agent_start': case 'agent_end': case 'turn_start': case 'turn_end':
        break;
      default:
        // Legacy pi-*.ndjson lines are build events; anything else is a Pi event worth seeing as is.
        if (e.kind) out.push(`${t} [${e.kind}${e.tool ? ` ${e.tool}` : ''}] ${e.message ?? ''}`);
        else out.push(`${t} [${e.type}] ${JSON.stringify(e).slice(0, 2000)}`);
    }
  }
  return out.join('\n') + '\n';
}

// Everything needed to debug a job, in one download: its event log, meta, and each transcript raw and readable.
export function transcriptsZip(id) {
  if (!ID_RE.test(id)) return null;
  const dir = join(buildsDir(), id);
  if (!existsSync(dir)) return null;
  const entries = [];
  for (const f of ['meta.json', 'events.ndjson']) if (existsSync(join(dir, f))) entries.push({ name: `${id}/${f}`, data: readFileSync(join(dir, f)) });
  for (const name of files(id)) {
    const text = readFileSync(join(dir, name), 'utf8');
    const base = name.replace(/^transcripts\//, '').replace(/\.ndjson$/, '');
    entries.push({ name: `${id}/transcripts/${base}.ndjson`, data: text });
    entries.push({ name: `${id}/transcripts/${base}.txt`, data: renderTranscript(text) });
  }
  return entries.length ? zipEntries(entries) : null;
}
