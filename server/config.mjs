import { readFileSync } from 'node:fs';

const env = process.env;
const here = new URL('.', import.meta.url).pathname;

export const config = {
  port: Number(env.PORT || 8080),
  dataDir: env.DATA_DIR || '/data',
  publicDir: env.PUBLIC_DIR || '/public',
  agentDir: env.AGENT_DIR || '/agent',
  appDir: here.replace(/\/$/, ''),
  nodeBin: env.NODE_BIN || '/bin/node',
  imageModel: env.OPENAI_IMAGE_MODEL || 'gpt-image-1',
  imageQuality: env.OPENAI_IMAGE_QUALITY || 'medium',
  registryUrl: env.WASMER_REGISTRY_URL || 'https://registry.wasmer.io/graphql',
  storyOwner: env.STORY_OWNER || '',
  piTimeoutSeconds: Number(env.PI_TIMEOUT_SECONDS || 1500),
  maxDocumentChars: Number(env.MAX_DOCUMENT_CHARS || 150000),
  allowlist: JSON.parse(readFileSync(new URL('./allowlist.json', import.meta.url), 'utf8')),
};

