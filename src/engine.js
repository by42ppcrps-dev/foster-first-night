// The planner. Every suggestion comes from a live Qloo call, then passes the safety layer.
import { TYPE } from './qloo.js';
import { validate, allowedRatings, buildAvoid, screenEntity, textProblem } from './safety.js';

export const ageBucket = () => '24_and_younger'; // the only Qloo demographic bucket that covers under 18
const HOMETOWN_ALIASES = { 'east la': 'East Los Angeles', 'e la': 'East Los Angeles', 'la': 'Los Angeles', 'nyc': 'New York City', 'philly': 'Philadelphia', 'vegas': 'Las Vegas' };
export const expandHometown = (t = '') => HOMETOWN_ALIASES[t.trim().toLowerCase()] || t.trim();
// Qloo place search wants a bare city name: "Boise" works, "Boise, Idaho" does not.
export const cityOnly = (t = '') => t.split(',')[0].trim();

const norm = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const MEDIA = ['tv', 'film', 'music', 'game', 'book', 'podcast'];
const KIND_RANK = { tv: 0, film: 1, game: 2, book: 3, podcast: 4, music: 5 };

export function parseFavorites(text = '') {
  const seen = new Set();
  return String(text).split(/[\n,;]+|\s+and\s+|\s*&\s*/i).map((x) => x.replace(/^[\s"'\-\u2022*]+|[\s"'.]+$/g, '').trim())
    .filter((x) => x.length > 1 && !seen.has(norm(x)) && seen.add(norm(x))).slice(0, 8);
}

// Dishes that Qloo files under a cuisine, not under the dish name.
const DISH_CUISINE = { pho: 'vietnamese', 'banh mi': 'vietnamese', pozole: 'mexican', tamales: 'mexican', tamale: 'mexican', tacos: 'mexican', taco: 'mexican', enchiladas: 'mexican', quesadillas: 'mexican', 'rice and beans': 'latin american', pupusas: 'salvadoran', arepas: 'venezuelan', empanadas: 'latin american', ramen: 'japanese', sushi: 'japanese', udon: 'japanese', 'pad thai': 'thai', 'fried rice': 'chinese', dumplings: 'chinese', 'lo mein': 'chinese', 'orange chicken': 'chinese', kimchi: 'korean', bibimbap: 'korean', 'korean bbq': 'korean', jollof: 'west african', injera: 'ethiopian', curry: 'indian', samosas: 'indian', naan: 'indian', gyro: 'greek', falafel: 'middle eastern', shawarma: 'middle eastern', pasta: 'italian', lasagna: 'italian', pizza: 'pizza', 'mac and cheese': 'american', 'chicken nuggets': 'american', burgers: 'burger', burger: 'burger', pancakes: 'breakfast', waffles: 'breakfast' };
const CHILD_MUSIC = ['urn:tag:genre:music:children', 'urn:tag:genre:music:childrens'];
export const HOMETOWN_MIN_AGE = 10;
const FOOD_TAG = /^urn:tag:(genre:place:restaurant|specialty_dish:place|menu_highlight:qloo|cuisine:qloo)/;

export async function foodTags(q, text) {
  const n = norm(text);
  const dish = (await q.tags(n, { take: 12 })).filter((t) => FOOD_TAG.test(t.id) && norm(t.name).split(' ').some((w) => w.length > 2 && n.includes(w)));
  const dishTags = dish.filter((t) => /restaurant|specialty_dish|menu_highlight/.test(t.id)).slice(0, 3);
  const cuisineName = DISH_CUISINE[n] || (dish.find((t) => /genre:place:restaurant|cuisine:qloo/.test(t.id)) ? n : null);
  let cuisine = null;
  if (cuisineName) {
    const c = (await q.tags(cuisineName, { take: 8 })).find((t) => /^urn:tag:genre:place:restaurant:/.test(t.id) && norm(t.name).includes(norm(cuisineName).split(' ')[0]));
    if (c) cuisine = { id: c.id, name: c.name };
  }
  if (!dishTags.length && !cuisine) return null;
  return { dish: n, dishTags: dishTags.map((t) => ({ id: t.id, name: t.name })), cuisine };
}

// Turn each thing a caseworker shared into a Qloo entity (show, film, artist, game...) or a food.
export async function resolveFavorite(q, text) {
  const n = norm(text);
  let found = [];
  try { found = (await q.search(text, { take: 8 })).filter((e) => MEDIA.includes(e.kind)); } catch { /* treated as not found */ }
  const exact = found.filter((e) => norm(e.name) === n || norm(e.name.split(':')[0]) === n || norm(e.name.replace(/^the /, '')) === n.replace(/^the /, ''));
  // A show, film or game beats an artist of the same name ("Peppa Pig"), then the most popular wins.
  const best = exact.sort((a, b) => (KIND_RANK[a.kind] - KIND_RANK[b.kind]) || ((b.popularity ?? 0) - (a.popularity ?? 0)))[0];
  const others = exact.filter((e) => e.id !== best?.id).slice(0, 2);
  if (best) return { text, type: 'media', entity: best, others };
  let food = null;
  try { food = await foodTags(q, text); } catch { /* food lookup is best effort */ }
  if (food) return { text, type: 'food', food };
  return { text, type: 'unmatched' };
}

const KIND_LABEL = { tv: 'show', film: 'film', music: 'artist', game: 'game', book: 'book', podcast: 'podcast' };
const describe = (e) => `${e.name} (${[e.year, KIND_LABEL[e.kind] || e.kind].filter(Boolean).join(' ')})`;
export const describeEntity = describe;

// One recommendation call, then every result goes through the safety layer.
export async function suggest(q, { kind, seeds, age, avoid, marked = [], hometown, max = 6 }) {
  const seedIds = seeds.map((s) => s.id);
  const nameOf = new Map(seeds.map((s) => [s.id, s.name]));
  // For ages 9 and under, music is limited to artists Qloo tags as children's music. Older kids get the
  // open catalog, screened for explicit material.
  const filterTags = kind === 'music' && age <= 9 ? CHILD_MUSIC : undefined;
  const raw = await q.insights({ type: TYPE[kind], entities: seedIds, ratings: allowedRatings(kind, age), filterTags, exclude: seedIds, hometown: filterTags ? undefined : hometown, age: ageBucket(age), take: 14 });
  const items = []; const heldBack = [];
  for (const e of raw) {
    if (items.some((x) => x.id === e.id)) continue;
    const why = screenEntity(e, { kind, age, avoid, marked });
    if (why) { heldBack.push({ id: e.id, name: e.name, kind, reason: why.kind, because: why.because }); continue; }
    if (items.length < max) items.push(toItem(e, kind, nameOf, hometown));
  }
  return { items, heldBack, scanned: raw.length };
}
function toItem(e, kind, nameOf, hometown) {
  const because = e.because.filter((b) => nameOf.has(b.id)).map((b) => ({ name: nameOf.get(b.id), pct: Math.round(b.score * 100) })).sort((a, b) => b.pct - a.pct);
  const strong = because.filter((b) => b.pct >= 20);
  let why;
  if (hometown && !because.length) why = `Popular with listeners in ${hometown}. A hint, so ask first.`;
  else if (strong.length) why = `Qloo ties it to ${strong.map((b) => b.name).join(' and ')}.`;
  else why = 'A close match to the favorites you shared.';
  return { id: e.id, name: e.name, kind, year: e.year, rating: e.rating, genres: e.genres, keywords: e.keywords.slice(0, 30), why, because, fromHometown: !!hometown && !because.length };
}

// Restaurants that serve a food the child likes. Honest about how close the match is.
export async function nearbyFood(q, { food, city, avoid, age, max = 3 }) {
  const tries = [];
  if (food.dishTags.length) tries.push({ ids: food.dishTags.map((t) => t.id), level: 'dish', label: `Qloo tags these as serving ${food.dish}` });
  if (food.cuisine) tries.push({ ids: [food.cuisine.id], level: 'cuisine', label: `${food.cuisine.name} restaurants (cuisine match, not confirmed to serve ${food.dish})` });
  for (const t of tries) {
    const raw = await q.insights({ type: TYPE.place, filterTags: t.ids, near: cityOnly(city), take: 12, explain: false });
    const items = []; const heldBack = [];
    for (const e of raw) {
      if (e.closed || items.some((x) => x.name === e.name)) continue;
      const why = screenEntity(e, { kind: 'place', age, avoid, marked: [] });
      if (why) { heldBack.push({ name: e.name, kind: 'place', reason: why.kind, because: why.because }); continue; }
      items.push({ id: e.id, name: e.name, kind: 'place', address: e.address, city: e.city, businessRating: e.businessRating, genres: e.genres, matchedOn: t.level, why: t.label, food: food.dish });
      if (items.length >= max) break;
    }
    if (items.length >= 2 || (items.length && t === tries[tries.length - 1])) return { items, heldBack, label: t.label, level: t.level };
  }
  return { items: [], heldBack: [], label: null, level: null };
}

// "Little known" path: no recognizable favorites, so offer a choice board instead of guessing.
export async function choiceBoard(q, { age, avoid, marked }) {
  const young = age <= 8;
  const specs = [
    { kind: 'tv', tag: young ? 'urn:tag:subgenre:qloo:children_s_animation' : 'urn:tag:genre:media:family' },
    { kind: 'film', tag: young ? 'urn:tag:genre:media:animation' : 'urn:tag:genre:media:family' },
  ];
  const out = [];
  await Promise.all(specs.map(async (s) => {
    try {
      const raw = await q.insights({ type: TYPE[s.kind], tags: [s.tag], ratings: allowedRatings(s.kind, age), age: ageBucket(age), take: 14, explain: false });
      raw.filter((e) => !screenEntity(e, { kind: s.kind, age, avoid, marked })).sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0)).slice(0, 4)
        .forEach((e) => out.push({ id: e.id, name: e.name, kind: s.kind, year: e.year, rating: e.rating }));
    } catch { /* board is optional */ }
  }));
  return out;
}

// ---- Gentle, choice-based openers and a first-night run of show ---------------------------------
export function openersFor(age, matched, sections) {
  const out = [];
  const m = (k) => matched.find((x) => x.type === 'media' && x.entity.kind === k);
  const show = m('tv') || m('film'), music = m('music'), game = m('game');
  const food = matched.find((x) => x.type === 'food');
  if (show) out.push(`Have you seen ${show.entity.name}? We can watch some tonight, or you can just rest.`);
  if (music) out.push(`Want to put on some ${music.entity.name} while we get your room ready? You pick the song.`);
  if (game) out.push(`Do you play ${game.entity.name}? You can show me sometime if you feel like it.`);
  if (food) out.push(`We could make ${food.food.dish} this week. Is there a way you like it best?`);
  const top = sections.tv?.[0] || sections.film?.[0];
  if (top && out.length < 4) out.push(`Ever seen ${top.name}? No pressure either way.`);
  out.push('Here is where the bathroom is, and your bed. Do you want the light on or off tonight?');
  out.push(age <= 8 ? 'Do you want a stuffed animal or a blanket to keep with you tonight?' : 'Is there anything you would like me to know, or anything you would like me not to do?');
  return out.filter((t) => !textProblem(t)).slice(0, 5);
}
export function runOfShow(age, sections, foodPlan) {
  const top = sections.tv?.[0] || sections.film?.[0];
  return [
    { when: 'At the door', text: 'Say hello, show the bedroom and bathroom, and let them set their bag down where they choose.' },
    { when: 'First hour', text: foodPlan ? `Offer a snack. Something close to ${foodPlan.dish} is the safe bet.` : 'Offer a snack and a drink, and let them say yes or no.' },
    { when: 'Evening', text: top ? `Put ${top.name} on as an option, with no pressure to watch.` : 'Keep the evening quiet. A show on in the background is fine.' },
    { when: 'Bedtime', text: age <= 8 ? 'Offer a night light and a blanket. Leave the door how they want it.' : 'Offer a charger and a quiet room. Let them pick the light.' },
  ];
}

// The built-in planner: no model, same safety layer. Also the fallback when the agent cannot finish.
export async function plan(q, rawInput) {
  const t0 = Date.now();
  const child = validate(rawInput);
  const avoid = buildAvoid(child.triggers);
  const favorites = parseFavorites(child.favorites);
  const resolved = await Promise.all(favorites.map((f) => resolveFavorite(q, f)));
  const seeds = resolved.filter((r) => r.type === 'media').map((r) => r.entity).slice(0, 5);
  const foods = resolved.filter((r) => r.type === 'food').slice(0, 2);
  const hometown = child.hometown ? expandHometown(child.hometown) : '';
  const sections = {}; const heldBack = [];
  if (seeds.length) {
    await Promise.all(['tv', 'film', 'music'].map(async (kind) => {
      const r = await suggest(q, { kind, seeds, age: child.age, avoid, marked: child.marked });
      sections[kind] = r.items; heldBack.push(...r.heldBack);
    }));
  }
  if (hometown && child.age >= HOMETOWN_MIN_AGE) {
    try {
      const r = await suggest(q, { kind: 'music', seeds: seeds.length ? seeds : [], age: child.age, avoid, marked: child.marked, hometown, max: 3 });
      const known = new Set((sections.music || []).map((x) => x.id));
      const extra = r.items.filter((x) => !known.has(x.id)).map((x) => ({ ...x, fromHometown: true, why: `Popular with listeners in ${hometown}. A hint, so ask first.` }));
      sections.music = [...(sections.music || []), ...extra].slice(0, 6); heldBack.push(...r.heldBack);
    } catch { /* hint is optional */ }
  }
  let places = { items: [], label: null };
  if (child.fosterCity && foods.length) {
    for (const f of foods) { places = await nearbyFood(q, { food: f.food, city: child.fosterCity, avoid, age: child.age }); if (places.items.length) { places.food = f.food.dish; break; } }
    heldBack.push(...(places.heldBack || []));
  }
  const little = seeds.length < 2;
  const choices = little ? await choiceBoard(q, { age: child.age, avoid, marked: child.marked }) : [];
  const matched = resolved.map((r) => ({ text: r.text, type: r.type, as: r.type === 'media' ? describe(r.entity) : r.type === 'food' ? `${r.food.dish} (food)` : null, id: r.entity?.id || null }));
  return {
    mode: 'planner',
    child: { age: child.age, hometown: child.hometown, fosterCity: child.fosterCity },
    privacy: { removed: child.removed, stored: false },
    matched, unmatched: resolved.filter((r) => r.type === 'unmatched').map((r) => r.text),
    sections, places, heldBack: dedupeHeld(heldBack), little, choices,
    avoiding: avoid.list,
    openers: openersFor(child.age, resolved, sections),
    runOfShow: runOfShow(child.age, sections, foods[0]?.food),
    guard: [
      'Everything under "Qloo suggests" is an offer. Let the child say yes or no.',
      'A hometown signal is a hint, not an identity. Ask what they actually like.',
      'Do not ask about their family, the removal, or why they are here tonight.',
      'Music has no age rating in Qloo. Preview songs before playing them.',
    ],
    stats: { qlooCalls: q.calls, ms: Date.now() - t0 },
  };
}
function dedupeHeld(list) { const seen = new Set(); return list.filter((h) => { const k = h.kind + h.name; return seen.has(k) ? false : seen.add(k); }).slice(0, 24); }
