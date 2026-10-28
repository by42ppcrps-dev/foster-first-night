import test from 'node:test';
import assert from 'node:assert/strict';
import { createQlooClient } from '../src/qloo.js';
import { plan, suggest, nearbyFood, parseFavorites, resolveFavorite, expandHometown, cityOnly } from '../src/engine.js';
import { buildAvoid } from '../src/safety.js';
import { fakeQlooFetch } from './fixtures.js';

const mk = (seen) => createQlooClient({ apiKey: 'test', fetchImpl: fakeQlooFetch(seen) });

test('parseFavorites splits, dedupes and caps', () => {
  assert.deepEqual(parseFavorites('Bluey, Encanto and pozole\nbluey'), ['Bluey', 'Encanto', 'pozole']);
  assert.equal(parseFavorites(Array.from({ length: 20 }, (_, i) => `Item ${i}`).join(', ')).length, 8);
});
test('hometown and city helpers', () => {
  assert.equal(expandHometown('East LA'), 'East Los Angeles');
  assert.equal(cityOnly('Boise, Idaho'), 'Boise');
});
test('the client requires a key and sends it as X-Api-Key', async () => {
  assert.throws(() => createQlooClient({}));
  let header; const q = createQlooClient({ apiKey: 'k', fetchImpl: async (u, o) => { header = o.headers['X-Api-Key']; return new Response('{}'); } });
  await q.search('x'); assert.equal(header, 'k');
});
test('a show beats an artist with the same name when resolving a favorite', async () => {
  const r = await resolveFavorite(mk(), 'Overlap');
  assert.equal(r.type, 'media'); assert.equal(r.entity.kind, 'tv');
});
test('suggest sends the age ratings to Qloo and screens what comes back', async () => {
  const seen = []; const q = mk(seen);
  const seeds = [(await resolveFavorite(q, 'Test Show One')).entity, (await resolveFavorite(q, 'Test Film One')).entity];
  const r = await suggest(q, { kind: 'tv', seeds, age: 6, avoid: buildAvoid('dogs'), marked: [] });
  const call = seen.find((u) => u.pathname === '/v2/insights');
  assert.equal(call.searchParams.get('filter.content_rating'), 'TV-Y,TV-G');
  assert.equal(call.searchParams.get('feature.explainability'), 'true');
  assert.deepEqual(r.items.map((i) => i.name), ['Gentle Garden', 'Quiet River']);
  const why = Object.fromEntries(r.heldBack.map((h) => [h.name, h.reason]));
  assert.deepEqual(why, { 'Puppy Patrol Club': 'trigger', 'Midnight Court': 'age', 'Unrated Thing': 'age', 'New Family Day': 'sensitive' });
  assert.match(r.items[0].why, /Test Show One and Test Film One/);
  assert.deepEqual(r.items[0].because.map((b) => b.pct), [60, 40]);
});
test('music for children 9 and under is limited to children\'s music tags and drops hometown', async () => {
  const seen = []; const q = mk(seen);
  const seeds = [(await resolveFavorite(q, 'Test Show One')).entity];
  await suggest(q, { kind: 'music', seeds, age: 7, avoid: buildAvoid(''), marked: [], hometown: 'East Los Angeles' });
  const u = seen.find((x) => x.pathname === '/v2/insights');
  assert.match(u.searchParams.get('filter.tags'), /children/); assert.equal(u.searchParams.get('signal.location.query'), null);
});
test('older children can get a hometown signal, and explicit artists are held back', async () => {
  const seen = []; const q = mk(seen);
  const seeds = [(await resolveFavorite(q, 'Test Show One')).entity];
  const r = await suggest(q, { kind: 'music', seeds, age: 12, avoid: buildAvoid(''), marked: [], hometown: 'East Los Angeles' });
  const u = seen.find((x) => x.pathname === '/v2/insights');
  assert.equal(u.searchParams.get('signal.location.query'), 'East Los Angeles'); assert.equal(u.searchParams.get('filter.tags'), null);
  assert.deepEqual(r.items.map((i) => i.name), ['Lullaby Collective']); assert.equal(r.heldBack[0].name, 'Late Night Trap');
});
test('restaurants: dish tags first, cuisine as an honest fallback, bars and closed places removed', async () => {
  const q = mk();
  const food = { dish: 'pho', dishTags: [{ id: 'urn:tag:specialty_dish:place:pho', name: 'Pho' }], cuisine: { id: 'urn:tag:genre:place:restaurant:vietnamese', name: 'Vietnamese' } };
  const r = await nearbyFood(q, { food, city: 'Testville, ID', avoid: buildAvoid(''), age: 8 });
  assert.equal(r.level, 'cuisine'); // the dish call returned one place, so the cuisine call ran
  assert.deepEqual(r.items.map((i) => i.name), ['Pho House', 'Bowl Place']);
  assert.match(r.label, /cuisine match, not confirmed/);
  assert.ok(r.heldBack.some((h) => h.name.includes('Cocktails')));
});
test('plan() matches favorites, builds sections and never returns held items', async () => {
  const p = await plan(mk(), { age: 6, fosterCity: 'Testville', favorites: 'Test Show One, Test Film One, pho, Nonexistent Thing', triggers: 'dogs', hometown: 'Anywhere' });
  assert.equal(p.mode, 'planner');
  assert.deepEqual(p.matched.map((m) => m.type), ['media', 'media', 'food', 'unmatched']);
  assert.deepEqual(p.unmatched, ['Nonexistent Thing']);
  assert.ok(p.sections.tv.length && !p.sections.tv.some((i) => /Puppy/.test(i.name)));
  assert.ok(p.places.items.length);
  assert.ok(p.openers.length >= 3 && p.openers.every((o) => !/[\u2014\u2013]/.test(o)));
  assert.ok(p.heldBack.some((h) => h.reason === 'trigger'));
  assert.equal(p.privacy.stored, false);
});
test('plan() with little known offers a choice board', async () => {
  const p = await plan(mk(), { age: 6, favorites: 'Nonexistent Thing', triggers: '' });
  assert.equal(p.little, true);
});
