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
  if (!response.ok) throw Object.assign(new Error(body.error || `${path} answered HTTP ${response.status}`), { status: response.status, backend: Boolean(body.error) });
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

// With OpenAI's own API the model key paints too, and the paintings field is hidden. Drop whatever
// that hidden field still holds (a key remembered from earlier), or it would paint with a stale key.
const reusesModelKey = m => m.api === 'openai-responses' && m.baseUrl.replace(/\/+$/, '') === 'https://api.openai.com/v1';

function modelSettings() {
  const m = {
    api: $('llm-api').value, baseUrl: $('llm-base').value.trim(), model: $('llm-model').value.trim(),
    apiKey: $('llm-key').value.trim(), imageKey: $('img-key').value.trim(),
  };
  if (reusesModelKey(m)) m.imageKey = '';
  return m;
}

function modelChanged() {
  const m = modelSettings();
  const reusesKey = reusesModelKey(m);
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
// Click a phase above the log to show only its rows; click it again (or another) to switch back.
// Rows from the end of a run (done, failed) show under every filter.
let logFilter = null;
const PHASE_ALIAS = { upload: 'deploy', failed: 'done' };
function phaseOf(event) {
  const stage = event.stage in PHASE_ALIAS ? PHASE_ALIAS[event.stage] : event.stage;
  return STAGES.includes(stage) ? stage : 'other';
}
const shownIn = (phase, filter) => phase === filter || phase === 'done';
function setLogFilter(phase) {
  logFilter = logFilter === phase ? null : phase;
  document.querySelectorAll('.stages li').forEach(li => li.classList.toggle('filtering', li.dataset.stage === logFilter));
  $('progress').classList.toggle('log-filtered', Boolean(logFilter));
  for (const li of $('log').children) li.hidden = Boolean(logFilter) && !shownIn(li.dataset.phase, logFilter);
  const log = $('log');
  log.scrollTop = log.scrollHeight;
}
document.querySelectorAll('.stages li').forEach(li => {
  li.tabIndex = 0;
  li.setAttribute('role', 'button');
  li.title = 'Show only this phase in the agent log';
  li.addEventListener('click', () => setLogFilter(li.dataset.stage));
  li.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setLogFilter(li.dataset.stage); } });
});

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
  li.dataset.phase = phaseOf(event);
  li.hidden = Boolean(logFilter) && !shownIn(li.dataset.phase, logFilter);
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
    $('transcripts').hidden = false;
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
  if (logFilter) setLogFilter(logFilter);
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

// Without /api/me the page has no backend: say so plainly instead of showing empty controls.
loadMe().catch(error => {
  const gate = $('gate');
  gate.hidden = false;
  gate.className = 'gate denied';
  gate.innerHTML = `<div class="gate-body"><h3>The builder's server is not answering</h3>
    <p>${escape(error.message)}. ${error.backend ? '' : 'This page is being served without its Node backend, so sign-in, building and your shelf cannot work. Deploy the whole app (server and all) with <code>scripts/deploy.sh</code>, which runs <code>wasmer deploy</code> with this repo\'s <code>wasmer.toml</code>; a static-site deploy of <code>public/</code> serves only this page.'}</p></div>`;
  setStatus('');
});
const resume = storage(s => s.getItem('auto-story-build'));
if (resume) { resetProgress(); follow(resume); }


// ── The owner's edit view: a calm mood board, a chat with the editor agent, versions ─────────────
// #edit/<id> opens it. The board shows a draft of brief.json and script.json: the owner's own edits
// and the editor agent's edits both change the draft, and each change shows up in its card as it
// happens. "Rebuild the book" sends the draft as a tweak; the server rebuilds from the earliest
// stage it touches and redeploys the same app.
const ed = { draft: null, open: new Set(), chat: [], notes: '', repaint: new Set(), chatting: false };
const clone = value => JSON.parse(JSON.stringify(value ?? null));
const chatKey = id => `auto-story-chat-${id}`;

function route() {
  const id = location.hash.match(/^#edit\/([0-9]{8}-[a-z0-9]{6})$/)?.[1];
  if (id && state.wasmer?.user) openEditor(id);
  else closeEditor();
}
window.addEventListener('hashchange', route);

function openEditor(id) {
  if (state.editing !== id) {
    ed.chat = storage(s => JSON.parse(s.getItem(chatKey(id)) || '[]')) || [];
    ed.open = new Set();
  }
  state.editing = id;
  document.body.classList.add('editing');
  for (const s of ['hero', 'builder', 'shelf']) $(s).hidden = true;
  $('editor').hidden = false;
  $('editor-model-slot').appendChild($('model'));
  loadBoard(id);
}

function closeEditor() {
  if (!state.editing && $('editor').hidden) return;
  state.editing = null;
  state.board = null;
  document.body.classList.remove('editing');
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
    resetDraft();
    renderAll();
    if (board.running && board.running !== state.buildId) { resetProgress(); follow(board.running); }
  } catch (error) {
    $('board').innerHTML = `<p class="empty">Could not open this book: ${escape(error.message)}</p>`;
    $('history').innerHTML = '';
  }
}

function resetDraft() {
  ed.draft = { brief: clone(state.board.brief), script: clone(state.board.script) };
  ed.notes = '';
  ed.repaint = new Set();
  $('tweak-message').value = '';
  $('tweak-from').value = '';
}

const getPath = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);
function setPath(obj, path, value, remove = false) {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((o, k) => o?.[k], obj);
  if (!target) return;
  if (remove) { if (Array.isArray(target)) target.splice(Number(last), 1); else delete target[last]; }
  else target[last] = value;
}

// How many leaf values differ between two JSON values.
function diffCount(a, b) {
  if (a === b) return 0;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    let n = 0;
    for (const k of keys) n += diffCount(a[k], b[k]);
    return n;
  }
  return JSON.stringify(a) === JSON.stringify(b) ? 0 : 1;
}

function changes() {
  const b = state.board;
  const brief = diffCount(b.brief, ed.draft.brief), script = diffCount(b.script, ed.draft.script);
  return { brief, script, total: brief + script };
}

// The card and item a path belongs to, so an edit can open them.
function keysFor(file, path) {
  const [head, index] = path.split('.');
  if (file === 'brief') return head === 'concepts' && index !== undefined ? ['concept', `concepts.${index}`] : head === 'misconceptions' ? ['concept', 'misconceptions'] : ['concept'];
  if (['characters', 'pages', 'scenes'].includes(head)) return index !== undefined ? [head, `${head}.${index}`] : [head];
  if (head === 'ideas') return index !== undefined ? ['story', `ideas.${index}`] : ['story'];
  return ['story'];
}

function field(doc, path, label, { input = false, hint = '' } = {}) {
  const value = getPath(ed.draft[doc], path) ?? '';
  const original = getPath(state.board[doc], path) ?? '';
  const dirty = String(value) !== String(original) ? ' dirty' : '';
  const attrs = `data-doc="${doc}" data-path="${escape(path)}" class="${dirty.trim()}" ${state.board.editable ? '' : 'disabled'}`;
  const control = input ? `<input ${attrs} value="${escape(value)}">` : `<textarea ${attrs} rows="2">${escape(value)}</textarea>`;
  return `<label class="f"><span>${escape(label)}${hint ? ` <small>${escape(hint)}</small>` : ''}</span>${control}</label>`;
}

function artUrl(file) {
  const b = state.board;
  if (!b.art.includes(file)) return null;
  return `${b.story.url.replace(/\/$/, '')}/art/${file}?v=${b.version}`;
}
function art(id) {
  const ext = state.board.story.artMode === 'svg' ? 'svg' : 'webp';
  return artUrl(`${id}.${ext}`);
}
function thumb(id, alt, cls = '') {
  const url = art(id);
  return url ? `<img class="${cls}" src="${escape(url)}" alt="${escape(alt)}" loading="lazy">` : `<span class="${cls} nopic" aria-hidden="true"></span>`;
}
function repaintBox(id) {
  if (state.board.story.artMode === 'svg' || !state.board.canRollback) return '';
  return `<label class="repaint"><input type="checkbox" data-repaint="${escape(id)}" ${ed.repaint.has(id) ? 'checked' : ''}> Repaint this picture</label>`;
}

const isOpen = key => ed.open.has(key) ? ' open' : '';
const clip = (text, n = 140) => { const t = String(text || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const changedIn = (doc, prefix) => diffCount(getPath(state.board[doc], prefix), getPath(ed.draft[doc], prefix)) > 0;
const mark = (doc, prefix) => changedIn(doc, prefix) ? '<span class="changed" title="Changed, not yet rebuilt">●</span>' : '';

function card(key, title, summary, body, changed = '') {
  return `<details class="board-card ${key}" data-key="${key}"${isOpen(key)}>
    <summary><span class="card-title">${title} ${changed}</span><span class="card-summary">${summary}</span></summary>
    <div class="card-body">${body}</div></details>`;
}
function item(key, summary, body, changed = '') {
  return `<details class="item" data-key="${key}"${isOpen(key)}><summary>${summary} ${changed}</summary><div class="item-body">${body}</div></details>`;
}

function renderBoard() {
  const b = state.board, { brief, script } = ed.draft;
  const cards = [];
  if (brief) {
    const concepts = brief.concepts || [];
    cards.push(card('concept', 'Core concept',
      `<span class="lead">${escape(clip(brief.question, 160))}</span><span class="chips">${concepts.map(c => `<span class="chip">${escape(c.name)}</span>`).join('')}</span>`,
      `${field('brief', 'question', 'The question')}${field('brief', 'answer', 'The answer')}
       ${concepts.map((c, i) => item(`concepts.${i}`, `<strong>${escape(c.name)}</strong> <span class="muted">${escape(clip(c.plain, 90))}</span>`,
         `${field('brief', `concepts.${i}.name`, 'Name', { input: true })}${field('brief', `concepts.${i}.plain`, 'For a 10-12 year old')}${field('brief', `concepts.${i}.precise`, 'For grown-ups')}`,
         mark('brief', `concepts.${i}`))).join('')}
       ${(brief.misconceptions || []).length ? item('misconceptions', `<strong>Misconceptions to avoid</strong> <span class="muted">${brief.misconceptions.length}</span>`,
         brief.misconceptions.map((m, i) => `${field('brief', `misconceptions.${i}.wrong`, 'Wrong')}${field('brief', `misconceptions.${i}.right`, 'Right')}`).join(''), mark('brief', 'misconceptions')) : ''}`,
      mark('brief', '')));
  }
  if (script) {
    const chars = script.characters || [];
    cards.push(card('characters', 'Characters',
      `<span class="faces">${chars.map(c => `<span class="face">${thumb(`char-${c.id}`, c.name, 'avatar')}<span>${escape(c.name)}</span></span>`).join('')}</span>`,
      chars.map((c, i) => item(`characters.${i}`, `${thumb(`char-${c.id}`, c.name, 'avatar small')}<strong>${escape(c.name)}</strong> <span class="muted">${escape(clip(c.is, 70))}</span>`,
        `<div class="with-pic">${thumb(`char-${c.id}`, c.name, 'sheet')}<div>${field('script', `characters.${i}.name`, 'Name', { input: true })}
         ${field('script', `characters.${i}.is`, 'Stands for', { input: true })}${field('script', `characters.${i}.personality`, 'Personality', { input: true })}
         ${field('script', `characters.${i}.look`, 'Look', { hint: 'changing it repaints this character' })}${repaintBox(`char-${c.id}`)}</div></div>`,
        mark('script', `characters.${i}`))).join(''),
      mark('script', 'characters')));
    cards.push(card('story', 'Story',
      `<span class="lead">${escape(script.title || '')}</span><span class="muted">${escape(clip(script.subtitle || script.metaphor?.world, 140))}</span>`,
      `${field('script', 'title', 'Title', { input: true })}${field('script', 'subtitle', 'Subtitle', { input: true })}${field('script', 'metaphor.world', 'The story world')}
       <h4>Ideas, in teaching order</h4>
       ${(script.ideas || []).map((idea, i) => item(`ideas.${i}`, `<strong>${i + 1}. ${escape(idea.title)}</strong>`,
         `${field('script', `ideas.${i}.title`, 'Title', { input: true })}${field('script', `ideas.${i}.text`, 'What it says')}`, mark('script', `ideas.${i}`))).join('')}`,
      ['title', 'subtitle', 'metaphor', 'ideas'].some(k => changedIn('script', k)) ? '<span class="changed">●</span>' : ''));
    const pages = script.pages || [];
    cards.push(card('pages', 'Pages', `<span class="muted">${pages.length} pages · ${pages.filter(p => p.interaction).length} interactive</span>`,
      pages.map((p, i) => item(`pages.${i}`, `<span class="pno">${i === 0 ? 'Cover' : i}</span><span class="muted">${escape(clip(p.text, 110))}</span>`,
        `${field('script', `pages.${i}.text`, i === 0 ? 'Cover text' : `Text · ${p.idea || ''} · scene ${p.scene}`)}
         ${i ? `${field('script', `pages.${i}.teaches`, 'What it teaches')}${p.interaction ? field('script', `pages.${i}.interaction.plan`, `Interaction (${p.interaction.type})`) : ''}${field('script', `pages.${i}.note`, 'Note for grown-ups')}` : ''}`,
        mark('script', `pages.${i}`))).join(''),
      mark('script', 'pages')));
    const scenes = script.scenes || [];
    cards.push(card('scenes', 'Scenes', `<span class="thumbs">${scenes.map(sc => thumb(sc.id, sc.shows, 'mini')).join('')}</span>`,
      scenes.map((sc, i) => item(`scenes.${i}`, `${thumb(sc.id, sc.shows, 'mini')}<strong>${escape(sc.id)}</strong> <span class="muted">${escape(clip(sc.shows, 80))}</span>`,
        `<div class="with-pic wide">${thumb(sc.id, sc.shows, 'backdrop')}<div>${field('script', `scenes.${i}.shows`, 'What the picture shows', { hint: 'changing it repaints this scene' })}${repaintBox(sc.id)}</div></div>`,
        mark('script', `scenes.${i}`))).join(''),
      mark('script', 'scenes')));
  } else if (b.art.length) {
    cards.push(card('pictures', 'Pictures', `<span class="thumbs">${b.art.slice(0, 8).map(f => `<img class="mini" src="${escape(artUrl(f))}" alt="" loading="lazy">`).join('')}</span>`,
      `<div class="pics">${b.art.map(f => `<img src="${escape(artUrl(f))}" alt="${escape(f)}" loading="lazy">`).join('')}</div>`));
  }
  $('board').innerHTML = cards.join('') || '<p class="empty">Nothing to show for this book.</p>';
}

function renderHead() {
  const b = state.board, s = b.story;
  $('editor-title').textContent = s.title;
  $('editor-sub').textContent = [`version ${b.version || 1}`, s.look, `${s.pages} pages`].filter(Boolean).join(' · ');
  $('editor-open').href = s.url;
  $('editor-reason').hidden = !b.reason;
  $('editor-reason').textContent = b.reason || '';
}

function renderHistory() {
  const b = state.board;
  $('history').innerHTML = [...b.versions].reverse().map(v => {
    const what = v.kind === 'build' ? 'First edition'
      : v.kind === 'rollback' ? `Rolled back to version ${v.to}`
      : [v.message && `“${clip(v.message, 80)}”`, v.changed?.includes('brief') && 'concepts edited', v.changed?.includes('script') && 'story edited',
         v.repainted?.length && `${v.repainted.length} picture${v.repainted.length === 1 ? '' : 's'} repainted`].filter(Boolean).join(' · ');
    const live = v.n === b.version;
    return `<li class="${live ? 'live' : ''}"><strong>Version ${v.n}</strong> <span class="muted">${escape(new Date(v.at).toLocaleString())}</span><br>${escape(what || 'Rebuilt')}
      ${live ? ' <span class="pill">live</span>' : b.canRollback ? ` <button class="ghost small" data-rollback="${v.n}" type="button">Roll back to this</button>` : ''}
      ${v.kind !== 'rollback' ? ` <button class="ghost small" data-transcripts="${escape(v.job || b.story.id)}" type="button">Agent transcripts</button>` : ''}</li>`;
  }).join('') || '<li class="muted">No versions yet.</li>';
}

function renderChat() {
  const log = $('chat-log');
  log.innerHTML = ed.chat.map(m => `<li class="msg ${m.role}">${m.role === 'assistant' ? '<span class="who">Editor</span>' : ''}<p>${escape(m.text)}</p>${
    m.edits?.length ? `<ul class="edits">${m.edits.map(e => `<li>✎ ${escape(describeEdit(e))}</li>`).join('')}</ul>` : ''}</li>`).join('')
    || `<li class="msg hint"><p>Try: “Make the story funnier”, “Give ${escape(ed.draft?.script?.characters?.[0]?.name || 'the hero')} a red scarf”, “Explain the second concept more simply”, or “Cut page 3”.</p></li>`;
  log.scrollTop = log.scrollHeight;
}

function describeEdit(e) {
  const d = ed.draft, [head, index, ...rest] = e.path.split('.');
  const doc = d[e.file];
  const name = head === 'characters' ? doc.characters?.[index]?.name : head === 'scenes' ? `scene ${doc.scenes?.[index]?.id}` : head === 'pages' ? (index === '0' ? 'the cover' : `page ${index}`)
    : head === 'concepts' ? doc.concepts?.[index]?.name : head === 'ideas' ? `idea ${Number(index) + 1}` : null;
  const what = rest.length ? rest.join(' ') : head;
  return e.op === 'remove' ? `removed ${name || e.path}` : `${name ? `${name}: ` : ''}${what === head && name ? head.replace(/s$/, '') : what}`;
}

function renderPending() {
  const c = changes();
  const repaint = ed.repaint.size, notes = $('tweak-message').value.trim();
  const any = c.total || repaint || notes || $('tweak-from').value;
  $('pending').hidden = !any || !state.board.canRollback;
  $('dirty-note').textContent = [c.total && `${c.total} change${c.total === 1 ? '' : 's'} on the board`, repaint && `${repaint} picture${repaint === 1 ? '' : 's'} to repaint`, notes && 'notes for the rebuild']
    .filter(Boolean).join(' · ') + (any ? ', not yet in the book.' : '');
  updateTweak();
}

function renderAll() {
  renderHead();
  renderBoard();
  renderHistory();
  renderChat();
  renderPending();
  const editable = state.board.editable;
  $('chat-input').disabled = !editable;
  $('chat-form').hidden = !editable;
}

function updateTweak() {
  if (!state.board || !ed.draft) return;
  const c = changes();
  const m = modelSettings();
  const notes = $('tweak-message').value.trim();
  const needsModel = Boolean(c.total || notes || $('tweak-from').value);
  const hasModel = m.apiKey && m.model && (m.baseUrl || m.api !== 'openai-completions');
  const hasImages = m.imageKey || (m.api === 'openai-responses' && m.apiKey);
  $('tweak-go').disabled = Boolean(state.buildId || ed.chatting || (needsModel ? !hasModel : !hasImages));
  $('tweak-status').textContent = needsModel && !hasModel ? 'Add your model key under Model settings to rebuild.'
    : !needsModel && !hasImages ? 'Repainting needs an OpenAI key for paintings (Model settings).' : '';
  $('chat-send').disabled = Boolean(ed.chatting || !hasModel);
  $('chat-status').textContent = !hasModel ? 'Add your model key under Model settings to chat with the editor.' : '';
  if (!hasModel) $('model-details').open = true;
}

// The owner's own edits.
$('board').addEventListener('input', e => {
  const el = e.target.closest('[data-path]');
  if (!el) return;
  setPath(ed.draft[el.dataset.doc], el.dataset.path, el.value);
  el.classList.toggle('dirty', String(el.value) !== String(getPath(state.board[el.dataset.doc], el.dataset.path) ?? ''));
  renderPending();
});
$('board').addEventListener('change', e => {
  const box = e.target.closest('[data-repaint]');
  if (box) { box.checked ? ed.repaint.add(box.dataset.repaint) : ed.repaint.delete(box.dataset.repaint); renderPending(); }
});
$('board').addEventListener('toggle', e => {
  const key = e.target.dataset?.key;
  if (key) e.target.open ? ed.open.add(key) : ed.open.delete(key);
}, true);
$('tweak-message').addEventListener('input', renderPending);
$('tweak-from').addEventListener('change', renderPending);
$('discard').addEventListener('click', () => {
  if (!confirm('Discard all changes on the board that are not in the book yet?')) return;
  resetDraft();
  renderBoard();
  renderPending();
});

// Show an edit where it happened: open its card and item, and flash the field.
function showEdit(e) {
  for (const key of keysFor(e.file, e.path)) ed.open.add(key);
  renderBoard();
  const fields = [...$('board').querySelectorAll(`[data-doc="${e.file}"]`)].filter(el => el.dataset.path === e.path || el.dataset.path.startsWith(`${e.path}.`));
  const target = fields[0] || $('board').querySelector(`[data-key="${keysFor(e.file, e.path).at(-1)}"]`);
  for (const el of fields) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
  target?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

$('chat-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('chat-form').requestSubmit(); }
});

$('chat-form').addEventListener('submit', async e => {
  e.preventDefault();
  const text = $('chat-input').value.trim();
  if (!text || ed.chatting) return;
  const id = state.editing;
  const m = modelSettings();
  if ($('remember').checked) storage(s => s.setItem(SETTINGS_KEY, JSON.stringify(m)));
  ed.chat.push({ role: 'user', text });
  const reply = { role: 'assistant', text: '', edits: [] };
  ed.chat.push(reply);
  $('chat-input').value = '';
  ed.chatting = true;
  updateTweak();
  renderChat();
  const log = $('chat-log');
  log.lastElementChild.classList.add('thinking');
  const save = () => storage(s => s.setItem(chatKey(id), JSON.stringify(ed.chat.slice(-40).map(({ role, text, edits }) => ({ role, text, edits })))));
  try {
    const response = await fetch(`/api/stories/${id}/chat`, {
      method: 'POST', credentials: 'same-origin', headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        messages: ed.chat.slice(0, -1).map(({ role, text }) => ({ role, text })),
        brief: ed.draft.brief, script: ed.draft.script, notes: $('tweak-message').value, repaint: [...ed.repaint],
        llm: { api: m.api, baseUrl: m.baseUrl, model: m.model, apiKey: m.apiKey },
      }),
    });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `HTTP ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let end;
      while ((end = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, end).trim();
        pending = pending.slice(end + 1);
        if (!line || state.editing !== id) continue;
        const ev = JSON.parse(line);
        if (ev.type === 'edit') {
          setPath(ed.draft[ev.file], ev.path, ev.value, ev.op === 'remove');
          reply.edits.push(ev);
          showEdit(ev);
        } else if (ev.type === 'text') {
          reply.text = reply.text ? `${reply.text}\n\n${ev.text}` : ev.text;
        } else if (ev.type === 'notes') {
          $('tweak-message').value = ev.notes;
          $('pending').querySelector('.rebuild-opts').open = true;
        } else if (ev.type === 'repaint') {
          ed.repaint = new Set(ev.ids);
          renderBoard();
        } else if (ev.type === 'done') {
          if (ev.brief !== undefined && ev.script !== undefined) { ed.draft = { brief: ev.brief, script: ev.script }; renderBoard(); }
        } else if (ev.type === 'error') {
          reply.text = `${reply.text ? `${reply.text}\n\n` : ''}Something went wrong: ${ev.error}`;
          reply.error = true;
        }
        if (['edit', 'text', 'error', 'notes', 'repaint'].includes(ev.type)) { renderChat(); log.lastElementChild?.classList.add('thinking'); renderPending(); }
      }
    }
  } catch (error) {
    reply.text = `Something went wrong: ${error.message}`;
  }
  if (!reply.text) reply.text = reply.edits.length ? 'Done.' : 'I did not change anything.';
  ed.chatting = false;
  save();
  if (state.editing === id) { renderChat(); renderPending(); }
});

$('tweak-go').addEventListener('click', async () => {
  const id = state.editing;
  const c = changes();
  const m = modelSettings();
  if ($('remember').checked) storage(s => s.setItem(SETTINGS_KEY, JSON.stringify(m)));
  $('tweak-go').disabled = true;
  const message = $('tweak-message').value.trim();
  const asked = ed.chat.filter(x => x.role === 'user').slice(-6).map(x => x.text);
  const body = {
    message: message || (asked.length && c.total ? `Changes discussed with the editor: ${asked.join(' / ')}`.slice(0, 3900) : ''),
    from: $('tweak-from').value || undefined,
    brief: c.brief ? ed.draft.brief : undefined, script: c.script ? ed.draft.script : undefined, repaint: [...ed.repaint],
    llm: { api: m.api, baseUrl: m.baseUrl, model: m.model, apiKey: m.apiKey }, images: { apiKey: m.imageKey },
  };
  ed.chat.push({ role: 'assistant', text: 'Rebuilding the book with these changes. Follow along below.' });
  storage(s => s.setItem(chatKey(id), JSON.stringify(ed.chat.slice(-40))));
  renderChat();
  await startStream(`/api/stories/${id}/tweaks`, body);
});

$('history').addEventListener('click', async e => {
  const job = e.target.closest('[data-transcripts]')?.dataset.transcripts;
  if (job) return openTranscripts(job);
  const n = e.target.closest('[data-rollback]')?.dataset.rollback;
  if (!n || state.buildId) return;
  if (!confirm(`Roll the live book back to version ${n}? Nothing is lost: this becomes a new version, and you can roll forward again.`)) return;
  await startStream(`/api/stories/${state.editing}/rollback`, { version: Number(n) });
});

// ── Agent transcripts: every agent session of a build or tweak, for debugging ────────────────────
let transcriptsJob = null;
async function openTranscripts(id) {
  transcriptsJob = id;
  const dialog = $('transcripts-dialog');
  const list = $('transcripts-list');
  $('transcripts-view').hidden = true;
  list.innerHTML = '<li class="muted">Loading…</li>';
  if (!dialog.open) dialog.showModal();
  try {
    const { transcripts } = await api(`/api/builds/${id}/transcripts`);
    list.innerHTML = transcripts.map(t => `<li data-name="${escape(t.name)}">
      <button class="ghost small" data-read="${escape(t.name)}" type="button">Read</button>
      <span>${escape(t.role || t.step)}${t.stage ? ` · ${escape(t.stage)}` : ''} · <code>${escape(t.name.replace(/^transcripts\//, ''))}</code> · ${Math.max(1, Math.round(t.bytes / 1024))} KiB${t.legacy ? ' · abridged (older build)' : ''}</span></li>`).join('')
      || '<li class="muted">This run has no agent transcripts (nothing was written, or it only repainted or rolled back).</li>';
  } catch (error) {
    list.innerHTML = `<li class="muted">Could not load transcripts: ${escape(error.message)}</li>`;
  }
}

async function fetchAuthed(path) {
  const response = await fetch(path, { credentials: 'same-origin', headers: authHeaders() });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `HTTP ${response.status}`);
  return response;
}

$('transcripts').addEventListener('click', () => state.buildId && openTranscripts(state.buildId));
$('transcripts-close').addEventListener('click', () => $('transcripts-dialog').close());
$('transcripts-list').addEventListener('click', async e => {
  const name = e.target.closest('[data-read]')?.dataset.read;
  if (!name) return;
  const view = $('transcripts-view');
  for (const li of $('transcripts-list').children) li.classList.toggle('open', li.dataset.name === name);
  view.hidden = false;
  view.textContent = 'Loading…';
  try {
    view.textContent = await (await fetchAuthed(`/api/builds/${transcriptsJob}/transcripts/${encodeURIComponent(name.replace(/\.ndjson$/, '.txt'))}`)).text();
    view.scrollTop = 0;
  } catch (error) { view.textContent = `Could not load it: ${error.message}`; }
});
$('transcripts-zip').addEventListener('click', async () => {
  const button = $('transcripts-zip');
  button.disabled = true;
  try {
    const blob = await (await fetchAuthed(`/api/builds/${transcriptsJob}/transcripts.zip`)).blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `transcripts-${transcriptsJob}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  } catch (error) { alert(`Could not download: ${error.message}`); }
  finally { button.disabled = false; }
});
