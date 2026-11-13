// The editor: an expert agent the owner chats with in the edit view. It reads the book's mood board
// (brief.json and script.json, including the owner's unsaved edits) and changes it through tools.
// Each change streams to the browser as it is made, so the board updates live; nothing is rebuilt
// until the owner presses Rebuild, which runs a normal tweak with the edited files.
//
// It calls the owner's model directly (Anthropic Messages, OpenAI Responses or Chat Completions):
// one short tool loop per chat message, no workspace and no shell.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';

const MAX_ROUNDS = 8;
const MAX_CHANGES = 80;
const MAX_HISTORY = 24;
const PROTECTED = [/^brief\.(concepts\.\d+\.evidence|facts|coverage)(\.|$)/, /^(brief|script)\.(concepts|ideas|characters|scenes)\.\d+\.id$/];

const TOOLS = [
  {
    name: 'edit',
    description: 'Change fields of brief.json or script.json. Each change is applied and shown to the owner immediately.',
    parameters: {
      type: 'object',
      properties: {
        changes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              file: { type: 'string', enum: ['brief', 'script'] },
              path: { type: 'string', description: 'Dot path, e.g. "characters.1.look" or "pages.4.text". An array index one past the end appends.' },
              op: { type: 'string', enum: ['set', 'remove'], description: 'set (default) replaces or adds the value; remove deletes an array item or key.' },
              value: { description: 'The new value for set: a string, number, boolean, array or object.' },
            },
            required: ['file', 'path'],
          },
        },
      },
      required: ['changes'],
    },
  },
  {
    name: 'set_rebuild_notes',
    description: 'Instructions for the builder that do not fit a field (palette, layout, tone of the quiz...). Replaces the previous notes.',
    parameters: { type: 'object', properties: { notes: { type: 'string' } }, required: ['notes'] },
  },
  {
    name: 'mark_repaint',
    description: 'Pictures to repaint even though their description did not change: "char-<character id>" for a model sheet, or a scene id.',
    parameters: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } } }, required: ['ids'] },
  },
];

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

// Apply one change to the drafts; returns the normalized change or throws with a message for the model.
export function applyChange(docs, change) {
  const file = change?.file;
  if (!['brief', 'script'].includes(file) || !docs[file]) throw new Error(`file must be "brief" or "script"`);
  const keys = String(change.path || '').split('.').filter(Boolean);
  if (!keys.length || keys.length > 8 || keys.some(k => !/^[A-Za-z0-9_-]{1,40}$/.test(k))) throw new Error(`bad path ${JSON.stringify(change.path)}`);
  const full = `${file}.${keys.join('.')}`;
  if (PROTECTED.some(re => re.test(full))) throw new Error(`${full} is protected: evidence, facts, coverage and ids must not be edited`);
  const op = change.op === 'remove' ? 'remove' : 'set';
  let parent = docs[file];
  for (const key of keys.slice(0, -1)) {
    const next = Array.isArray(parent) ? parent[Number(key)] : parent?.[key];
    if (next === undefined || next === null || typeof next !== 'object') throw new Error(`${full}: ${key} does not exist`);
    parent = next;
  }
  const last = keys.at(-1);
  if (Array.isArray(parent)) {
    const index = Number(last);
    if (!Number.isInteger(index) || index < 0 || index > parent.length || (op === 'remove' && index === parent.length)) throw new Error(`${full}: index out of range (length ${parent.length})`);
    if (op === 'remove') parent.splice(index, 1);
    else parent[index] = change.value;
  } else if (op === 'remove') delete parent[last];
  else {
    if (change.value === undefined) throw new Error(`${full}: value is required`);
    parent[last] = change.value;
  }
  if (JSON.stringify(docs[file]).length > 400000) throw new Error(`${file} would be too large`);
  return { file, path: keys.join('.'), op, ...(op === 'set' ? { value: change.value } : {}) };
}

// ── Model clients: one function per API, all returning { text, calls: [{ id, name, args }], next(results) } ──

async function post(url, headers, body, signal) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`The model API answered HTTP ${response.status}: ${text.slice(0, 200)}`); }
  if (!response.ok) throw new Error(`The model API answered HTTP ${response.status}: ${json.error?.message || JSON.stringify(json.error || json).slice(0, 300)}`);
  return json;
}

const parseArgs = text => { try { return typeof text === 'string' ? JSON.parse(text || '{}') : (text || {}); } catch { return { __invalid: String(text).slice(0, 200) }; } };

function anthropic(llm, system, history, signal) {
  const messages = history.map(m => ({ role: m.role, content: m.text }));
  const call = async () => {
    const body = await post(`${llm.baseUrl.replace(/\/v1$/, '')}/v1/messages`, { 'x-api-key': llm.apiKey, 'anthropic-version': '2023-06-01' }, {
      model: llm.model, max_tokens: 8000, system, messages,
      tools: TOOLS.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters })),
    }, signal);
    messages.push({ role: 'assistant', content: body.content });
    return {
      text: body.content.filter(c => c.type === 'text').map(c => c.text).join('\n').trim(),
      calls: body.content.filter(c => c.type === 'tool_use').map(c => ({ id: c.id, name: c.name, args: c.input || {} })),
      usage: body.usage,
    };
  };
  return { call, results: results => messages.push({ role: 'user', content: results.map(r => ({ type: 'tool_result', tool_use_id: r.id, content: r.output, is_error: r.error || undefined })) }) };
}

function responses(llm, system, history, signal) {
  const input = history.map(m => ({ role: m.role, content: m.text }));
  const call = async () => {
    const body = await post(`${llm.baseUrl}/responses`, { authorization: `Bearer ${llm.apiKey}` }, {
      model: llm.model, instructions: system, input, store: false, include: ['reasoning.encrypted_content'],
      tools: TOOLS.map(t => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters })),
    }, signal);
    const output = body.output || [];
    input.push(...output);
    return {
      text: output.filter(o => o.type === 'message').flatMap(o => o.content || []).filter(c => c.type === 'output_text').map(c => c.text).join('\n').trim(),
      calls: output.filter(o => o.type === 'function_call').map(o => ({ id: o.call_id, name: o.name, args: parseArgs(o.arguments) })),
      usage: body.usage,
    };
  };
  return { call, results: results => input.push(...results.map(r => ({ type: 'function_call_output', call_id: r.id, output: r.output }))) };
}

function completions(llm, system, history, signal) {
  const messages = [{ role: 'system', content: system }, ...history.map(m => ({ role: m.role, content: m.text }))];
  const call = async () => {
    const body = await post(`${llm.baseUrl}/chat/completions`, { authorization: `Bearer ${llm.apiKey}` }, {
      model: llm.model, messages, tools: TOOLS.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
    }, signal);
    const message = body.choices?.[0]?.message || {};
    messages.push(message);
    return {
      text: String(message.content || '').trim(),
      calls: (message.tool_calls || []).map(c => ({ id: c.id, name: c.function?.name, args: parseArgs(c.function?.arguments) })),
      usage: body.usage,
    };
  };
  return { call, results: results => messages.push(...results.map(r => ({ role: 'tool', tool_call_id: r.id, content: r.output }))) };
}

const CLIENTS = { 'anthropic-messages': anthropic, 'openai-responses': responses, 'openai-completions': completions };

function systemPrompt(docs, extra) {
  const prompt = readFileSync(join(config.agentDir, 'prompts', 'editor.md'), 'utf8');
  return [prompt,
    `CURRENT brief.json\n${JSON.stringify(docs.brief, null, 1)}`,
    `CURRENT script.json\n${JSON.stringify(docs.script, null, 1)}`,
    extra.notes ? `CURRENT rebuild notes\n${extra.notes}` : '',
    extra.repaint?.length ? `Pictures already marked for repainting: ${extra.repaint.join(', ')}` : '',
  ].filter(Boolean).join('\n\n');
}

function cleanHistory(messages) {
  const list = (Array.isArray(messages) ? messages : []).slice(-MAX_HISTORY)
    .map(m => ({ role: m?.role === 'assistant' ? 'assistant' : 'user', text: String(m?.text || '').slice(0, 6000).trim() }))
    .filter(m => m.text);
  while (list.length && list[0].role !== 'user') list.shift();
  if (!list.length || list.at(-1).role !== 'user') throw fail('Write a message for the editor');
  return list;
}

// Runs one chat turn. emit receives { type: text|edit|notes|repaint|error|done, ... }.
export async function runEditor({ llm, docs, notes = '', repaint = [], messages, emit, signal }) {
  const history = cleanHistory(messages);
  const client = (CLIENTS[llm.api] || (() => { throw fail(`Unsupported API ${llm.api}`); }))(llm, systemPrompt(docs, { notes, repaint }), history, signal);
  let changes = 0;
  const said = [];
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const turn = await client.call();
    if (turn.text) { said.push(turn.text); emit({ type: 'text', text: turn.text }); }
    if (!turn.calls.length) break;
    const results = [];
    for (const call of turn.calls) {
      let output, error = false;
      try {
        if (call.args?.__invalid) throw new Error(`arguments were not valid JSON: ${call.args.__invalid}`);
        if (call.name === 'edit') {
          const applied = [], problems = [];
          for (const change of Array.isArray(call.args.changes) ? call.args.changes : []) {
            if (++changes > MAX_CHANGES) { problems.push('too many changes in one message'); break; }
            try { const done = applyChange(docs, change); applied.push(done); emit({ type: 'edit', ...done }); }
            catch (e) { problems.push(e.message); }
          }
          output = `Applied ${applied.length} change${applied.length === 1 ? '' : 's'}.${problems.length ? ` Not applied: ${problems.join('; ')}` : ''}`;
          error = !applied.length && problems.length > 0;
        } else if (call.name === 'set_rebuild_notes') {
          notes = String(call.args.notes || '').slice(0, 4000);
          emit({ type: 'notes', notes });
          output = 'Rebuild notes set.';
        } else if (call.name === 'mark_repaint') {
          const ids = (Array.isArray(call.args.ids) ? call.args.ids : []).map(String).filter(id => /^[a-z0-9-]{1,40}$/.test(id));
          repaint = [...new Set([...repaint, ...ids])];
          emit({ type: 'repaint', ids: repaint });
          output = `Marked for repainting: ${repaint.join(', ') || 'nothing'}.`;
        } else throw new Error(`Unknown tool ${call.name}`);
      } catch (e) { output = e.message; error = true; }
      results.push({ id: call.id, output, error });
    }
    client.results(results);
  }
  emit({ type: 'done', text: said.join('\n\n'), brief: docs.brief, script: docs.script, notes, repaint });
}
