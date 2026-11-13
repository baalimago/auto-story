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
  // Per agent session; a build runs several (read, quiz, write, review, build).
  piTimeoutSeconds: Number(env.PI_TIMEOUT_SECONDS || 1500),
  maxDocumentChars: Number(env.MAX_DOCUMENT_CHARS || 1500000),
  // Documents up to this size are read whole by one analyst; longer ones are digested part by part first.
  singlePassChars: Number(env.SINGLE_PASS_CHARS || 400000),
  // How many times the brief and the script may be sent back by their adversarial reviewers.
  reviewRounds: Number(env.REVIEW_ROUNDS || 2),
  allowlist: JSON.parse(readFileSync(new URL('./allowlist.json', import.meta.url), 'utf8')),
};

