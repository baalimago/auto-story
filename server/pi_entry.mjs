import { readFileSync, writeSync } from 'node:fs';
import { createAgentSession, createBashToolDefinition, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager }
  from '/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/index.js';
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
// The default credential store needs utime, which Edge.js lacks.
const credentials = {
  async read() { return undefined; },
  async list() { return []; },
  async modify() { throw new Error('Persistent credentials are disabled'); },
  async delete() { throw new Error('Persistent credentials are disabled'); },
};
const settingsManager = SettingsManager.inMemory({ transport: 'sse' });
const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
const model = resolveModel();
const resourceLoader = new DefaultResourceLoader({
  cwd, agentDir: process.env.PI_CODING_AGENT_DIR || `${process.env.HOME || '/tmp'}/.pi`, settingsManager,
  noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
  appendSystemPrompt: [readFileSync(systemPath, 'utf8')],
});
await resourceLoader.reload();
const { session } = await createAgentSession({
  cwd, modelRuntime, model, settingsManager, resourceLoader,
  sessionManager: SessionManager.inMemory(cwd),
  customTools: [createBashToolDefinition(cwd, { operations: bashOperations })],
});
session.subscribe(event => {
  if (event.type === 'message_end' && event.message?.role === 'assistant') {
    const message = { ...event.message, content: event.message.content.filter(part => part.type !== 'thinking') };
    process.stdout.write(JSON.stringify({ type: event.type, message }) + '\n');
  } else if (['agent_start', 'agent_end'].includes(event.type)) {
    process.stdout.write(JSON.stringify({ type: event.type }) + '\n');
  } else if (['tool_execution_start', 'tool_execution_end'].includes(event.type)) {
    process.stdout.write(JSON.stringify(event) + '\n');
  }
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
  writeSync(2, `Using ${api} model ${modelId} at ${model.baseUrl}${known ? '' : ` (metadata from ${template.id})`}\n`);
  return model;
}

try {
  await session.prompt(readFileSync(inputPath, 'utf8'));
} finally {
  session.dispose();
}
