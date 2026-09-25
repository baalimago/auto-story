// The visitor's Wasmer token is the credential: whoami decides identity and allowlist per request.
import { createHash } from 'node:crypto';
import { config } from './config.mjs';
import { whoami } from './wasmer_api.mjs';

const CACHE_MS = 5 * 60 * 1000;
const cache = new Map();

function fail(message, status) { return Object.assign(new Error(message), { status }); }

export function isAllowed(identity) {
  const { users = [], namespaces = [] } = config.allowlist;
  const lower = list => list.map(x => String(x).toLowerCase());
  return lower(users).includes(identity.username.toLowerCase()) ||
    identity.namespaces.some(ns => lower(namespaces).includes(ns.toLowerCase()));
}

// Equivalent of `WASMER_TOKEN=<token> wasmer whoami`, plus the allowlist check.
export async function identify(token) {
  const clean = String(token || '').trim();
  if (!clean) throw fail('Sign in with a Wasmer access token first', 401);
  if (!/^[\x21-\x7e]{16,512}$/.test(clean)) throw fail('That does not look like a Wasmer access token', 400);
  const key = createHash('sha256').update(clean).digest('hex');
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.user;
  let identity;
  try { identity = await whoami(clean); }
  catch { throw fail('Wasmer did not accept that token', 401); }
  const user = { ...identity, allowed: isAllowed(identity) };
  cache.set(key, { user, until: Date.now() + CACHE_MS });
  return user;
}
