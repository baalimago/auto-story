const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/6.3.289';
const STAGES = ['prepare', 'agent', 'check', 'paint', 'deploy', 'done'];
const $ = id => document.getElementById(id);
const state = { me: null, wasmer: null, doc: null, buildId: null, started: 0, timer: null };

function storage(fn) { try { return fn(localStorage); } catch { return null; } }
function escape(text) {
  return String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function setStatus(text, error = false) { $('status').textContent = text; $('status').classList.toggle('error', error); }

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', ...options });
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
}

function checkToken(token) {
  return api('/api/auth/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
}

function renderAccount() {
  const account = $('account');
  const user = state.wasmer?.user;
  if (!user) { account.innerHTML = ''; return; }
  account.innerHTML = `<span class="who">${WASMER_MARK}<strong>${escape(user.username)}</strong></span><button class="ghost" id="logout">Sign out</button>`;
  $('logout').addEventListener('click', () => { dropToken(); state.wasmer = null; renderAccount(); renderGate(); updateGo(); });
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
          Building is open to an allowlist of Wasmer users and namespaces; anyone can read the shelf.</p>
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
      but only allowlisted Wasmer users and namespaces can build books. You can still read the shelf below.</p></div>`;
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
    const tag = event.kind === 'tool' ? event.tool : event.kind === 'message' ? 'pi' : event.stage;
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
    showResult(`<strong>The book could not be finished.</strong><br>${escape(event.message)}${event.usage ? `<br><small>Spent so far: ${escape(formatUsage(event.usage))}</small>` : ''}`, true);
    finish();
  } else if (event.stage === 'done' && event.result) {
    markStage('done');
    const r = event.result;
    showResult(`<strong>${escape(r.title)}</strong><br>${escape(r.summary)}<br><a class="open" href="${escape(r.url)}" target="_blank" rel="noopener">Open the book →</a>
      <br><small>${escape(r.owner)}/${escape(r.appName)} · ${escape(formatUsage(r.usage))} · ${r.pages} pages · ${r.images} ${r.artMode === 'svg' ? 'drawings' : 'paintings'} · ${escape(r.model || '')} · ${r.minutes} min</small>`);
    finish();
    loadGallery();
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
  resetProgress();
  try {
    const response = await fetch('/api/builds', {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: $('doc-title').value.trim() || state.doc.name, filename: state.doc.name, text: state.doc.text,
        wasmerToken: state.wasmer.token,
        look: lookSettings(),
        llm: { api: m.api, baseUrl: m.baseUrl, model: m.model, apiKey: m.apiKey },
        images: { apiKey: m.imageKey },
      }),
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
});

$('abort').addEventListener('click', async () => {
  if (!state.buildId || !confirm('Abort this build? Pi stops, and nothing further is painted or deployed.')) return;
  const button = $('abort');
  button.disabled = true;
  button.textContent = 'Aborting…';
  try {
    await api(`/api/builds/${state.buildId}/abort`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wasmerToken: state.wasmer?.token }),
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
      const response = await fetch(`/api/builds/${id}/events`, { credentials: 'same-origin' });
      if (response.status === 404) { finish(); return; }
      if (await consume(response)) return;
    } catch {}
    await new Promise(r => setTimeout(r, 5000));
  }
}

async function loadGallery() {
  try {
    const { stories } = await api('/api/stories');
    if (!stories.length) return;
    $('gallery').innerHTML = stories.map(s => `
      <a class="book" href="${escape(s.url)}" target="_blank" rel="noopener">
        <div class="cover" style="${s.cover ? `background-image:url('${escape(s.cover)}')` : ''}"></div>
        <div class="meta"><h3>${escape(s.title)}</h3><p>${escape(s.summary || s.metaphor || '')}</p>
        <p>by ${escape(s.user)} · ${new Date(s.createdAt).toLocaleDateString()}</p></div>
      </a>`).join('');
  } catch {}
}

loadMe().catch(error => setStatus(error.message, true));
loadGallery();
const resume = storage(s => s.getItem('auto-story-build'));
if (resume) { resetProgress(); follow(resume); }
