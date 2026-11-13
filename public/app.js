const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/6.3.289';
const STAGES = ['prepare', 'understand', 'script', 'build', 'check', 'paint', 'deploy', 'done'];
const $ = id => document.getElementById(id);
const state = { me: null, wasmer: null, doc: null, buildId: null, started: 0, timer: null, editing: null, board: null };

function storage(fn) { try { return fn(localStorage); } catch { return null; } }
function escape(text) {
  return String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function setStatus(text, error = false) { $('status').textContent = text; $('status').classList.toggle('error', error); }

// Every private call carries the visitor's credential. Login with Wasmer will swap this for a session cookie.
function authHeaders(extra = {}) {
  const token = state.wasmer?.token || savedToken();
  return token ? { ...extra, authorization: `Bearer ${token}` } : extra;
}

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', ...options, headers: authHeaders(options.headers) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

// Account and allowlist gate.
const WASMER_MARK = '<svg class="mark" viewBox="0 0 29 36" aria-hidden="true" fill="currentColor"><path d="M8.90773 13.9487C8.90773 13.9823 8.90773 14.016 8.90773 14.0496C8.90773 15.2359 8.16236 15.7533 7.24593 15.2064C6.3295 14.6596 5.58413 13.2546 5.58413 12.0683C5.58413 12.0347 5.58413 12.001 5.58413 11.9674L0 8.63574V27.355L14.5 35.9996V17.2803L8.90773 13.9487Z"/><path d="M16.1577 9.62902C16.1577 9.66268 16.1577 9.69633 16.1577 9.72998C16.1577 10.9162 15.4124 11.4336 14.4959 10.8868C13.5795 10.3399 12.8341 8.93494 12.8341 7.74868C12.8341 7.71503 12.8341 7.68137 12.8341 7.64772L7.25 4.32031V11.0172L16.1292 16.3133V28.3357L21.75 31.6884V12.9691L16.1577 9.62902Z"/><path d="M23.4077 5.31292C23.4077 5.34657 23.4077 5.38022 23.4077 5.41388C23.4077 6.60013 22.6624 7.11754 21.7459 6.57069C20.8295 6.02383 20.0841 4.61883 20.0841 3.43257C20.0841 3.39892 20.0841 3.36527 20.0841 3.33162L14.5 0V6.69688L23.3792 11.993V24.0154L29 27.368V8.64874L23.4077 5.31292Z"/></svg>';
const TOKENS_URL = 'https://wasmer.io/settings/access-tokens';

const TOKEN_KEY = 'auto-story-wasmer-token';
const session = fn => { try { return fn(sessionStorage); } catch { return null; } };

// The visitor's Wasmer token stays in the browser and is sent with each build.
function savedToken() { return session(s => s.getItem(TOKEN_KEY)) || storage(s => s.getItem(TOKEN_KEY)) || ''; }
function keepToken(token, remember) {
  session(s => s.setItem(TOKEN_KEY, token));
  if (remember) storage(s => s.setItem(TOKEN_KEY, token));
}
function dropToken() {
  session(s => s.removeItem(TOKEN_KEY));
  storage(s => s.removeItem(TOKEN_KEY));
}

async function loadMe() {
  state.me = await api('/api/me');
  setupModel();
  setupLook();
  const token = savedToken();
  if (token) {
    try { state.wasmer = { token, user: (await checkToken(token)).user }; }
    catch { dropToken(); state.wasmer = null; }
  }
  renderAccount();
  renderGate();
  updateGo();
  loadGallery();
  route();
}

function checkToken(token) {
  return api('/api/auth/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
}

function renderAccount() {
  const account = $('account');
  const user = state.wasmer?.user;
  if (!user) { account.innerHTML = ''; return; }
  account.innerHTML = `<span class="who">${WASMER_MARK}<strong>${escape(user.username)}</strong></span><button class="ghost" id="logout">Sign out</button>`;
  $('logout').addEventListener('click', () => { dropToken(); state.wasmer = null; renderAccount(); renderGate(); updateGo(); loadGallery(); route(); });
}

function renderGate(message, isError = true) {
  const user = state.wasmer?.user;
  const gate = $('gate');
  gate.hidden = false;
  gate.className = 'gate';
  if (!user) {
    gate.classList.add('signin-panel');
    gate.innerHTML = `
      <div class="gate-body">
        <h3>${WASMER_MARK}Sign in with Wasmer</h3>
        <p>Books are deployed as Wasmer Edge apps in <strong>your</strong> Wasmer account, using your access token.
          Building is open to an allowlist of Wasmer users and namespaces. Your shelf is private: only you see the books you made.</p>
        <ol class="steps">
          <li><a href="${TOKENS_URL}" target="_blank" rel="noopener">Create an access token on wasmer.io ↗</a>
            <span class="muted">(a dedicated one you can delete afterwards)</span></li>
          <li>Paste it here. It stays in this browser and is sent with each build; the server never stores it.</li>
        </ol>
        <p class="muted">Auto Story is an open-source Wasmer project. You can read exactly what happens to your token in
          <a href="https://github.com/wasmerio/auto-story" target="_blank" rel="noopener">github.com/wasmerio/auto-story</a>.</p>
        <form id="token-form" class="token-form">
          <input id="wasmer-token" type="password" autocomplete="off" spellcheck="false" placeholder="wap_…" aria-label="Wasmer access token" required>
          <button class="primary signin" type="submit">Sign in</button>
        </form>
        <label class="check"><input id="remember-token" type="checkbox"> Remember my token on this device</label>
        ${message ? `<p class="${isError ? 'gate-error' : ''}">${escape(message)}</p>` : ''}
      </div>`;
    $('token-form').addEventListener('submit', signIn);
  } else if (!user.allowed) {
    gate.classList.add('denied');
    gate.innerHTML = `<div class="gate-body"><h3>Not on the list yet</h3><p>You are signed in as <strong>${escape(user.username)}</strong>,
      but only allowlisted Wasmer users and namespaces can build books.</p></div>`;
  } else if (message) {
    gate.classList.add('welcome');
    gate.innerHTML = `<p>${escape(message)}</p>`;
  } else {
    gate.hidden = true;
  }
}

async function signIn(event) {
  event.preventDefault();
  const token = $('wasmer-token').value.trim();
  const remember = $('remember-token').checked;
  const button = event.submitter || $('token-form').querySelector('button');
  button.disabled = true;
  button.textContent = 'Checking…';
  try {
    const { user } = await checkToken(token);
    state.wasmer = { token, user };
    if (user.allowed) keepToken(token, remember);
    renderAccount();
    const owner = state.me.storyOwner || user.username;
    renderGate(user.allowed ? `Welcome, ${user.username}. Books will be deployed under ${owner}. Drop a document to begin.`
      : `${user.username} is not on this builder's allowlist.`, !user.allowed);
    updateGo();
    loadGallery();
    route();
  } catch (error) {
    renderGate(error.message);
  }
}

// Document intake. PDFs are read in the browser with pdf.js.
async function pdfText(file) {
  const pdfjs = await import(`${PDFJS}/pdf.min.mjs`);
  pdfjs.GlobalWorkerOptions.workerSrc = `${PDFJS}/pdf.worker.min.mjs`;
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    setStatus(`Reading page ${i} of ${pdf.numPages}…`);
    const content = await (await pdf.getPage(i)).getTextContent();
    let line = '', lastY;
    const lines = [];
    for (const item of content.items) {
      const y = item.transform?.[5];
      if (lastY !== undefined && Math.abs(y - lastY) > 2) { lines.push(line); line = ''; }
      line += item.str + (item.hasEOL ? ' ' : '');
      lastY = y;
    }
    lines.push(line);
    pages.push(lines.join('\n'));
  }
  return { text: pages.join('\n\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n'), pages: pdf.numPages };
}

async function takeFile(file) {
  if (!file) return;
  setStatus('Reading…');
  try {
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    const { text, pages } = isPdf ? await pdfText(file) : { text: await file.text(), pages: null };
    if (text.trim().length < 200) throw new Error(isPdf ? 'Found almost no text in this PDF (is it scanned?)' : 'This file is nearly empty');
    setDoc({ name: file.name, text, pages });
    setStatus('');
  } catch (error) {
    setStatus(error.message, true);
  }
}

function setDoc(doc) {
  state.doc = doc;
  $('doc').hidden = !doc;
  if (doc) {
    $('doc-name').textContent = doc.name;
    $('doc-meta').textContent = `${doc.pages ? `${doc.pages} pages · ` : ''}${doc.text.length.toLocaleString()} characters`;
    $('doc-title').value = doc.name.replace(/\.(pdf|txt|md|markdown)$/i, '').replace(/[_-]+/g, ' ');
    $('doc-preview').textContent = doc.text.slice(0, 400);
  }
  updateGo();
}

// Look: style, era and colour, passed to the painter and to Pi.
const LOOK_KEY = 'auto-story-look';
function setupLook() {
  const { looks } = state.me;
  const style = $('look-style');
  style.innerHTML = Object.entries(looks).map(([id, l]) => `<option value="${id}">${escape(l.label)}</option>`).join('');
  const saved = storage(s => JSON.parse(s.getItem(LOOK_KEY) || 'null'));
  style.value = saved?.style in looks ? saved.style : 'picturebook';
  applyLookStyle(saved);
  style.addEventListener('change', () => applyLookStyle());
  $('look-year').addEventListener('input', lookChanged);
  $('look-color').addEventListener('change', lookChanged);
}

function applyLookStyle(saved) {
  const look = state.me.looks[$('look-style').value];
  const year = $('look-year');
  $('look-year-row').hidden = !look.eras;
  if (look.eras) {
    year.min = look.min; year.max = look.max;
    year.value = saved?.year >= look.min && saved?.year <= look.max ? saved.year : look.defaultYear;
  }
  $('look-color').value = saved?.color || look.defaultColor;
  lookChanged();
}

function lookSettings() {
  const style = $('look-style').value;
  const look = state.me.looks[style];
  return { style, color: $('look-color').value, ...(look.eras ? { year: Number($('look-year').value) } : {}) };
}

function lookChanged() {
  const l = lookSettings();
  const look = state.me.looks[l.style];
  if (look.eras) {
    const era = look.eras.find(e => l.year >= e.from && l.year <= e.to);
    $('look-year-label').textContent = `${l.year} · ${era?.label || ''}`;
  }
  storage(s => s.setItem(LOOK_KEY, JSON.stringify(l)));
}

// Model settings: the builder's own API, model, and key for each build.
const SETTINGS_KEY = 'auto-story-model';
let modelReady = false;
function setupModel() {
  if (modelReady) return;
  modelReady = true;
  const { providers } = state.me;
  const select = $('llm-api');
  select.innerHTML = Object.entries(providers).map(([id, p]) => `<option value="${id}">${escape(p.label)}</option>`).join('');
  const saved = storage(s => JSON.parse(s.getItem(SETTINGS_KEY) || 'null'));
  if (saved) {
    select.value = saved.api in providers ? saved.api : 'anthropic-messages';
    $('llm-base').value = saved.baseUrl || '';
    $('llm-model').value = saved.model || '';
    $('llm-key').value = saved.apiKey || '';
    $('img-key').value = saved.imageKey || '';
    $('remember').checked = true;
  } else {
    select.value = 'anthropic-messages';
    applyPreset();
  }
  select.addEventListener('change', applyPreset);
  for (const id of ['llm-base', 'llm-model', 'llm-key', 'img-key']) $(id).addEventListener('input', modelChanged);
  $('remember').addEventListener('change', () => { if (!$('remember').checked) storage(s => s.removeItem(SETTINGS_KEY)); });
  modelChanged();
}

function applyPreset() {
  const preset = state.me.providers[$('llm-api').value];
  $('llm-base').value = preset.baseUrl;
  $('llm-model').value = preset.model;
  modelChanged();
}

function modelSettings() {
  return {
    api: $('llm-api').value, baseUrl: $('llm-base').value.trim(), model: $('llm-model').value.trim(),
    apiKey: $('llm-key').value.trim(), imageKey: $('img-key').value.trim(),
  };
}

function modelChanged() {
  const m = modelSettings();
  const reusesKey = m.api === 'openai-responses' && m.baseUrl.replace(/\/+$/, '') === 'https://api.openai.com/v1';
  $('img-row').hidden = reusesKey;
  const painted = (reusesKey && m.apiKey) || m.imageKey;
  $('art-note').textContent = painted
    ? `Backdrops are painted with ${state.me.imageModel}.`
    : 'Without an OpenAI key for paintings, Pi draws the backdrops itself as SVG.';
  updateGo();
}

function updateGo() {
  const m = state.me && modelReady ? modelSettings() : null;
  const hasModel = m && m.apiKey && m.model && (m.baseUrl || m.api !== 'openai-completions');
  const ready = state.doc && state.wasmer?.user?.allowed && hasModel && !state.buildId;
  $('go').disabled = !ready;
  if (typeof updateTweak === 'function') updateTweak();
}

const drop = $('drop');
drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); takeFile(e.dataTransfer.files[0]); });
drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click(); } });
$('file').addEventListener('change', e => takeFile(e.target.files[0]));
$('pasted').addEventListener('input', e => {
  const text = e.target.value;
  if (text.trim().length >= 200) setDoc({ name: 'Pasted text', text, pages: null });
  else if (state.doc?.name === 'Pasted text') setDoc(null);
});

// Build progress.
function markStage(stage, failed = false) {
  const index = STAGES.indexOf(stage);
  if (index < 0) return;
  document.querySelectorAll('.stages li').forEach((li, i) => {
    li.classList.toggle('done', i < index || (stage === 'done' && i === index));
    li.classList.toggle('active', i === index && stage !== 'done' && !failed);
    li.classList.toggle('failed', failed && i === index);
  });
}

function formatDuration(ms) {
  const s = Math.max(0, ms) / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(Math.round(s % 60)).padStart(2, '0')}s`;
}

// Each row shows when it happened and how long until the next row; the newest row counts up live.
function stamp(li, at) {
  const iso = new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z');
  li.dataset.at = at;
  li.insertAdjacentHTML('afterbegin', `<time datetime="${iso}" title="${iso}">${iso}</time><span class="dur"></span>`);
}

function closeLiveRow(until) {
  const live = $('log').querySelector('li.live');
  if (!live) return;
  live.classList.remove('live');
  const spent = until - Number(live.dataset.at);
  live.querySelector('.dur').textContent = formatDuration(spent);
  live.classList.toggle('slow', spent >= 60000);
}

function tickLiveRow() {
  const live = $('log').querySelector('li.live');
  if (!live) return;
  const spent = Date.now() - Number(live.dataset.at);
  live.querySelector('.dur').textContent = formatDuration(spent);
  live.classList.toggle('slow', spent >= 60000);
}

function logEvent(event) {
  if (event.stage === 'ping' || event.kind === 'heartbeat') return;
  const li = document.createElement('li');
  li.className = [event.kind, event.level].filter(Boolean).join(' ');
  if (['tool-result', 'tool-error', 'stderr'].includes(event.kind)) {
    if (!event.message) return;
    const label = event.kind === 'stderr' ? 'stderr' : `↳ ${event.kind === 'tool-error' ? 'error' : 'output'}${event.lines ? ` · ${event.lines} line${event.lines === 1 ? '' : 's'}` : ''}`;
    li.innerHTML = `<details${event.kind === 'tool-error' ? ' open' : ''}><summary><span class="tag"></span>${escape(label)}</summary><pre>${escape(event.message)}</pre></details>`;
  } else {
    const tag = event.kind === 'tool' ? event.tool : event.kind === 'message' ? (event.role || 'pi').toLowerCase() : event.stage;
    li.innerHTML = `<span class="tag">${escape(tag)}</span><span class="text">${escape(event.message)}</span>`;
  }
  if (event.at) {
    stamp(li, event.at);
    closeLiveRow(event.at);
    if (!['done', 'failed'].includes(event.stage)) li.classList.add('live');
  }
  const log = $('log');
  const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
  log.appendChild(li);
  tickLiveRow();
  while (log.children.length > 600) log.firstElementChild.remove();
  if (stick) log.scrollTop = log.scrollHeight;
}

function formatUsage(u) {
  if (!u) return '';
  const tokens = (u.tokens ?? (u.input + u.output + u.cacheRead + u.cacheWrite)) || 0;
  const k = tokens >= 1e6 ? `${(tokens / 1e6).toFixed(2)}M` : tokens >= 1e3 ? `${(tokens / 1e3).toFixed(1)}k` : String(tokens);
  const parts = [`${k} tokens`];
  if (u.cost) parts.push(`~$${u.cost.toFixed(2)}`);
  if (u.images) parts.push(`${u.images} image${u.images === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

let lastStage = 'prepare';
const seenEvents = new Set();
function handleEvent(event) {
  // Reconnects replay the whole history; only render what is new.
  if (event.at) {
    const key = `${event.at}|${event.stage}|${event.kind || ''}|${event.tool || ''}|${(event.message || '').length}`;
    if (seenEvents.has(key)) return;
    seenEvents.add(key);
  }
  if (event.usage) $('usage').textContent = `${formatUsage(event.usage)} ·`;
  if (event.kind === 'usage') return;
  if (event.stage === 'job') {
    state.buildId = event.id;
    storage(s => s.setItem('auto-story-build', event.id));
    $('abort').hidden = event.status !== 'running';
    $('progress-title').textContent = `Writing “${event.title}”`;
    return;
  }
  if (event.stage === 'failed') {
    markStage(lastStage, true);
    if (state.editing) setTimeout(() => loadBoard(state.editing), 500);
    showResult(`<strong>The book could not be finished.</strong><br>${escape(event.message)}${event.usage ? `<br><small>Spent so far: ${escape(formatUsage(event.usage))}</small>` : ''}`, true);
    finish();
  } else if (event.stage === 'done' && event.result) {
    markStage('done');
    const r = event.result;
    showResult(`<strong>${escape(r.title)}</strong><br>${escape(r.summary)}<br><a class="open" href="${escape(r.url)}" target="_blank" rel="noopener">Open the book →</a>
      <br><small>${escape(r.owner)}/${escape(r.appName)} · ${escape(formatUsage(r.usage))} · ${r.pages} pages · ${r.images} ${r.artMode === 'svg' ? 'drawings' : 'paintings'} · ${escape(r.model || '')} · ${r.minutes} min</small>`);
    finish();
    loadGallery();
    if (state.editing) loadBoard(state.editing);
  } else if (STAGES.includes(event.stage)) {
    lastStage = event.stage;
    markStage(event.stage);
  }
  if (event.message) logEvent(event);
}

function showResult(html, error = false) {
  const box = $('result');
  box.hidden = false;
  box.classList.toggle('error', error);
  box.innerHTML = html;
}

function resetProgress() {
  $('progress').hidden = false;
  $('result').hidden = true;
  $('log').innerHTML = '';
  seenEvents.clear();
  $('usage').textContent = '';
  $('abort').disabled = false;
  $('abort').textContent = 'Abort';
  lastStage = 'prepare';
  markStage('prepare');
  state.started = Date.now();
  clearInterval(state.timer);
  state.timer = setInterval(() => {
    const s = Math.round((Date.now() - state.started) / 1000);
    $('elapsed').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    tickLiveRow();
  }, 1000);
  $('progress').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function finish() {
  clearInterval(state.timer);
  $('abort').hidden = true;
  storage(s => s.removeItem('auto-story-build'));
  state.buildId = null;
  updateGo();
}

async function consume(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let terminal = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    let end;
    while ((end = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, end).trim();
      pending = pending.slice(end + 1);
      if (!line) continue;
      const event = JSON.parse(line);
      if (event.stage === 'done' || event.stage === 'failed') terminal = true;
      handleEvent(event);
    }
  }
  return terminal;
}

$('go').addEventListener('click', async () => {
  if (!state.doc) return;
  $('go').disabled = true;
  setStatus('');
  if ($('gate').classList.contains('welcome')) $('gate').hidden = true;
  const m = modelSettings();
  if ($('remember').checked) storage(s => s.setItem(SETTINGS_KEY, JSON.stringify(m)));
  await startStream('/api/builds', {
    title: $('doc-title').value.trim() || state.doc.name, filename: state.doc.name, text: state.doc.text,
    look: lookSettings(),
    llm: { api: m.api, baseUrl: m.baseUrl, model: m.model, apiKey: m.apiKey },
    images: { apiKey: m.imageKey },
  });
});

// Start a build, tweak or rollback and follow its event stream (reattaching if the connection drops).
async function startStream(path, body) {
  resetProgress();
  try {
    const response = await fetch(path, {
      method: 'POST', credentials: 'same-origin', headers: authHeaders({ 'content-type': 'application/json' }), body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `HTTP ${response.status}`);
    const terminal = await consume(response);
    if (!terminal && state.buildId) follow(state.buildId);
  } catch (error) {
    if (state.buildId) return follow(state.buildId);
    showResult(escape(error.message), true);
    markStage('prepare', true);
    finish();
  }
}

$('abort').addEventListener('click', async () => {
  if (!state.buildId || !confirm('Abort this build? Pi stops, and nothing further is painted or deployed.')) return;
  const button = $('abort');
  button.disabled = true;
  button.textContent = 'Aborting…';
  try {
    await api(`/api/builds/${state.buildId}/abort`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
  } catch (error) {
    alert(`Could not abort: ${error.message}`);
    button.disabled = false;
    button.textContent = 'Abort';
    return;
  }
  button.textContent = 'Aborting… (stops at the next checkpoint)';
});

// Reattach to a build after a reload or a dropped connection.
async function follow(id) {
  state.buildId = id;
  updateGo();
  for (let attempt = 0; attempt < 400; attempt++) {
    try {
      const response = await fetch(`/api/builds/${id}/events`, { credentials: 'same-origin', headers: authHeaders() });
      if (response.status === 404 || response.status === 401) { finish(); return; }
      if (await consume(response)) return;
    } catch {}
    await new Promise(r => setTimeout(r, 5000));
  }
}

async function loadGallery() {
  const gallery = $('gallery');
  if (!state.wasmer?.user) {
    gallery.innerHTML = '<p class="empty">Sign in to see the books you have made. Each shelf is private to its Wasmer account.</p>';
    return;
  }
  try {
    const { stories } = await api('/api/stories');
    if (!stories.length) { gallery.innerHTML = '<p class="empty">No books yet. Drop a document to make your first one.</p>'; return; }
    $('gallery').innerHTML = stories.map(s => `
      <div class="book">
        <a class="cover" href="${escape(s.url)}" target="_blank" rel="noopener" style="${s.cover ? `background-image:url('${escape(s.cover)}')` : ''}" aria-label="Read ${escape(s.title)}"></a>
        <div class="meta"><h3>${escape(s.title)}</h3><p>${escape(s.summary || s.metaphor || '')}</p>
        <p>${new Date(s.updatedAt || s.createdAt).toLocaleDateString()}${s.version > 1 ? ` · version ${s.version}` : ''}</p>
        <div class="book-actions"><a href="${escape(s.url)}" target="_blank" rel="noopener">Read ↗</a><a href="#edit/${escape(s.id)}">Edit</a></div></div>
      </div>`).join('');
  } catch (error) {
    gallery.innerHTML = `<p class="empty">Could not load your shelf: ${escape(error.message)}</p>`;
  }
}

loadMe().catch(error => setStatus(error.message, true));
const resume = storage(s => s.getItem('auto-story-build'));
if (resume) { resetProgress(); follow(resume); }

// ── The owner's edit view: mood board, chat and versions of one book ─────────────────────────────
// #edit/<id> opens it. Every field is bound to a path in brief.json or script.json; "Apply changes"
// sends the edited files, the message and the pictures to repaint, and the server re-runs the book
// from the earliest stage those touch, then redeploys the same app.
function route() {
  const id = location.hash.match(/^#edit\/([0-9]{8}-[a-z0-9]{6})$/)?.[1];
  if (id && state.wasmer?.user) openEditor(id);
  else closeEditor();
}
window.addEventListener('hashchange', route);

function openEditor(id) {
  state.editing = id;
  for (const s of ['hero', 'builder', 'shelf']) $(s).hidden = true;
  $('editor').hidden = false;
  $('editor-model-slot').appendChild($('model'));
  loadBoard(id);
}

function closeEditor() {
  if (!state.editing && $('editor').hidden) return;
  state.editing = null;
  state.board = null;
  for (const s of ['hero', 'builder', 'shelf']) $(s).hidden = false;
  $('editor').hidden = true;
  $('builder').insertBefore($('model'), $('builder').querySelector('.actions'));
}

$('editor-back').addEventListener('click', e => { e.preventDefault(); history.pushState(null, '', location.pathname); route(); });

async function loadBoard(id) {
  try {
    const board = await api(`/api/stories/${id}/board`);
    if (state.editing !== id) return;
    state.board = board;
    renderBoard();
    if (board.running && board.running !== state.buildId) { resetProgress(); follow(board.running); }
  } catch (error) {
    $('board').innerHTML = `<p class="empty">Could not open this book: ${escape(error.message)}</p>`;
    $('history').innerHTML = '';
  }
}

const getPath = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);
function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((o, k) => o[k], obj);
  target[last] = value;
}

function field(doc, path, label, { rows = 2, input = false, hint = '' } = {}) {
  const value = getPath(state.board[doc], path) ?? '';
  const attrs = `data-doc="${doc}" data-path="${escape(path)}" ${state.board.editable ? '' : 'disabled'}`;
  const control = input ? `<input ${attrs} value="${escape(value)}">` : `<textarea ${attrs} rows="${rows}">${escape(value)}</textarea>`;
  return `<label class="f"><span>${escape(label)}${hint ? ` <small>${escape(hint)}</small>` : ''}</span>${control}</label>`;
}

function artUrl(file) {
  const b = state.board;
  if (!b.art.includes(file)) return null;
  return `${b.story.url.replace(/\/$/, '')}/art/${file}?v=${b.version}`;
}
function picture(id, alt) {
  const b = state.board;
  const ext = b.story.artMode === 'svg' ? 'svg' : 'webp';
  const url = artUrl(`${id}.${ext}`);
  const repaint = ext === 'webp' && b.canRollback ? `<label class="repaint"><input type="checkbox" data-repaint="${escape(id)}"> Repaint</label>` : '';
  return `<figure class="pic">${url ? `<img src="${escape(url)}" alt="${escape(alt)}" loading="lazy">` : '<div class="nopic">no picture yet</div>'}${repaint}</figure>`;
}

function renderBoard() {
  const b = state.board;
  const s = b.story;
  $('editor-title').textContent = s.title;
  $('editor-sub').textContent = [`version ${b.version || 1}`, s.look, s.model, `${s.pages} pages`].filter(Boolean).join(' · ');
  $('editor-open').href = s.url;
  $('editor-reason').hidden = !b.reason;
  $('editor-reason').textContent = b.reason || '';
  const brief = b.brief, script = b.script;
  const cards = [];
  if (brief) {
    cards.push(`<article class="board-card concept"><h3>Core concept</h3>
      ${field('brief', 'question', 'The question the book answers')}
      ${field('brief', 'answer', 'The answer', { rows: 3 })}
      ${(brief.concepts || []).map((c, i) => `<div class="item">
        ${field('brief', `concepts.${i}.name`, `Concept ${i + 1}`, { input: true })}
        ${field('brief', `concepts.${i}.plain`, 'For a 10-12 year old', { rows: 3 })}
        <details><summary>Precise explanation</summary>${field('brief', `concepts.${i}.precise`, 'For grown-ups', { rows: 4 })}</details>
      </div>`).join('')}
      ${(brief.misconceptions || []).length ? `<details class="item"><summary>Misconceptions to avoid (${brief.misconceptions.length})</summary>
        ${brief.misconceptions.map((m, i) => `${field('brief', `misconceptions.${i}.wrong`, 'Wrong')}${field('brief', `misconceptions.${i}.right`, 'Right')}`).join('')}</details>` : ''}
    </article>`);
  }
  if (script) {
    cards.push(`<article class="board-card characters"><h3>Characters</h3>
      ${(script.characters || []).map((c, i) => `<div class="item with-pic">
        ${picture(`char-${c.id}`, c.name)}
        <div>${field('script', `characters.${i}.name`, 'Name', { input: true })}
        ${field('script', `characters.${i}.is`, 'Stands for', { input: true })}
        ${field('script', `characters.${i}.personality`, 'Personality', { input: true })}
        ${field('script', `characters.${i}.look`, 'Look', { rows: 4, hint: 'changing it repaints this character' })}</div>
      </div>`).join('')}
    </article>`);
    cards.push(`<article class="board-card plot"><h3>Plotline</h3>
      ${field('script', 'title', 'Title', { input: true })}
      ${field('script', 'subtitle', 'Subtitle', { input: true })}
      ${field('script', 'metaphor.world', 'The story world', { rows: 3 })}
      <h4>Ideas, in teaching order</h4>
      ${(script.ideas || []).map((idea, i) => `<div class="item">${field('script', `ideas.${i}.title`, `Idea ${i + 1}`, { input: true })}${field('script', `ideas.${i}.text`, 'What it says')}</div>`).join('')}
      <h4>Pages</h4>
      ${(script.pages || []).map((p, i) => `<div class="item page">
        ${field('script', `pages.${i}.text`, i === 0 ? 'Cover' : `Page ${i} · ${p.idea || ''} · ${p.scene}${p.interaction?.type ? ` · ${p.interaction.type}` : ''}`, { rows: 3 })}
        ${i ? `<details><summary>What it teaches, interaction and note</summary>
          ${field('script', `pages.${i}.teaches`, 'Teaches')}
          ${p.interaction ? field('script', `pages.${i}.interaction.plan`, `Interaction (${p.interaction.type})`, { rows: 3 }) : ''}
          ${field('script', `pages.${i}.note`, 'Note for grown-ups', { rows: 3 })}</details>` : ''}
      </div>`).join('')}
    </article>`);
    cards.push(`<article class="board-card scenes"><h3>Scenes</h3>
      ${(script.scenes || []).map((sc, i) => `<div class="item with-pic">
        ${picture(sc.id, sc.shows)}
        <div><strong>${escape(sc.id)}</strong> <span class="muted">${escape((sc.characters || []).join(', '))}</span>
        ${field('script', `scenes.${i}.shows`, 'What the picture shows', { rows: 4 })}</div>
      </div>`).join('')}
    </article>`);
  } else if (b.art.length) {
    cards.push(`<article class="board-card scenes"><h3>Pictures</h3><div class="pics">${b.art.map(f => `<img src="${escape(artUrl(f))}" alt="${escape(f)}" loading="lazy">`).join('')}</div></article>`);
  }
  $('board').innerHTML = cards.join('') || '<p class="empty">Nothing to show for this book.</p>';
  renderHistory();
  $('tweak-message').disabled = !b.editable;
  $('tweak-from').disabled = !b.editable;
  updateTweak();
}

function renderHistory() {
  const b = state.board;
  $('history').innerHTML = [...b.versions].reverse().map(v => {
    const what = v.kind === 'build' ? 'First edition'
      : v.kind === 'rollback' ? `Rolled back to version ${v.to}`
      : [v.changed?.includes('brief') && 'edited the concepts', v.changed?.includes('script') && 'edited the script',
         v.repainted?.length && `repainted ${v.repainted.length} picture${v.repainted.length === 1 ? '' : 's'}`].filter(Boolean).join(', ');
    const live = v.n === b.version;
    return `<li class="${live ? 'live' : ''}">
      ${v.kind === 'tweak' && v.message ? `<p class="bubble">${escape(v.message)}</p>` : ''}
      <div class="ver"><strong>Version ${v.n}</strong> · ${escape(what || 'rebuilt the book')} · ${escape(v.by || '')} · ${escape(new Date(v.at).toLocaleString())}
        ${live ? '<span class="pill">live</span>' : b.canRollback ? `<button class="ghost small" data-rollback="${v.n}" type="button">Roll back to this</button>` : ''}</div>
    </li>`;
  }).join('') || '<li class="muted">No versions yet.</li>';
  $('history').scrollTop = $('history').scrollHeight;
}

// What the owner changed on the board.
function boardEdits() {
  const b = state.board;
  const docs = { brief: structuredClone(b.brief), script: structuredClone(b.script) };
  let count = 0;
  for (const el of $('board').querySelectorAll('[data-path]')) {
    const original = getPath(b[el.dataset.doc], el.dataset.path) ?? '';
    const changed = el.value !== String(original);
    el.classList.toggle('dirty', changed);
    if (changed) { count++; setPath(docs[el.dataset.doc], el.dataset.path, el.value); }
  }
  const touched = doc => [...$('board').querySelectorAll(`[data-doc="${doc}"].dirty`)].length > 0;
  const repaint = [...$('board').querySelectorAll('[data-repaint]:checked')].map(el => el.dataset.repaint);
  return { count, brief: touched('brief') ? docs.brief : null, script: touched('script') ? docs.script : null, repaint };
}

function updateTweak() {
  if (!state.board) return;
  const edits = boardEdits();
  const message = $('tweak-message').value.trim();
  $('dirty-note').textContent = [edits.count && `${edits.count} edit${edits.count === 1 ? '' : 's'} on the board`,
    edits.repaint.length && `${edits.repaint.length} picture${edits.repaint.length === 1 ? '' : 's'} to repaint`].filter(Boolean).join(' · ');
  const m = modelSettings();
  const needsModel = Boolean(message || edits.brief || edits.script || $('tweak-from').value);
  const hasModel = m.apiKey && m.model && (m.baseUrl || m.api !== 'openai-completions');
  const hasImages = m.imageKey || (m.api === 'openai-responses' && m.apiKey);
  const anything = needsModel || edits.repaint.length;
  $('tweak-go').disabled = !state.board.canRollback || !anything || state.buildId || (needsModel ? !hasModel : !hasImages);
  $('tweak-status').textContent = anything && needsModel && !hasModel ? 'Add your model settings below to apply changes.'
    : anything && !needsModel && !hasImages ? 'Repainting needs an OpenAI key for paintings (below).' : '';
}

$('board').addEventListener('input', updateTweak);
$('board').addEventListener('change', updateTweak);
$('tweak-message').addEventListener('input', updateTweak);
$('tweak-from').addEventListener('change', updateTweak);

$('tweak-go').addEventListener('click', async () => {
  const id = state.editing;
  const edits = boardEdits();
  const m = modelSettings();
  if ($('remember').checked) storage(s => s.setItem(SETTINGS_KEY, JSON.stringify(m)));
  $('tweak-go').disabled = true;
  const body = {
    message: $('tweak-message').value.trim(), from: $('tweak-from').value || undefined,
    brief: edits.brief || undefined, script: edits.script || undefined, repaint: edits.repaint,
    llm: { api: m.api, baseUrl: m.baseUrl, model: m.model, apiKey: m.apiKey }, images: { apiKey: m.imageKey },
  };
  $('tweak-message').value = '';
  $('tweak-from').value = '';
  await startStream(`/api/stories/${id}/tweaks`, body);
});

$('history').addEventListener('click', async e => {
  const n = e.target.closest('[data-rollback]')?.dataset.rollback;
  if (!n || state.buildId) return;
  if (!confirm(`Roll the live book back to version ${n}? Nothing is lost: this becomes a new version, and you can roll forward again.`)) return;
  await startStream(`/api/stories/${state.editing}/rollback`, { version: Number(n) });
});
