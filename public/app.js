// Foster First Night: browser app. All text from the server is inserted with textContent, never innerHTML.
const $ = (id) => document.getElementById(id);
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
};

const PRESETS = [
  { age: 8, fosterCity: 'Boise', favorites: 'Bluey, Encanto, Selena, pozole', triggers: 'dogs, loud yelling', hometown: 'East LA' },
  { age: 13, fosterCity: 'Boise', favorites: 'Naruto, Minecraft, Spider-Man: Into the Spider-Verse, ramen', triggers: 'needles, fire', hometown: 'Houston' },
  { age: 5, fosterCity: 'Boise', favorites: 'Bluey, Peppa Pig, pho', triggers: 'thunder, spiders', hometown: '' },
  { age: 10, fosterCity: 'Boise', favorites: 'Minecraft', triggers: '', hometown: '' },
];
const KIND = { tv: ['Show', 'blue'], film: ['Film', 'amber'], music: ['Music', 'sage'], place: ['Place', 'rose'] };
let marked = [];
let busy = false;

function readForm() {
  return { age: $('age').value, fosterCity: $('fosterCity').value, favorites: $('favorites').value, triggers: $('triggers').value, hometown: $('hometown').value, marked };
}
function fill(p) { $('age').value = p.age; $('fosterCity').value = p.fosterCity; $('favorites').value = p.favorites; $('triggers').value = p.triggers; $('hometown').value = p.hometown; marked = []; renderMarked(); }
document.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => { fill(PRESETS[Number(b.dataset.preset)]); $('go').focus(); }));

function renderMarked() {
  $('markedBox').hidden = !marked.length;
  const ul = $('markedList'); ul.replaceChildren(...marked.map((m) => h('li', {}, h('button', { type: 'button', title: 'Remove', onclick: () => { marked = marked.filter((x) => x.id !== m.id); renderMarked(); } }, `${m.name} \u00d7`))));
}
const showErr = (msg) => { $('err').hidden = !msg; $('err').textContent = msg || ''; };

function item(i, { onMark, onPick } = {}) {
  const [label, tone] = KIND[i.kind] || [i.kind, ''];
  const card = h('div', { class: 'item' },
    h('div', { class: 'top2' }, h('span', { class: `pill ${tone}` }, label), i.rating && h('span', { class: 'pill' }, i.rating), i.fromHometown && h('span', { class: 'pill amber' }, 'Hometown hint'), i.matchedOn && h('span', { class: `pill ${i.matchedOn === 'dish' ? 'sage' : 'amber'}` }, i.matchedOn === 'dish' ? 'Dish match' : 'Cuisine match')),
    h('h4', {}, i.name),
    (i.year || i.genres?.length || i.address) && h('div', { class: 'meta' }, [i.year, (i.genres || []).slice(0, 2).join(', '), i.kind === 'place' ? [i.address].filter(Boolean).join('') : ''].filter(Boolean).join(' \u00b7 ')),
    i.why && h('div', { class: 'why' }, i.why),
    i.because?.length > 1 && h('div', { role: 'img', 'aria-label': `Qloo influence: ${i.because.map((b) => `${b.name} ${b.pct}%`).join(', ')}` },
      (() => { const bar = h('div', { class: 'bar2' }); i.because.slice(0, 4).forEach((b) => { const s = h('i'); s.style.width = `${b.pct}%`; bar.append(s); }); return bar; })(),
      h('div', { class: 'legend' }, i.because.slice(0, 4).map((b) => `${b.name} ${b.pct}%`).join(' \u00b7 '))),
    i.note && h('div', { class: 'note' }, h('b', {}, 'Agent\u2019s note'), i.note),
    onMark && i.kind !== 'place' && h('button', { class: 'scared', type: 'button', onclick: () => onMark(i) }, 'This scared them'));
  return card;
}

function section(title, sub, items, opts) {
  if (!items?.length) return null;
  return h('section', { class: 'sec' }, h('h3', {}, title, sub && h('small', {}, sub)), h('div', { class: 'grid' }, items.map((i, n) => { const c = item(i, opts); c.style.animationDelay = `${n * 50}ms`; return c; })));
}

const REASON = { age: ['Age', 'amber'], trigger: ['Trigger', 'rose'], sensitive: ['Sensitive', 'rose'], marked: ['You marked', 'rose'], place: ['Not a meal', ''] };

function renderPlan(p, trace) {
  const out = $('out');
  const nodes = [];
  if (trace) nodes.push(trace);
  nodes.push(h('div', { class: 'card sum' },
    h('h2', {}, p.summary || `A first night for a ${p.child.age}-year-old`),
    p.matched?.length ? h('p', {}, 'Matched in Qloo: ', p.matched.filter((m) => m.as).map((m) => m.as).join(' \u00b7 ') || 'nothing') : null,
    p.unmatched?.length ? h('p', {}, `Not found in Qloo, left out: ${p.unmatched.join(', ')}.`) : null,
    h('div', { class: 'avoid' }, p.avoiding?.length ? ['Avoiding:', ...p.avoiding.slice(0, 10).map((a) => h('span', { class: 'pill rose' }, a))] : 'No triggers were listed.'),
    p.privacy?.removed?.length ? h('div', { class: 'note-bar', style: 'margin-top:14px' }, `Removed before sending: ${p.privacy.removed.join(', ')}. Share only first names or none at all.`) : null,
    p.agent?.fallback ? h('div', { class: 'note-bar', style: 'margin-top:14px' }, p.agent.fallback) : null));
  const opts = { onMark: (it) => { if (!marked.some((m) => m.id === it.id)) marked.push({ id: it.id, name: it.name, keywords: it.keywords || [], genres: it.genres || [] }); renderMarked(); run(); } };
  const watch = [...(p.sections.tv || []), ...(p.sections.film || [])];
  nodes.push(section('To watch', 'Qloo, rated for this age', watch, opts));
  nodes.push(section('To listen to', 'No age rating exists for music. Preview songs.', p.sections.music, opts));
  nodes.push(section('To eat', p.places?.label || '', p.places?.items, {}));
  if (p.little && p.choices?.length) {
    nodes.push(h('section', { class: 'sec board' }, h('h3', {}, 'Let them choose', h('small', {}, 'Little is known, so offer these instead of guessing. Tap one to add it as a favorite.')),
      h('div', { class: 'grid' }, p.choices.map((c) => { const it = item({ ...c, why: null }); const b = h('button', { class: 'pick', type: 'button', onclick: () => { const f = $('favorites'); f.value = f.value ? `${f.value}, ${c.name}` : c.name; run(); } }, it); return b; }))));
  }
  nodes.push(h('div', { class: 'two' },
    h('section', { class: 'card say' }, h('h3', {}, 'Things you could say'), h('ul', {}, (p.openers || []).map((o) => h('li', {}, o)))),
    h('section', { class: 'card' }, h('h3', {}, 'The evening'), h('ul', { class: 'timeline' }, (p.runOfShow || []).map((r) => h('li', {}, h('b', {}, r.when), h('span', {}, r.text)))))));
  if (p.heldBack?.length) {
    nodes.push(h('details', { class: 'card held' }, h('summary', {}, `Held back (${p.heldBack.length}) and why`),
      h('ul', {}, p.heldBack.map((x) => { const [lbl, tone] = REASON[x.reason] || ['Held', '']; return h('li', {}, h('span', { class: `pill ${tone}` }, lbl), h('span', { class: 'nm' }, x.name), h('em', {}, x.because)); }))));
  }
  nodes.push(h('section', { class: 'card guard' }, h('h3', {}, 'Before you start'), h('ul', {}, (p.guard || []).map((g) => h('li', {}, g))),
    h('p', { class: 'legend', style: 'margin-top:10px' }, `${p.stats?.qlooCalls ?? '?'} Qloo calls in ${((p.stats?.ms ?? 0) / 1000).toFixed(1)}s${p.agent?.model ? `, planned by ${p.agent.model}` : ''}. Nothing was stored.`)));
  out.replaceChildren(...nodes.filter(Boolean));
}

function traceBox() {
  const ol = h('ol'); const title = h('span', {}, 'The agent is planning');
  const box = h('section', { class: 'trace', 'aria-label': 'Agent steps' }, h('h3', {}, h('span', { class: 'dot' }), title), ol);
  return { box, add: (t) => ol.append(h('li', {}, t)), finish: (n) => { box.classList.add('done'); title.textContent = `The agent took ${n} steps`; } };
}

async function run() {
  if (busy) return;
  const body = readForm();
  if (!(Number(body.age) >= 2 && Number(body.age) <= 17)) { showErr('Enter an age from 2 to 17.'); $('age').focus(); return; }
  showErr(''); busy = true; $('go').disabled = true; $('goText').textContent = 'Planning\u2026';
  const t = traceBox();
  $('out').replaceChildren(t.box);
  t.box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  let steps = 0, result = null;
  try {
    const res = await fetch('/api/agent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || 'Something went wrong. Try again.'); }
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl; while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (!line) continue;
        const ev = JSON.parse(line);
        if (ev.type === 'step') { steps++; t.add(ev.text); } else if (ev.type === 'result') result = ev.plan; else if (ev.type === 'error') throw new Error(ev.error);
      }
    }
    if (!result) throw new Error('The plan did not finish. Try again.');
    t.finish(steps);
    const details = h('details', { class: 'trace done' }, h('summary', {}, `How the agent planned this (${steps} steps)`), t.box.querySelector('ol'));
    renderPlan(result, details);
  } catch (e) {
    $('out').replaceChildren(h('div', { class: 'card empty' }, h('h2', {}, 'That did not work'), h('p', {}, e.message)));
  } finally { busy = false; $('go').disabled = false; $('goText').textContent = 'Plan the night'; }
}
$('form').addEventListener('submit', (e) => { e.preventDefault(); run(); });

// For agents: show the real endpoint and a client config.
const base = location.origin;
$('mcpUrl').textContent = `${base}/mcp`;
$('mcpConfig').textContent = JSON.stringify({ mcpServers: { 'foster-first-night': { command: 'npx', args: ['-y', 'mcp-remote', `${base}/mcp`] } } }, null, 2);
document.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => { try { await navigator.clipboard.writeText($(b.dataset.copy).textContent); b.textContent = 'Copied'; setTimeout(() => (b.textContent = 'Copy'), 1500); } catch { /* clipboard unavailable */ } }));
fetch('/api/meta').then((r) => r.json()).then((m) => { if (m.tools) $('mcpTools').textContent = m.tools.join(', '); }).catch(() => {});
