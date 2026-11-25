// Log in with OpenRouter (PKCE): the browser keeps the verifier, posts the code here, and this
// trades it for a user-controlled key. https://openrouter.ai/docs/use-cases/oauth-pkce (2026-11-24)
const BASE = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai';
const CATALOGUE_MS = 60 * 60 * 1000;
const UPSTREAM_MS = 15000;
// Both anonymous routes reach OpenRouter, so a flood of junk codes or keys must not open a flood of
// upstream requests: past this many in flight, the answer is 429 and OpenRouter is left alone.
const MAX_UPSTREAM = 8;
let catalogue = null;
let inFlight = 0;

function bad(message) { return Object.assign(new Error(message), { status: 400 }); }
function upstream(message) { return Object.assign(new Error(message), { status: 502 }); }

async function callOpenRouter(path, init) {
  if (inFlight >= MAX_UPSTREAM) throw Object.assign(new Error('OpenRouter is busy; try again in a moment'), { status: 429 });
  inFlight++;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_MS);
  try {
    const response = await fetch(`${BASE}${path}`, { ...init, signal: controller.signal });
    return { response, body: await response.json().catch(() => ({})) };
  } catch {
    throw upstream('OpenRouter did not answer');
  } finally { inFlight--; clearTimeout(timer); }
}

// The models the visitor can pick from. Pi calls tools, so the list keeps only models that support
// them; the `:batch` twins are the same model at half price and would only clutter the field.
export async function listModels() {
  if (catalogue && catalogue.until > Date.now()) return catalogue.models;
  const { response, body } = await callOpenRouter('/api/v1/models');
  if (!response.ok) throw upstream(`OpenRouter did not list its models (HTTP ${response.status})`);
  const models = (body.data || [])
    .filter(model => !String(model.id).endsWith(':batch') && (model.supported_parameters || []).includes('tools'))
    .map(model => String(model.id));
  if (!models.length) throw upstream('OpenRouter listed no model that uses tools');
  catalogue = { models, until: Date.now() + CATALOGUE_MS };
  return models;
}

export async function exchangeCode(payload = {}) {
  const code = String(payload.code || '').trim();
  const verifier = String(payload.verifier || '').trim();
  if (!/^[\x21-\x7e]{8,512}$/.test(code) || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw bad('OpenRouter did not send a usable sign-in code');
  const { response, body } = await callOpenRouter('/api/v1/auth/keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
  });
  if (!response.ok || !body.key) throw bad(body.error?.message || `OpenRouter refused the sign-in (HTTP ${response.status})`);
  const key = String(body.key);
  if (!/^[\x21-\x7e]{8,512}$/.test(key)) throw bad('OpenRouter sent a key this app cannot use');
  return { key };
}

// What a key still has: an expired or spent key fails every build, so the panel asks before one starts.
export async function keyStatus(payload = {}) {
  const key = String(payload.key || '').trim();
  if (!/^[\x21-\x7e]{8,512}$/.test(key)) throw bad('The OpenRouter key looks malformed');
  const { response, body } = await callOpenRouter('/api/v1/key', { headers: { authorization: `Bearer ${key}` } });
  // OpenRouter answers 401 for a deleted or expired key and 403 for one without the needed scope.
  if (response.status === 401 || response.status === 403) return { ok: false, expired: false, exhausted: false, expiresAt: null };
  if (!response.ok) throw upstream(`OpenRouter did not answer for this key (HTTP ${response.status})`);
  const data = body.data || {};
  const expiresAt = data.expires_at || null;
  return {
    ok: true,
    expired: Boolean(expiresAt && Date.parse(expiresAt) < Date.now()),
    exhausted: typeof data.limit_remaining === 'number' && data.limit_remaining <= 0,
    expiresAt,
  };
}