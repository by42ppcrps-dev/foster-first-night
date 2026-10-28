import test from 'node:test';
import assert from 'node:assert/strict';
import { screenPII, validate, allowedRatings, ratingOk, buildAvoid, avoidHit, sensitiveHit, explicitHit, adultPlaceHit, textProblem, screenEntity, similarToMarked } from '../src/safety.js';

test('PII screen removes emails, phones, dates, addresses, ids and name intros', () => {
  const r = screenPII('Her name is Maria Lopez, call 208-555-0123 or a@b.com, born 3/4/2015, lives at 123 Maple Street, case 4471982');
  assert.ok(!/Maria|555|a@b|2015|Maple|4471982/.test(r.text), r.text);
  for (const k of ['name', 'phone', 'email', 'date', 'street address', 'case or ID number']) assert.ok(r.removed.includes(k), k);
});
test('PII screen keeps ordinary favorites', () => {
  assert.equal(screenPII('Bluey, Encanto, pozole').text, 'Bluey, Encanto, pozole');
});
test('validate bounds the age and scrubs every field', () => {
  assert.throws(() => validate({ age: 1 }));
  assert.throws(() => validate({ age: 18 }));
  assert.throws(() => validate({ age: 'x' }));
  const v = validate({ age: '8', favorites: 'Bluey, call 208-555-0123', hometown: 'East LA' });
  assert.equal(v.age, 8); assert.ok(!v.favorites.includes('555')); assert.deepEqual(v.removed, ['phone']);
});
test('ratings: kids under 7 get G and TV-Y only, unrated is held back under 13', () => {
  assert.deepEqual(allowedRatings('film', 5), ['G']);
  assert.ok(allowedRatings('tv', 5).every((r) => ['TV-Y', 'TV-G'].includes(r)));
  assert.ok(ratingOk('film', 'PG', 9)); assert.ok(!ratingOk('film', 'PG-13', 9)); assert.ok(!ratingOk('film', 'R', 16));
  assert.ok(!ratingOk('tv', null, 8)); assert.ok(ratingOk('tv', null, 14));
  assert.ok(!ratingOk('tv', 'TV-MA', 16));
});
test('triggers match words and plurals and synonyms, not substrings', () => {
  const a = buildAvoid('dogs, loud yelling');
  assert.ok(avoidHit(a, { name: 'A', keywords: ['puppy love'], description: '' }));
  assert.ok(avoidHit(a, { name: 'Dog Days', keywords: [], description: '' }));
  assert.ok(avoidHit(a, { name: 'A', keywords: [], description: 'A family screaming match' }));
  assert.equal(avoidHit(a, { name: 'Dogma', keywords: ['hotdog stand'], description: 'doggedly' }), null);
  assert.equal(avoidHit(buildAvoid(''), { name: 'Dog', keywords: [], description: '' }), null);
});
test('agent supplied extra terms widen the avoid list', () => {
  const a = buildAvoid('storms', ['hurricane']);
  assert.ok(avoidHit(a, { name: 'The Great Hurricane', keywords: [], description: '' }));
});
test('sensitive first-night themes are held back', () => {
  for (const d of ['She is adopted by a new family', 'An orphan boy', 'Kidnapped from home', 'a runaway', 'parents die in a crash']) assert.ok(sensitiveHit({ keywords: [], description: d }), d);
  assert.equal(sensitiveHit({ keywords: ['friendship'], description: 'A fun day at the zoo' }), null);
});
test('explicit music and adult venues', () => {
  assert.ok(explicitHit({ keywords: [], genres: ['Trap'], description: '' }));
  assert.equal(explicitHit({ keywords: ['lullaby'], genres: ['Children'], description: '' }), null);
  assert.ok(adultPlaceHit({ name: 'Noodle Bar & Cocktails', genres: [], description: '' }));
  assert.ok(adultPlaceHit({ name: 'Sunset Brewery', genres: [], description: '' }));
  assert.equal(adultPlaceHit({ name: 'Pho House', genres: ['Vietnamese'], description: 'Family noodle shop' }), null);
});
test('marked triggers hold back similar items', () => {
  const marked = [{ id: 'x', name: 'Scary One', keywords: ['haunted house', 'ghost', 'jump scare', 'night'] }];
  assert.ok(similarToMarked({ id: 'y', keywords: ['haunted house', 'ghost', 'jump scare'] }, marked));
  assert.equal(similarToMarked({ id: 'z', keywords: ['friendship', 'family', 'garden'] }, marked), null);
  assert.ok(similarToMarked({ id: 'x', keywords: [] }, marked));
});
test('screenEntity returns the first reason', () => {
  const opts = { kind: 'tv', age: 6, avoid: buildAvoid('dogs'), marked: [] };
  assert.equal(screenEntity({ name: 'OK', rating: 'TV-Y', keywords: [], description: '' }, opts), null);
  assert.equal(screenEntity({ name: 'OK', rating: 'TV-14', keywords: [], description: '' }, opts).kind, 'age');
  assert.equal(screenEntity({ name: 'OK', rating: 'TV-Y', keywords: ['dog'], description: '' }, opts).kind, 'trigger');
});
test('model-written text may not touch family, triggers or use dashes', () => {
  const avoid = buildAvoid('dogs');
  assert.equal(textProblem('Want to watch something together tonight?', avoid), null);
  assert.ok(textProblem('Do you miss your mom?', avoid));
  assert.ok(textProblem('Do you like dogs?', avoid));
  assert.ok(textProblem('Welcome \u2014 sit anywhere', avoid));
  assert.ok(textProblem('', avoid));
});

test('scary titles are held back on a first night even when the rating allows them', async () => {
  const { screenEntity } = await import('../src/safety.js');
  const scary = { id: 'x', name: 'Night Hall', rating: 'TV-14', keywords: ['haunted house', 'teen drama'], genres: ['Horror'], description: '' };
  const r = screenEntity(scary, { kind: 'tv', age: 15, avoid: null, marked: [] });
  assert.equal(r.kind, 'sensitive');
  assert.match(r.because, /scary/);
});

test('grocery stores are not offered as a place to get a familiar meal', async () => {
  const { screenEntity } = await import('../src/safety.js');
  const r = screenEntity({ id: 'p', name: 'Albertsons', genres: ['Grocery'], keywords: [] }, { kind: 'place', age: 10, avoid: null, marked: [] });
  assert.equal(r.kind, 'place');
});
