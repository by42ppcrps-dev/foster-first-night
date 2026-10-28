// Deterministic safety layer. Everything an item must pass before a foster parent sees it,
// whether a person, the built-in planner, or an LLM agent asked for it.
// Nothing here calls a network or a model.

// ---- Privacy screen --------------------------------------------------------------------
// Foster parents must never paste case data. Anything that looks like a name intro, phone,
// email, date, case/ID number or street address is removed before any outside call.
const PII = [
  ['email', /[\w.+-]+@[\w-]+\.[\w.]+/g],
  ['phone', /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g],
  ['date', /\b\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}\b/g],
  ['street address', /\b\d{1,6}\s+(?:[A-Z]?[a-z]+\s){1,3}(?:st|street|ave|avenue|rd|road|blvd|dr|drive|ln|lane|ct|way|pl)\b\.?/gi],
  ['case or ID number', /\b(?:case|id|dob|ssn|#)\s*[:#]?\s*[\w-]*\d[\w-]*/gi],
  ['case or ID number', /\b\d{5,}\b/g],
  ['name', /\b(?:her|his|their|child'?s?|kid'?s?)?\s*name\s*(?:is|:)\s*[A-Z][a-z]+(?:\s[A-Z][a-z]+)?/gi],
];
export function screenPII(text = '') {
  let out = String(text); const removed = new Set();
  for (const [kind, re] of PII) out = out.replace(re, () => { removed.add(kind); return ' '; });
  return { text: out.replace(/\s{2,}/g, ' ').replace(/\s+,/g, ',').trim(), removed: [...removed] };
}

export const MAX_TEXT = 1200;
export function validate(input = {}) {
  const age = Number(input.age);
  if (!Number.isInteger(age) || age < 2 || age > 17) throw new Error('Age must be a whole number from 2 to 17');
  const removed = new Set();
  const clean = (v, n) => { const r = screenPII(String(v || '').slice(0, n)); r.removed.forEach((x) => removed.add(x)); return r.text; };
  return {
    age,
    hometown: clean(input.hometown, 120),
    fosterCity: clean(input.fosterCity, 120),
    notes: clean(input.notes, MAX_TEXT),
    favorites: clean(input.favorites, MAX_TEXT),
    triggers: clean(input.triggers, MAX_TEXT),
    marked: Array.isArray(input.marked) ? input.marked.slice(0, 50).map((m) => ({ id: String(m.id || m.entity_id || '').slice(0, 64), name: String(m.name || '').slice(0, 120), keywords: (m.keywords || []).slice(0, 80).map(String), genres: (m.genres || []).slice(0, 40).map(String) })) : [],
    removed: [...removed],
  };
}

// ---- Age: content ratings -----------------------------------------------------------------
// Qloo's `filter.content_rating` takes a comma-separated list. We send the allowed set and then
// check `properties.content_rating` again on every result (items with no rating are dropped for
// anyone under 13, because "unknown" is not "safe").
export function allowedRatings(kind, age) {
  if (kind === 'tv') {
    if (age <= 6) return ['TV-Y', 'TV-G'];
    if (age <= 9) return ['TV-Y', 'TV-Y7', 'TV-G'];
    if (age <= 13) return ['TV-Y', 'TV-Y7', 'TV-G', 'TV-PG'];
    return ['TV-Y', 'TV-Y7', 'TV-G', 'TV-PG', 'TV-14'];
  }
  if (kind === 'film') {
    if (age <= 6) return ['G'];
    if (age <= 12) return ['G', 'PG'];
    return ['G', 'PG', 'PG-13'];
  }
  return null;
}
export function ratingOk(kind, rating, age) {
  const allowed = allowedRatings(kind, age);
  if (!allowed) return true;
  if (!rating) return age >= 13;
  return allowed.includes(String(rating).toUpperCase());
}

// ---- Text matching -----------------------------------------------------------------------
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function variants(word) {
  const w = word.toLowerCase().trim();
  const out = new Set([w]);
  if (w.endsWith('ies') && w.length > 4) out.add(w.slice(0, -3) + 'y');
  else if (w.endsWith('es') && w.length > 4) { out.add(w.slice(0, -2)); out.add(w.slice(0, -1)); }
  else if (w.endsWith('s') && w.length > 3) out.add(w.slice(0, -1));
  else { out.add(w + 's'); if (w.endsWith('y')) out.add(w.slice(0, -1) + 'ies'); }
  if (w.endsWith('ing') && w.length > 5) { out.add(w.slice(0, -3)); out.add(w.slice(0, -3) + 'e'); out.add(w.slice(0, -3) + 'ed'); }
  return [...out];
}
const STOP = new Set(['no', 'any', 'avoid', 'not', 'nothing', 'with', 'scared', 'of', 'afraid', 'the', 'a', 'an', 'loud', 'big', 'scary', 'being', 'about', 'around', 'fear', 'fears', 'hates', 'hate', 'doesn\'t', 'like', 'likes', 'to', 'and', 'or', 'sound', 'sounds', 'noise', 'noises']);
// Words a parent writes -> related words that should also hold an item back.
const SYNONYMS = {
  dog: ['puppy', 'puppies', 'canine', 'hound', 'heeler', 'pup'],
  cat: ['kitten', 'kitty', 'feline'],
  spider: ['arachnid', 'tarantula'],
  snake: ['serpent'],
  clown: ['circus'],
  hospital: ['surgery', 'surgeon', 'ambulance', 'medical emergency', 'terminal illness', 'cancer'],
  doctor: ['hospital', 'surgery'],
  fire: ['burning', 'wildfire', 'house fire', 'arson'],
  water: ['drown', 'drowning', 'shipwreck', 'flood', 'tsunami'],
  swim: ['drown', 'drowning'],
  thunder: ['storm', 'lightning', 'hurricane', 'tornado'],
  yell: ['shout', 'scream', 'screaming', 'yelling', 'shouting'],
  shout: ['yell', 'scream', 'screaming'],
  dark: ['darkness', 'nightmare', 'haunted'],
  monster: ['ghost', 'zombie', 'demon', 'haunted', 'horror'],
  needle: ['shots', 'vaccine', 'injection'],
  police: ['arrest', 'cop', 'sheriff'],
  car: ['car crash', 'car accident', 'crash'],
  divorce: ['custody', 'separation'],
  bully: ['bullying', 'bullied'],
  death: ['funeral', 'grief', 'dies', 'died', 'dead', 'ghost'],
  gun: ['shooting', 'shootout', 'firearm'],
  alone: ['abandoned', 'abandon', 'orphan'],
};
// Build matchers from the free-text triggers plus any extra terms an agent supplied.
export function buildAvoid(text = '', extraTerms = []) {
  const terms = new Map(); // term -> label (the phrase the parent wrote)
  const add = (t, label) => { t = t.toLowerCase().trim(); if (t.length > 2 && !STOP.has(t)) variants(t).forEach((v) => terms.set(v, label)); };
  const phrases = String(text).split(/[,;\n]|\band\b|\bor\b/i).map((x) => x.trim()).filter((x) => x.length > 1);
  for (const raw of phrases) {
    const p = raw.toLowerCase().replace(/^(no|avoid|not|nothing with|scared of|afraid of|fear of|doesn'?t like)\s+/, '').trim();
    if (!p) continue;
    add(p, raw.replace(/^(no|avoid)\s+/i, ''));
    const words = p.split(/\s+/).filter((w) => !STOP.has(w));
    if (words.length > 1) add(words[words.length - 1], raw);
    for (const w of words) for (const v of variants(w)) if (SYNONYMS[v]) SYNONYMS[v].forEach((s) => add(s, raw));
  }
  for (const t of extraTerms) add(String(t).slice(0, 40), String(t).slice(0, 40));
  const keys = [...terms.keys()].sort((a, b) => b.length - a.length);
  const re = keys.length ? new RegExp(`(?<![a-z])(?:${keys.map(esc).join('|')})(?![a-z])`, 'i') : null;
  return { terms, re, list: [...new Set([...terms.values()])] };
}
export function avoidHit(avoid, entity) {
  if (!avoid?.re) return null;
  for (const [where, text] of [['name', entity.name], ['themes', (entity.keywords || []).join(' | ')], ['summary', entity.description || '']]) {
    const m = String(text).match(avoid.re);
    if (m) return { term: m[0].toLowerCase(), label: avoid.terms.get(m[0].toLowerCase()) || m[0], where };
  }
  return null;
}

// Themes held back on a first night, whatever the caseworker shared.
const SENSITIVE_THEME = /(?<![a-z])(family separation|separated from (?:his|her|their) (?:parents|family|mother|father)|orphan\w*|foster\w*|adopt\w*|kidnap\w*|abduct\w*|abandon\w*|runaway|social worker|child protective|prison|jail|incarcerat\w*|missing child|lost child|parent(?:s)? (?:die|dies|died|killed)|(?:mother|father|mom|dad) (?:die|dies|died|killed)|death of (?:a |his |her |their )?(?:parent|mother|father)|child abuse|neglect\w*)(?![a-z])/i;
export function sensitiveHit(entity) {
  for (const [where, text] of [['themes', (entity.keywords || []).join(' | ')], ['summary', entity.description || '']]) {
    const m = String(text).match(SENSITIVE_THEME);
    if (m) return { term: m[0].toLowerCase(), where };
  }
  return null;
}

// A first night is not the night for scares, whatever the rating says.
const SCARY = /(?<![a-z])(horror|slasher|gore|gory|zombie\w*|serial killer\w*|haunt\w*|ghost\w*|demon\w*|possess\w*|murder\w*|psychological thriller|survival horror|creepy|supernatural thriller)(?![a-z])/i;
export function scaryHit(entity) {
  const m = [(entity.keywords || []).join(' | '), (entity.genres || []).join(' | '), entity.description || ''].join(' | ').match(SCARY);
  return m ? { term: m[0].toLowerCase() } : null;
}

// Music has no age rating in Qloo. For children 12 and under we hold back artists whose
// Qloo tags or description point to explicit material, and the card says to preview songs.
const EXPLICIT = /(?<![a-z])(explicit|parental advisory|gangsta|drill|trap|hardcore|death metal|drug\w*|profan\w*|sexual\w*|mature)(?![a-z])/i;
export function explicitHit(entity) {
  const m = [(entity.keywords || []).join(' | '), entity.genres?.join(' | ') || '', entity.description || ''].join(' | ').match(EXPLICIT);
  return m ? { term: m[0].toLowerCase() } : null;
}
// Places a child should not be sent to for a "familiar food" errand.
const ADULT_PLACE = /(?<![a-z])(bar|saloon|tequila bar|cocktail\w*|nightclub|night club|brewery|brewpub|taproom|tasting room|winery|lounge|dispensary|casino|strip club|hookah|pub)(?![a-z])/i;
const NOT_A_MEAL = /(?<![a-z])(albertsons|safeway|walmart|winco|costco|kroger|target|grocery|supermarket|market street|food mart|gas station|convenience|smoke shop|vape)(?![a-z])/i;
export function notMealHit(entity) {
  const m = [entity.name, (entity.genres || []).join(' | ')].join(' | ').match(NOT_A_MEAL);
  return m ? { term: m[0].toLowerCase() } : null;
}
export function adultPlaceHit(entity) {
  const m = [entity.name, (entity.genres || []).join(' | '), (entity.description || '').slice(0, 160)].join(' | ').match(ADULT_PLACE);
  return m ? { term: m[0].toLowerCase() } : null;
}

// ---- Marked triggers ("this one scared them") -------------------------------------------
const GENERIC = new Set(['family', 'friendship', 'friend', 'best friend', 'one word title', 'two word title', 'child', 'children', 'love', 'life', 'young', 'city', 'school', 'comedy', 'adventure', 'animation', 'drama']);
export function jaccard(a = [], b = []) {
  const A = new Set(a), B = new Set(b); if (!A.size || !B.size) return 0;
  let n = 0; for (const x of A) if (B.has(x)) n++;
  return n / (A.size + B.size - n);
}
export function similarToMarked(entity, marked = []) {
  for (const m of marked) {
    if (m.id && m.id === entity.id) return { because: 'marked as a trigger' };
    const mk = (m.keywords || []).map((k) => k.toLowerCase()).filter((k) => !GENERIC.has(k));
    const ek = new Set((entity.keywords || []).map((k) => k.toLowerCase()).filter((k) => !GENERIC.has(k)));
    const shared = mk.filter((k) => ek.has(k));
    if (shared.length >= 3 || (mk.length && jaccard(mk, [...ek]) >= 0.34)) return { because: `similar to ${m.name} (shares: ${shared.slice(0, 3).join(', ') || 'themes'})` };
  }
  return null;
}

// One call that decides everything. Returns null when the item is fine, else { because, kind }.
export function screenEntity(entity, { kind, age, avoid, marked }) {
  if (!ratingOk(kind, entity.rating, age)) return { kind: 'age', because: entity.rating ? `rated ${entity.rating}, too old for ${age}` : `no rating on file, held back for under 13` };
  const s = sensitiveHit(entity);
  if (s) return { kind: 'sensitive', because: `sensitive on a first night: ${s.term}` };
  if (kind !== 'music' && kind !== 'place') { const x = scaryHit(entity); if (x) return { kind: 'sensitive', because: `scary for a first night: ${x.term}` }; }
  const a = avoidHit(avoid, entity);
  if (a) return { kind: 'trigger', because: `trigger "${a.label}" (found ${a.where}: ${a.term})` };
  const m = similarToMarked(entity, marked);
  if (m) return { kind: 'marked', because: m.because };
  if (kind === 'music' && age <= 12) { const x = explicitHit(entity); if (x) return { kind: 'age', because: `may be explicit (${x.term})` }; }
  if (kind === 'place') {
    const x = adultPlaceHit(entity); if (x) return { kind: 'age', because: `adult venue (${x.term})` };
    const g = notMealHit(entity); if (g) return { kind: 'place', because: `not a restaurant (${g.term})` };
  }
  return null;
}

// ---- Guard for model-written text ------------------------------------------------------------------
// The agent writes the openers and the run of show. It may never touch family, the removal,
// or the child's past, and it may never repeat a trigger word.
const FORBIDDEN_TOPICS = /(?<![a-z])(mom|mother|dad|father|parents?|bio(?:logical)?|family|removal|removed|taken|placement|placed|court|caseworker|case worker|social worker|why (?:are|did|were)|what happened|miss(?:ing)? (?:your|them)|abuse\w*|neglect\w*|trauma\w*|upset|sad about|cry(?:ing)?)(?![a-z])/i;
export function textProblem(text, avoid) {
  const t = String(text || '');
  if (!t.trim()) return 'empty';
  if (/[\u2014\u2013]/.test(t)) return 'dash';
  const f = t.match(FORBIDDEN_TOPICS);
  if (f) return `topic: ${f[0]}`;
  if (/\bI(?:'ve| have| had| made| got| cooked| bought| baked)\b/i.test(t)) return 'claims the home already has something';
  const a = avoid?.re && t.match(avoid.re);
  if (a) return `trigger word: ${a[0]}`;
  return null;
}
