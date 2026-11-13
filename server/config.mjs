import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const env = process.env;
const here = new URL('.', import.meta.url).pathname;
const repo = join(here, '..');
// wasmer.toml mounts the repo at /app, /agent, /public and /pi; a Node deploy (anybuild) runs it in place.
const mounted = (abs, rel) => existsSync(abs) ? abs : join(repo, rel);
const firstFile = (...paths) => paths.find(p => p && existsSync(p)) || paths.at(-1);

export const config = {
  port: Number(env.PORT || 8080),
  dataDir: env.DATA_DIR || '/data',
  publicDir: env.PUBLIC_DIR || mounted('/public', 'public'),
  agentDir: env.AGENT_DIR || mounted('/agent', 'agent'),
  piDir: env.PI_DIR || mounted('/pi', 'pi'),
  appDir: here.replace(/\/$/, ''),
  nodeBin: env.NODE_BIN || firstFile('/bin/node', '/usr/bin/node', '/usr/local/bin/node', process.execPath),
  bashBin: env.BASH_BIN || firstFile('/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash', 'bash'),
  imageModel: env.OPENAI_IMAGE_MODEL || 'gpt-image-1',
  imageQuality: env.OPENAI_IMAGE_QUALITY || 'medium',
  registryUrl: env.WASMER_REGISTRY_URL || 'https://registry.wasmer.io/graphql',
  storyOwner: env.STORY_OWNER || '',
  // Per agent session; a build runs several (read, quiz, write, review, build).
  piTimeoutSeconds: Number(env.PI_TIMEOUT_SECONDS || 1500),
  maxDocumentChars: Number(env.MAX_DOCUMENT_CHARS || 1500000),
  // Documents up to this size are read whole by one analyst; longer ones are digested part by part first.
  singlePassChars: Number(env.SINGLE_PASS_CHARS || 400000),
  // How many times the brief and the script may be sent back by their adversarial reviewers.
  reviewRounds: Number(env.REVIEW_ROUNDS || 2),
  allowlist: JSON.parse(readFileSync(new URL('./allowlist.json', import.meta.url), 'utf8')),
};

// PATH for child processes (Pi, its bash tool, the validators): wherever node and bash actually live.
config.childPath = [...new Set([config.nodeBin, config.bashBin].filter(p => p.includes('/')).map(p => p.replace(/\/[^/]+$/, '')).concat(['/bin', '/usr/bin', '/usr/local/bin']))].join(':');
