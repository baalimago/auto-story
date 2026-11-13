// Per-build model settings supplied by the builder. Keys live only in memory for one build.
import { config } from './config.mjs';

export const PROVIDERS = {
  'anthropic-messages': { label: 'Anthropic Messages API', baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5-5' },
  'openai-responses': { label: 'OpenAI Responses API', baseUrl: 'https://api.openai.com/v1', model: 'gpt-6-luna' },
  'openai-completions': { label: 'OpenAI-compatible Chat Completions', baseUrl: '', model: '' },
};
const OPENAI_BASE = 'https://api.openai.com/v1';
// Paintings go here; tests point it at a fake.
const IMAGES_BASE = process.env.OPENAI_IMAGES_BASE_URL || OPENAI_BASE;

function bad(message) { return Object.assign(new Error(message), { status: 400 }); }

function cleanUrl(value) {
  let url;
  try { url = new URL(String(value)); } catch { throw bad('Base URL is not a valid URL'); }
  const local = /^(localhost|127\.\d+\.\d+\.\d+)$/.test(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw bad('Base URL must use https');
  return url.href.replace(/\/+$/, '');
}

function cleanKey(value) {
  const key = String(value || '').trim();
  if (key && !/^[\x21-\x7e]{8,512}$/.test(key)) throw bad('The API key looks malformed');
  return key;
}


export function parseProviders(body = {}) {
  const input = body.llm || {};
  const apiKey = cleanKey(input.apiKey);
  let llm;
  if (apiKey) {
    const api = String(input.api || '');
    const preset = PROVIDERS[api];
    if (!preset) throw bad(`Choose one of: ${Object.keys(PROVIDERS).join(', ')}`);
    const model = String(input.model || preset.model).trim();
    if (!/^[A-Za-z0-9._:/@-]{1,120}$/.test(model)) throw bad('Model id is missing or invalid');
    const baseUrl = cleanUrl(input.baseUrl || preset.baseUrl || (() => { throw bad('Base URL is required for this API'); })());
    llm = { api, model, baseUrl, apiKey };
  } else {
    throw bad('Paste an API key for the model');
  }

  const imageKey = cleanKey(body.images?.apiKey);
  let images = null;
  if (imageKey) images = { apiKey: imageKey, baseUrl: IMAGES_BASE, model: config.imageModel };
  else if (llm.api === 'openai-responses' && llm.baseUrl === OPENAI_BASE) images = { apiKey: llm.apiKey, baseUrl: IMAGES_BASE, model: config.imageModel };
  return { llm, images };
}

// Repaint-only tweaks need no model, only an image key (the image key field, or an OpenAI model key).
export function parseImagesOnly(body = {}) {
  if (cleanKey(body.llm?.apiKey)) return parseProviders(body).images;
  const imageKey = cleanKey(body.images?.apiKey);
  return imageKey ? { apiKey: imageKey, baseUrl: IMAGES_BASE, model: config.imageModel } : null;
}
