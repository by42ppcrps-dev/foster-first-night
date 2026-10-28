import test from 'node:test';
import assert from 'node:assert/strict';
import { createQlooClient } from '../src/qloo.js';
import { runAgent, planWithAgent, checkFinish, Session, runTool } from '../src/agent.js';
import { handleRpc } from '../src/mcp.js';
import worker from '../src/worker.js';
import { fakeQlooFetch } from './fixtures.js';

const mk = () => createQlooClient({ apiKey: 'test', fetchImpl: fakeQlooFetch() });
const input = { age: 6, fosterCity: 'Testville', favorites: 'Test Show One, pho', triggers: 'dogs' };

// A scripted "model": each entry is the function calls it makes on one turn.
const scripted = (turns) => { let i = 0; return { model: 'scripted', async generate({ contents }) {
  const calls = turns[Math.min(i++, turns.length - 1)](contents);
  return { content: { role: 'model', parts: calls.map((c) => ({ functionCall: c })) }, calls, tokens: 10 }; } }; };
const lastResponse = (contents) => contents.at(-1).parts[0].functionResponse.response;

test('agent loop: tools run against Qloo, finish_plan is checked, result has a trace', async () => {
  let seed, items;
  const gemini = scripted([
    () => [{ name: 'resolve_favorite', args: { text: 'Test Show One' }, id: '1' }],
    (c) => { seed = lastResponse(c).best.id; return [{ name: 'set_avoid_terms', args: { terms: ['canine'] }, id: '2' }]; },
    () => [{ name: 'qloo_suggest', args: { kind: 'tv', seed_ids: [seed] }, id: '3' }],
    (c) => { items = lastResponse(c).items || items; return [{ name: 'finish_plan', id: '4', args: { summary: 'A quiet evening.', picks: { tv: [{ id: items[0].id, note: 'Calm and slow.' }, { id: 'not-from-a-tool' }] }, openers: ['Want to watch Gentle Garden with me?', 'Is the lamp too bright for you?'], run_of_show: [{ when: 'At the door', text: 'Show them the room.' }, { when: 'Bedtime', text: 'Offer a night light.' }] } }]; },
  ]);
  const events = [];
  const p = await runAgent({ q: mk(), gemini, input, emit: (e) => events.push(e) });
  assert.equal(p.mode, 'agent');
  assert.equal(p.sections.tv[0].name, 'Gentle Garden'); assert.equal(p.sections.tv[0].note, 'Calm and slow.');
  assert.ok(p.sections.tv.every((i) => i.id !== 'not-from-a-tool'));
  assert.ok(p.avoiding.includes('canine'));
  assert.ok(p.agent.steps.length >= 5 && events.length === p.agent.steps.length);
  assert.ok(p.places.items.length, 'restaurants are filled in when the agent forgot them');
});
test('checkFinish drops ids no tool returned and text that breaks the rules', async () => {
  const s = new Session(mk(), input);
  s.safe.set('tv-a', { id: 'tv-a', name: 'Gentle Garden', kind: 'tv' });
  const r = checkFinish(s, { summary: 'Hello \u2014 there', picks: { tv: [{ id: 'tv-a', note: 'Do you like dogs?' }, { id: 'nope' }] }, openers: ['Do you miss your mom?', 'Want some tea tonight?'], run_of_show: [{ when: 'Now', text: 'Show the room.' }] });
  assert.equal(r.sections.tv.length, 1); assert.equal(r.sections.tv[0].note, undefined);
  assert.equal(r.summary, null); assert.equal(r.openers.length, 1);
  assert.ok(r.problems.length >= 3);
});
test('tools refuse bad input without throwing', async () => {
  const s = new Session(mk(), input);
  assert.match((await runTool(s, 'qloo_suggest', { kind: 'tv', seed_ids: ['x'] })).result.error, /seed_ids/);
  assert.match((await runTool(s, 'qloo_nearby_food', { tag_ids: ['x'], dish: 'pho' })).result.error, /tag_ids/);
  assert.match((await runTool(s, 'nope', {})).result.error, /unknown/);
});
test('if the agent throws, the built-in planner answers and says so', async () => {
  const boom = { model: 'x', async generate() { throw new Error('Gemini returned 503'); } };
  const p = await planWithAgent({ q: mk(), gemini: boom, input });
  assert.equal(p.mode, 'planner'); assert.match(p.agent.fallback, /built-in planner/);
});
test('without a model key the planner answers', async () => {
  const p = await planWithAgent({ q: mk(), gemini: null, input });
  assert.equal(p.mode, 'planner');
});

test('MCP: initialize, list, call, errors, notifications', async () => {
  const q = mk();
  const init = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, q);
  assert.equal(init.result.protocolVersion, '2025-03-26'); assert.ok(init.result.capabilities.tools);
  assert.equal(await handleRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, q), null);
  const list = await handleRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, q);
  assert.deepEqual(list.result.tools.map((t) => t.name), ['plan_first_night', 'suggest', 'nearby_food', 'check_item']);
  const call = await handleRpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'suggest', arguments: { kind: 'tv', age: 6, favorites: ['Test Show One'], triggers: 'dogs' } } }, q);
  const out = JSON.parse(call.result.content[0].text);
  assert.ok(out.items.length && out.held_back.length);
  assert.equal((await handleRpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope' } }, q)).error.code, -32602);
  assert.equal((await handleRpc({ jsonrpc: '2.0', id: 5, method: 'bogus' }, q)).error.code, -32601);
});

const env = (extra = {}) => ({ QLOO_API_KEY: 'k', __fetch: fakeQlooFetch(), ASSETS: { fetch: () => new Response('asset') }, ...extra });
const post = (path, body) => new Request(`https://x.test${path}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });
test('worker: meta, validation, size limit, MCP transport rules', async () => {
  const ctx = { waitUntil() {} };
  const meta = await (await worker.fetch(new Request('https://x.test/api/meta'), env(), ctx)).json();
  assert.equal(meta.mode, 'live'); assert.equal(meta.agent, false);
  assert.equal((await worker.fetch(post('/api/plan', { age: 99 }), env(), ctx)).status, 400);
  assert.equal((await worker.fetch(post('/api/plan', 'x'.repeat(30000)), env(), ctx)).status, 413);
  assert.equal((await worker.fetch(post('/api/plan', 'not json'), env(), ctx)).status, 400);
  assert.equal((await worker.fetch(new Request('https://x.test/mcp'), env(), ctx)).status, 405);
  assert.equal((await worker.fetch(post('/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' }), env(), ctx)).status, 202);
  const plan = await (await worker.fetch(post('/api/plan', input), env(), ctx)).json();
  assert.equal(plan.mode, 'planner'); assert.ok(plan.sections.tv.length);
});
test('worker: /api/agent streams steps then a result, and is limited per network', async () => {
  const pend = []; const ctx = { waitUntil: (p) => pend.push(p) };
  const res = await worker.fetch(post('/api/agent', input), env(), ctx);
  const lines = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.at(-1).type, 'result'); assert.equal(lines.at(-1).plan.mode, 'planner');
  const limiter = { limit: async () => ({ success: false }) };
  assert.equal((await worker.fetch(post('/api/agent', input), env({ LIMITER: limiter }), ctx)).status, 429);
});
test('worker: past the daily budget the agent is skipped', async () => {
  const store = new Map([[`agent-runs:${new Date().toISOString().slice(0, 10)}`, '300']]);
  const BUDGET = { get: async (k) => store.get(k), put: async (k, v) => store.set(k, v) };
  const calls = []; const ctx = { waitUntil() {} };
  const e = env({ GEMINI_API_KEY: 'g', BUDGET, __geminiFetch: async () => { calls.push(1); throw new Error('should not be called'); } });
  const res = await worker.fetch(post('/api/agent', input), e, { waitUntil: (p) => p });
  const lines = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(calls.length, 0); assert.ok(lines.some((l) => /budget/.test(l.text || ''))); assert.equal(lines.at(-1).plan.mode, 'planner');
});
