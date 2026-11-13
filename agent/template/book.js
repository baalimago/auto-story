
// The deploy stamps each picture's content hash into index.html, so a repainted picture gets a new URL
// and no browser or edge cache keeps serving the old picture (or an old 404).
const artVersions = (() => { try { return JSON.parse(document.getElementById('art-versions')?.textContent || '{}'); } catch { return {}; } })();
const artUrl = (id, ext) => `art/${id}.${ext || 'webp'}${artVersions[id] ? `?v=${artVersions[id]}` : ''}`;
// Storybook engine. Story content lives in story.js, interactive scenes in scenes.js.
import { mountWidget } from './widgets.js';
const SVG_NS = 'http://www.w3.org/2000/svg';
const stage = document.getElementById('stage');
const bar = document.querySelector('#progress span');
const prevBtn = document.getElementById('prev');
const nextBtn = document.getElementById('next');

function escape(text) {
  return String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Paragraphs, *emphasis*, **strong**, `code`, and "speech" in the hand font.
function prose(text) {
  return String(text || '').split(/\n\s*\n/).map(block => {
    const html = escape(block.trim())
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`(.+?)`/g, '<code>$1</code>')
      .replace(/\n/g, '<br>');
    return `<p>${html}</p>`;
  }).join('');
}

function node(tag, attrs = {}, html) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (html !== undefined) el.innerHTML = html;
  return el;
}

// Free region opposite the words box, in scene coordinates.
const AREAS = {
  right: { x: 60, y: 140, w: 820, h: 720 },
  left: { x: 620, y: 140, w: 820, h: 720 },
  bottom: { x: 250, y: 40, w: 1000, h: 580 },
};

function createApi(page, svg, hintEl, book, side) {
  const cleanups = [];
  const area = AREAS[side] || AREAS.right;
  const api = {
    svg,
    palette: book.palette,
    page,
    area,
    // A paper card in the free area; draw into the returned group with local coords 0..area.w, 0..area.h.
    card(title) {
      const g = api.el('g', { transform: `translate(${area.x} ${area.y})` });
      const soft = book.theme === 'watercolor';
      api.el('rect', { x: 0, y: 0, width: area.w, height: area.h, rx: soft ? 28 : 6, fill: book.palette.paper, 'fill-opacity': soft ? 0.93 : 1,
        stroke: book.palette.ink, 'stroke-width': soft ? 3 : 6, ...(soft ? { filter: 'url(#wc-ink)' } : {}) }, g);
      if (title) api.text(title, area.w / 2, 64, { 'font-size': 46, 'font-weight': 700 }, g);
      return g;
    },
    el(tag, attrs = {}, parent = svg) {
      const el = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'text') el.textContent = v;
        else el.setAttribute(k, v);
      }
      parent.appendChild(el);
      return el;
    },
    text(content, x, y, attrs = {}, parent = svg) {
      return api.el('text', { x, y, 'text-anchor': 'middle', 'font-size': 44, ...attrs, text: content }, parent);
    },
    hint(text) {
      hintEl.textContent = text || '';
      hintEl.hidden = !text;
    },
    on(target, type, fn, options) {
      target.addEventListener(type, fn, options);
      cleanups.push(() => target.removeEventListener(type, fn, options));
    },
    after(ms, fn) { const id = setTimeout(fn, ms); cleanups.push(() => clearTimeout(id)); return id; },
    every(ms, fn) { const id = setInterval(fn, ms); cleanups.push(() => clearInterval(id)); return id; },
    frame(fn) {
      let id; let last = performance.now();
      const loop = now => { const dt = Math.min(0.05, (now - last) / 1000); last = now; if (fn(dt, now) !== false) id = requestAnimationFrame(loop); };
      id = requestAnimationFrame(loop);
      cleanups.push(() => cancelAnimationFrame(id));
    },
    animate(el, keyframes, options) {
      const anim = el.animate(keyframes, options);
      cleanups.push(() => anim.cancel());
      return anim;
    },
    // Map a pointer event to scene coordinates (viewBox 0 0 1500 1000).
    point(event) {
      const pt = svg.createSVGPoint();
      pt.x = event.clientX; pt.y = event.clientY;
      return pt.matrixTransform(svg.getScreenCTM().inverse());
    },
    cleanup(fn) { cleanups.push(fn); },
    next: () => book.go(book.index + 1),
    prev: () => book.go(book.index - 1),
  };
  return { api, dispose() { while (cleanups.length) { try { cleanups.pop()(); } catch (e) { console.warn(e); } } } };
}

function renderPage(page, index, story) {
  const kind = page.kind || (index === 0 ? 'cover' : 'story');
  let side = page.side || (index % 2 ? 'right' : 'left');
  // Widget pages stack words and widget in one column, so half the painting stays visible.
  if (page.widget && side === 'bottom') side = 'right';
  const section = node('section', { class: `page ${kind} ${side}`, 'data-index': index, 'aria-label': `Page ${index + 1}` });

  if (kind === 'learn') {
    const items = (story.ideas || []).map((idea, n) => `<li><strong>${n + 1}. ${escape(idea.title)}</strong><span>${escape(idea.text)}</span></li>`).join('');
    section.innerHTML = `<div class="sheet"><h2>${escape(page.title || 'What you will find out')}</h2>
      <p class="question">${escape(story.question || '')}</p><ol class="ideas">${items}</ol></div>`;
    return section;
  }

  if (kind === 'answer') {
    const items = (story.ideas || []).map(idea => `<li><strong>${escape(idea.title)}</strong><span>${escape(idea.text)}</span></li>`).join('');
    section.innerHTML = `<div class="sheet"><h2>${escape(page.title || 'So, what is the answer?')}</h2>
      <p class="question">${escape(story.question || '')}</p><p class="answer">${prose(story.answer || '')}</p>
      <h3>What we learned</h3><ul class="ideas">${items}</ul></div>`;
    return section;
  }

  if (kind === 'cast') {
    const portrait = c => c.art ? `<img class="portrait" src="${escape(artUrl(c.art, story.artExtension))}" alt="" loading="lazy" onerror="this.remove()">` : '';
    const rows = (story.cast || []).map(c =>
      `<dt>${portrait(c)}${escape(c.name)}<small>${escape(c.is)}</small></dt><dd>${prose(c.explain)}</dd>`).join('');
    section.innerHTML = `<div class="sheet"><h2>${escape(page.title || 'Who is who')}</h2><dl>${rows}</dl>
      <p class="made">${escape(story.colophon || 'Written by an agent, painted by a machine, served from the edge.')}</p></div>`;
    return section;
  }

  const canvas = node('div', { class: 'canvas' });
  const art = node('div', { class: 'art' });
  if (page.art) {
    const img = node('img', { alt: page.alt || '', decoding: 'async', loading: index < 2 ? 'eager' : 'lazy' });
    img.src = artUrl(page.art, story.artExtension);
    img.onerror = () => { img.remove(); art.classList.add('fallback'); };
    art.appendChild(img);
  } else {
    art.classList.add('fallback');
  }
  canvas.appendChild(art);
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'scene');
  svg.setAttribute('viewBox', '0 0 1500 1000');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid slice');
  canvas.appendChild(svg);
  section.appendChild(canvas);

  const words = node('div', { class: 'words' });
  words.innerHTML = kind === 'cover'
    ? `<h1>${escape(story.title)}</h1>${prose(page.text || story.subtitle)}<p class="byline">${escape(story.byline || '')}</p>`
    : prose(page.text);
  section.appendChild(words);

  const hint = node('div', { class: 'hint' });
  hint.hidden = true;
  section.appendChild(hint);

  if (page.note) {
    const toggle = node('button', { class: 'note-toggle', type: 'button', 'aria-expanded': 'false' }, escape(story.noteLabel || 'For grown-ups'));
    const note = node('aside', { class: 'note' }, `<h3>${escape(page.noteTitle || 'What is really going on')}</h3>${prose(page.note)}`);
    note.hidden = true;
    toggle.addEventListener('click', () => {
      note.hidden = !note.hidden;
      toggle.setAttribute('aria-expanded', String(!note.hidden));
    });
    section.append(toggle, note);
  }
  const ideaIndex = (story.ideas || []).findIndex(i => i.id === page.idea);
  if (ideaIndex >= 0) {
    section.appendChild(node('div', { class: 'idea-chip' }, `Idea ${ideaIndex + 1} of ${story.ideas.length} · ${escape(story.ideas[ideaIndex].title)}`));
  }
  const widgetHost = node('div', { class: 'widget-host' });
  if (page.widget) {
    section.classList.add('has-widget');
    const column = node('div', { class: 'side-column' });
    column.append(words, widgetHost);
    section.appendChild(column);
  } else {
    section.appendChild(widgetHost);
  }
  section._svg = svg;
  section._hint = hint;
  section._widgetHost = widgetHost;
  return section;
}

async function main() {
  let story, scenes = {};
  try {
    story = (await import('./story.js')).default;
    scenes = (await import('./scenes.js')).default || {};
  } catch (error) {
    stage.innerHTML = `<p style="padding:2em">This book could not be opened: ${escape(error.message)}</p>`;
    throw error;
  }
  document.title = story.title;
  const theme = ['watercolor', 'comic', 'manga'].includes(story.theme) ? story.theme : 'watercolor';
  document.body.classList.add(`theme-${theme}`);
  if (story.mono) document.body.classList.add('mono');
  const palette = { paper: '#f6f1e7', ink: '#2f2b27', wash: '#9ccfdc', accent: '#e39a5b', ...(story.palette || {}) };
  for (const [k, v] of Object.entries(palette)) document.documentElement.style.setProperty(`--${k}`, v);

  const pages = [...story.pages];
  if ((story.ideas || []).length && !pages.some(p => p.kind === 'learn')) pages.splice(1, 0, { kind: 'learn' });
  if (story.answer && !pages.some(p => p.kind === 'answer')) pages.push({ kind: 'answer' });
  if ((story.cast || []).length && !pages.some(p => p.kind === 'cast')) pages.push({ kind: 'cast' });
  const sections = pages.map((page, i) => renderPage(page, i, story));
  stage.append(...sections);

  const book = { index: -1, palette, theme, active: null, go };

  function go(target) {
    const index = Math.max(0, Math.min(pages.length - 1, target));
    if (index === book.index) return;
    if (book.active) { book.active.dispose(); book.active = null; }
    const old = sections[book.index];
    if (old) {
      old.classList.remove('current');
      if (old._svg) old._svg.replaceChildren();
      if (old._hint) old._hint.hidden = true;
    }
    book.index = index;
    const section = sections[index];
    section.classList.add('current');
    const page = pages[index];
    if (page.widget && section._widgetHost) {
      try { book.active = { dispose: mountWidget(section._widgetHost, page.widget) }; }
      catch (error) { console.error('Widget failed', error); }
    } else if (page.scene && scenes[page.scene] && section._svg) {
      const side = [...section.classList].find(c => ['left', 'right', 'bottom'].includes(c)) || 'right';
      const handle = createApi(page, section._svg, section._hint, book, side);
      book.active = handle;
      if (page.hint) handle.api.hint(page.hint);
      try { scenes[page.scene](handle.api); } catch (error) { console.error(`Scene ${page.scene} failed`, error); }
    }
    const nextArt = pages[index + 1]?.art;
    if (nextArt) new Image().src = artUrl(nextArt, story.artExtension);
    bar.style.width = `${(index / Math.max(1, pages.length - 1)) * 100}%`;
    prevBtn.disabled = index === 0;
    nextBtn.disabled = index === pages.length - 1;
    if (location.hash !== `#/${index}`) history.replaceState(null, '', `#/${index}`);
  }

  const fromHash = () => { const m = location.hash.match(/^#\/(\d+)/); return m ? Number(m[1]) : 0; };
  prevBtn.addEventListener('click', () => go(book.index - 1));
  nextBtn.addEventListener('click', () => go(book.index + 1));
  window.addEventListener('hashchange', () => go(fromHash()));
  window.addEventListener('keydown', event => {
    if (event.target.closest?.('input, textarea, select')) return;
    if (['ArrowRight', 'PageDown', ' '].includes(event.key)) { event.preventDefault(); go(book.index + 1); }
    if (['ArrowLeft', 'PageUp'].includes(event.key)) { event.preventDefault(); go(book.index - 1); }
    if (event.key === 'Home') go(0);
    if (event.key === 'End') go(pages.length - 1);
  });
  let touch;
  stage.addEventListener('touchstart', e => { touch = e.touches[0]; }, { passive: true });
  stage.addEventListener('touchend', e => {
    if (!touch) return;
    const dx = e.changedTouches[0].clientX - touch.clientX;
    const dy = e.changedTouches[0].clientY - touch.clientY;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) go(book.index + (dx < 0 ? 1 : -1));
    touch = null;
  });
  go(fromHash());
}

main();
