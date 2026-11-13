import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { config } from './config.mjs';
import { authenticate, identify, publicUser } from './auth.mjs';
import { abortBuild, activeBuilds, archivedEvents, canFollow, getJob, startBuild } from './build.mjs';
import { listStories } from './stories.mjs';
import { PROVIDERS, parseProviders } from './providers.mjs';
import { lookOptions, parseLook } from './looks.mjs';

const MAX_BODY = 4 * 1024 * 1024;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

function send(res, status, body, headers = {}) {
  const json = typeof body !== 'string';
  res.writeHead(status, { 'content-type': json ? 'application/json' : 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(json ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('Document is too large (4 MB max of text)'), { status: 413 })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const text = await readBody(req);
  try { return text ? JSON.parse(text) : {}; } catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

function serveStatic(req, res, pathname) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '').replace(/^\/+/, '');
  let file = join(config.publicDir, rel || 'index.html');
  if (!file.startsWith(config.publicDir)) return send(res, 404, 'Not found');
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) return send(res, 404, 'Not found');
  res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  createReadStream(file).pipe(res);
}

function streamJob(res, job) {
  res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
  const write = event => { try { res.write(JSON.stringify(event) + '\n'); } catch {} };
  write({ stage: 'job', id: job.id, title: job.title, status: job.status });
  for (const event of job.events) write(event);
  if (job.status !== 'running') { res.end(); return; }
  const keepAlive = setInterval(() => write({ stage: 'ping' }), 15000);
  const listener = event => {
    if (event === null) { clearInterval(keepAlive); res.end(); return; }
    write(event);
  };
  job.listeners.add(listener);
  res.on('close', () => { clearInterval(keepAlive); job.listeners.delete(listener); });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  const path = url.pathname;
  try {
    if (path === '/healthz') return send(res, 200, { ok: true, activeBuilds: activeBuilds() });

    if (path === '/api/me') {
      return send(res, 200, {
        providers: PROVIDERS, looks: lookOptions(), imageModel: config.imageModel, storyOwner: config.storyOwner || null,
      });
    }

    if (path === '/api/auth/token' && req.method === 'POST') {
      return send(res, 200, { user: publicUser(await identify((await readJson(req)).token)) });
    }

    if (path === '/api/stories') {
      const { user } = await authenticate(req);
      return send(res, 200, { stories: listStories(user) });
    }

    if (path === '/api/builds' && req.method === 'POST') {
      const body = await readJson(req);
      const { user, token: wasmerToken } = await authenticate(req, body);
      if (!user.allowed) return send(res, 403, { error: `${user.username} is not on this app's allowlist` });
      const text = String(body.text || '').replace(/\u0000/g, '').trim();
      if (text.length < 200) return send(res, 400, { error: 'The document needs at least a few paragraphs of text' });
      const title = String(body.title || body.filename || 'Untitled').replace(/\.(pdf|txt|md|markdown)$/i, '').slice(0, 120);
      const { llm, images } = parseProviders(body);
      const look = parseLook(body.look);
      const job = startBuild({ user, title, filename: String(body.filename || '').slice(0, 200), text, llm, images, wasmerToken, look });
      return streamJob(res, job);
    }

    const abort = path.match(/^\/api\/builds\/([0-9]{8}-[a-z0-9]{6})\/abort$/);
    if (abort && req.method === 'POST') {
      const { user } = await authenticate(req, await readJson(req));
      return send(res, 200, abortBuild(abort[1], user));
    }

    const events = path.match(/^\/api\/builds\/([0-9]{8}-[a-z0-9]{6})\/events$/);
    if (events) {
      const { user } = await authenticate(req);
      if (!canFollow(events[1], user)) return send(res, 404, { error: 'Unknown build' });
      const job = getJob(events[1]);
      if (job) return streamJob(res, job);
      const archived = archivedEvents(events[1]);
      if (!archived) return send(res, 404, { error: 'Unknown build' });
      res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(archived.map(e => JSON.stringify(e)).join('\n') + '\n');
    }

    if (path.startsWith('/api/')) return send(res, 404, { error: 'Not found' });
    return serveStatic(req, res, path);
  } catch (error) {
    if (!error.status || error.status >= 500) console.error(error);
    if (!res.headersSent) send(res, error.status || 500, { error: error.message });
    else res.end();
  }
});

server.listen(config.port, '0.0.0.0', () => {
  console.log(`auto-story listening on :${config.port} (images ${config.imageModel}, data ${config.dataDir})`);
});
