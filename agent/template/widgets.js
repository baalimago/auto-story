// Built-in teaching widgets. story.js configures them with plain data; no code needed.
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const child of children.flat()) if (child != null) el.append(child);
  return el;
}

const chipOf = c => (typeof c === 'string' ? { text: c } : c);
function chips(list = []) {
  return h('div', { class: 'w-chips' }, list.map(chipOf).map(c => h('span', { class: `w-chip ${c.state || ''}` }, c.text)));
}

// A process, one step at a time.
function stepper(cfg) {
  let i = 0;
  const dots = cfg.steps.map((_, n) => h('button', { class: 'w-dot', type: 'button', 'aria-label': `Step ${n + 1}`, onclick: () => show(n) }));
  const label = h('div', { class: 'w-step-label' });
  const caption = h('p', { class: 'w-caption' });
  const chipBox = h('div');
  const back = h('button', { class: 'w-btn ghost', type: 'button', onclick: () => show(i - 1) }, '← Back');
  const next = h('button', { class: 'w-btn', type: 'button', onclick: () => show(i + 1) }, 'Next →');
  function show(n) {
    i = Math.max(0, Math.min(cfg.steps.length - 1, n));
    const step = cfg.steps[i];
    dots.forEach((d, k) => d.classList.toggle('on', k <= i));
    label.textContent = `${i + 1}/${cfg.steps.length} · ${step.label}`;
    caption.textContent = step.caption || '';
    chipBox.replaceChildren(step.chips ? chips(step.chips) : '');
    back.disabled = i === 0;
    next.disabled = i === cfg.steps.length - 1;
  }
  const el = h('div', {}, h('div', { class: 'w-dots' }, dots), label, chipBox, caption, h('div', { class: 'w-actions' }, back, next));
  show(0);
  return el;
}

// Limited capacity: choose what fits; the oldest choice falls out.
function squeeze(cfg) {
  const chosen = [];
  const slots = h('div', { class: 'w-slots' });
  const note = h('p', { class: 'w-caption' }, cfg.prompt || `Room for ${cfg.capacity}. Tap what you would keep.`);
  const spilled = h('div', { class: 'w-spill' });
  const buttons = cfg.items.map((item, n) => h('button', { class: 'w-item', type: 'button', onclick: () => pick(n) }, item.text));
  function render() {
    buttons.forEach((b, n) => b.classList.toggle('on', chosen.includes(n)));
    slots.replaceChildren(...Array.from({ length: cfg.capacity }, (_, k) =>
      h('span', { class: `w-slot ${chosen[k] !== undefined ? 'full' : ''}` }, chosen[k] !== undefined ? cfg.items[chosen[k]].text : '')));
    if (chosen.length < cfg.capacity) return;
    const important = cfg.items.map((it, n) => (it.important ? n : -1)).filter(n => n >= 0);
    const good = important.every(n => chosen.includes(n)) || chosen.every(n => cfg.items[n].important);
    note.textContent = good ? cfg.good : cfg.bad;
    note.className = `w-caption ${good ? 'w-good' : 'w-bad'}`;
  }
  function pick(n) {
    const at = chosen.indexOf(n);
    if (at >= 0) chosen.splice(at, 1);
    else {
      chosen.push(n);
      if (chosen.length > cfg.capacity) {
        const out = chosen.shift();
        const drop = h('span', { class: 'w-chip dropped' }, cfg.items[out].text);
        spilled.append(drop);
        setTimeout(() => drop.remove(), 1600);
      }
    }
    render();
  }
  render();
  return h('div', {}, h('div', { class: 'w-items' }, buttons), h('div', { class: 'w-box' }, slots, spilled), note);
}

// Before/after, or A vs B.
function compare(cfg) {
  const body = h('div');
  const tabs = ['a', 'b'].map(side => h('button', { class: 'w-tab', type: 'button', onclick: () => show(side) }, cfg[side].label));
  function show(side) {
    tabs.forEach((t, k) => t.classList.toggle('on', ['a', 'b'][k] === side));
    const s = cfg[side];
    body.replaceChildren(s.chips ? chips(s.chips) : '', h('p', { class: 'w-caption' }, s.caption || ''));
  }
  show('a');
  return h('div', {}, h('div', { class: 'w-tabs' }, tabs), body);
}

// Cause and effect: drag an amount, see the outcome.
function slider(cfg) {
  const points = [...cfg.points].sort((p, q) => p.at - q.at);
  const value = h('span', { class: 'w-value' });
  const meter = h('div', { class: 'w-meter' }, h('span'));
  const outcome = h('p', { class: 'w-caption' });
  const input = h('input', { type: 'range', min: cfg.min, max: cfg.max, step: cfg.step || 1, value: cfg.start ?? cfg.min, 'aria-label': cfg.label });
  function update() {
    const v = Number(input.value);
    const point = points.reduce((best, p) => (Math.abs(p.at - v) < Math.abs(best.at - v) ? p : best), points[0]);
    value.textContent = `${v}${cfg.unit ? ` ${cfg.unit}` : ''}`;
    meter.firstChild.style.width = `${Math.max(0, Math.min(100, point.meter ?? 0))}%`;
    outcome.textContent = point.outcome;
  }
  input.addEventListener('input', update);
  update();
  return h('div', {}, h('label', { class: 'w-slider' }, h('span', {}, cfg.label, ': ', value), input),
    h('div', { class: 'w-meter-row' }, h('span', { class: 'w-meter-label' }, cfg.meterLabel || ''), meter), outcome);
}

// A quick check of understanding.
function quiz(cfg) {
  const why = h('p', { class: 'w-caption' });
  const buttons = cfg.choices.map(choice => h('button', { class: 'w-item', type: 'button', onclick: () => answer(choice) }, choice.text));
  function answer(choice) {
    buttons.forEach((b, k) => {
      b.classList.toggle('right', cfg.choices[k].correct);
      b.classList.toggle('wrong', cfg.choices[k] === choice && !choice.correct);
    });
    why.textContent = `${choice.correct ? 'Yes! ' : 'Not quite. '}${choice.why || ''}`;
    why.className = `w-caption ${choice.correct ? 'w-good' : 'w-bad'}`;
  }
  return h('div', {}, h('p', { class: 'w-question' }, cfg.question), h('div', { class: 'w-items column' }, buttons), why);
}

export const WIDGETS = { stepper, squeeze, compare, slider, quiz };

export function mountWidget(host, cfg) {
  const make = WIDGETS[cfg.type];
  if (!make) throw new Error(`Unknown widget ${cfg.type}`);
  const card = h('div', { class: `widget w-${cfg.type}` }, cfg.title ? h('h4', { class: 'w-title' }, cfg.title) : null, make(cfg));
  host.append(card);
  return () => card.remove();
}
