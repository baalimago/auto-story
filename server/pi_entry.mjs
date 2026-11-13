import { existsSync, readFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
// /pi under wasmer.toml; ../pi or ../node_modules when the repo runs in place (anybuild Node deploys).
const PI_BUNDLE = 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/index.js';
const piBundle = [process.env.PI_DIR && `${process.env.PI_DIR}/${PI_BUNDLE}`, `/pi/${PI_BUNDLE}`,
  new URL(`../pi/${PI_BUNDLE}`, import.meta.url).pathname, new URL(`../${PI_BUNDLE}`, import.meta.url).pathname].find(p => p && existsSync(p));
if (!piBundle) throw new Error('Pi is not installed: run npm ci --prefix pi');
const { createAgentSession, createBashToolDefinition, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import(piBundle);
import { createBashOperations } from './bash_operations.mjs';

const bashOperations = createBashOperations(error => {
  writeSync(2, `${error.message}; stopping the Pi invocation\n`);
  process.exit(1);
});

const [systemPath, inputPath] = process.argv.slice(2);
const api = process.env.PI_API || 'openai-responses';
const modelId = process.env.PI_MODEL;
const baseUrl = process.env.PI_BASE_URL || '';
if (!modelId) throw new Error('PI_MODEL is required');
const cwd = process.cwd();
// Every role's prompt ends with the same description of the sandbox (agent/prompts/environment.md).
const agentDir = dirname(dirname(systemPath));
const environmentPath = join(dirname(systemPath), 'environment.md');
const systemText = readFileSync(systemPath, 'utf8') +
  (existsSync(environmentPath) ? `\n${readFileSync(environmentPath, 'utf8').replaceAll('{{agent}}', agentDir)}` : '');
const out = event => process.stdout.write(JSON.stringify(event) + '\n');
// The default credential store needs utime, which Edge.js lacks.
const credentials = {
  async read() { return undefined; },
  async list() { return []; },
  async modify() { throw new Error('Persistent credentials are disabled'); },
  async delete() { throw new Error('Persistent credentials are disabled'); },
};
const settingsManager = SettingsManager.inMemory({ transport: 'sse' });
const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
let modelNote = '';
const model = resolveModel();
const resourceLoader = new DefaultResourceLoader({
  cwd, agentDir: process.env.PI_CODING_AGENT_DIR || `${process.env.HOME || '/tmp'}/.pi`, settingsManager,
  noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
  appendSystemPrompt: [systemText],
});
await resourceLoader.reload();
const { session } = await createAgentSession({
  cwd, modelRuntime, model, settingsManager, resourceLoader,
  sessionManager: SessionManager.inMemory(cwd),
  customTools: [createBashToolDefinition(cwd, { operations: bashOperations })],
});
// The parent keeps every line as the agent's transcript, so pass on everything except streaming deltas
// (message_start/update, tool_execution_update) and what repeats other events: tool-result messages
// (tool_execution_end has them) and session entries that are messages (message_end has them).
// Thinking stays in: the parent shows only text, but the transcript is for debugging.
let systemPrompt = systemText;
try { systemPrompt = session.systemPrompt || session.agent?.state?.systemPrompt || systemText; } catch {}
out({ type: 'session_info', model: { id: model.id, api: model.api, provider: model.provider, baseUrl: model.baseUrl }, note: modelNote, systemPrompt });
session.subscribe(event => {
  if (['message_start', 'message_update', 'tool_execution_update'].includes(event.type)) return;
  if (event.type === 'message_end' && event.message?.role === 'toolResult') return;
  if (event.type === 'entry_appended' && event.entry?.type === 'message') return;
  if (event.type === 'agent_end') return out({ type: event.type });
  try { out(event); } catch (error) { out({ type: 'unserializable_event', eventType: event.type, error: error.message }); }
});
// Known models keep Pi's metadata; unknown ids and custom endpoints borrow a template of the same API.
function resolveModel() {
  const provider = api === 'anthropic-messages' ? 'anthropic' : 'openai';
  const known = modelRuntime.getModel(provider, modelId);
  if (known && known.api === api && (!baseUrl || baseUrl === known.baseUrl)) return known;
  const templates = {
    'anthropic-messages': [['anthropic', 'claude-opus-5-5'], ['anthropic', 'claude-sonnet-5']],
    'openai-responses': [['openai', 'gpt-6-luna'], ['openai', 'gpt-5.5']],
    'openai-completions': [['openai', 'gpt-4.1'], ['openai', 'gpt-4o']],
  };
  if (!templates[api]) throw new Error(`Unsupported API ${api}`);
  const template = templates[api].map(([p, id]) => modelRuntime.getModel(p, id)).find(Boolean);
  if (!template) throw new Error(`Pi has no template model for ${api}`);
  const model = { ...(known ?? template), id: modelId, name: modelId, api, provider, baseUrl: baseUrl || template.baseUrl };
  if (api === 'openai-completions' && !known) {
    Object.assign(model, { reasoning: false, compat: {} });
    delete model.thinkingLevelMap;
  }
  modelNote = `${model.baseUrl}${known ? '' : `, metadata borrowed from ${template.id}`}`;
  return model;
}

try {
  await session.prompt(readFileSync(inputPath, 'utf8'));
} finally {
  session.dispose();
}
