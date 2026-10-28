// Model Context Protocol server, Streamable HTTP transport, stateless JSON-RPC over POST /mcp.
// Any MCP client (a desktop MCP client, an editor, an agent framework) can call the same planner and
// safety layer the web app uses. Tools return JSON text.
import { TYPE } from './qloo.js';
import { validate, buildAvoid, screenEntity } from './safety.js';
import { plan, suggest, parseFavorites, resolveFavorite, nearbyFood } from './engine.js';

const kindEnum = { type: 'string', enum: ['tv', 'film', 'music'] };
export const MCP_TOOLS = [
  { name: 'plan_first_night', description: 'Plan a foster child\'s first night from live Qloo data: age-appropriate shows, films and music, a food errand near the foster home, gentle conversation openers, and everything held back with the reason. Trigger words, sensitive themes and content ratings are enforced in code. Do not send names, case numbers, or addresses.',
    inputSchema: { type: 'object', properties: { age: { type: 'integer', minimum: 2, maximum: 17 }, favorites: { type: 'string', description: 'Comma separated: shows, films, artists, games, foods.' }, triggers: { type: 'string', description: 'Comma separated things to avoid, such as "dogs, loud yelling".' }, hometown: { type: 'string' }, foster_city: { type: 'string', description: 'City name, for the restaurant errand.' } }, required: ['age', 'favorites'] } },
  { name: 'suggest', description: 'Age-screened Qloo suggestions of one kind, seeded by favorites. Returns the items and what was held back.',
    inputSchema: { type: 'object', properties: { kind: kindEnum, age: { type: 'integer', minimum: 2, maximum: 17 }, favorites: { type: 'array', items: { type: 'string' }, maxItems: 5 }, triggers: { type: 'string' }, hometown: { type: 'string' } }, required: ['kind', 'age', 'favorites'] } },
  { name: 'nearby_food', description: 'Restaurants near a city that serve a dish or cuisine, with bars removed. Says whether Qloo matched the dish or only the cuisine.',
    inputSchema: { type: 'object', properties: { food: { type: 'string', description: 'A dish or cuisine, for example "pho".' }, city: { type: 'string' }, age: { type: 'integer', minimum: 2, maximum: 17 }, triggers: { type: 'string' } }, required: ['food', 'city', 'age'] } },
  { name: 'check_item', description: 'Check one title or artist against the first-night safety rules for a child: content rating for the age, trigger words, sensitive themes such as separation or adoption, explicit music. Returns allowed or held back with the reason.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, kind: kindEnum, age: { type: 'integer', minimum: 2, maximum: 17 }, triggers: { type: 'string' } }, required: ['name', 'kind', 'age'] } },
];

const trim = (i) => ({ id: i.id, name: i.name, year: i.year, rating: i.rating, genres: i.genres, why: i.why, ...(i.address ? { address: i.address, city: i.city, matched_on: i.matchedOn } : {}) });

export async function callTool(q, name, a = {}) {
  if (name === 'plan_first_night') {
    const p = await plan(q, { age: a.age, favorites: a.favorites, triggers: a.triggers, hometown: a.hometown, fosterCity: a.foster_city });
    return { matched: p.matched, suggestions: Object.fromEntries(['tv', 'film', 'music'].map((k) => [k, (p.sections[k] || []).map(trim)])), restaurants: p.places.items.map(trim), restaurant_match: p.places.label, held_back: p.heldBack, avoiding: p.avoiding, openers: p.openers, run_of_show: p.runOfShow, notes: p.guard, privacy_removed: p.privacy.removed };
  }
  if (name === 'suggest') {
    const c = validate({ age: a.age, triggers: a.triggers, hometown: a.hometown });
    const avoid = buildAvoid(c.triggers);
    const seeds = (await Promise.all((a.favorites || []).slice(0, 5).map((f) => resolveFavorite(q, String(f).slice(0, 80))))).filter((r) => r.type === 'media').map((r) => r.entity);
    if (!seeds.length) return { items: [], note: 'None of the favorites matched a show, film, artist or game in Qloo.' };
    const r = await suggest(q, { kind: a.kind, seeds, age: c.age, avoid, hometown: a.kind === 'music' && c.hometown ? c.hometown : undefined });
    return { seeds: seeds.map((s) => s.name), items: r.items.map(trim), held_back: r.heldBack };
  }
  if (name === 'nearby_food') {
    const c = validate({ age: a.age, triggers: a.triggers, fosterCity: a.city });
    const r = await resolveFavorite(q, String(a.food || '').slice(0, 60));
    if (r.type !== 'food') return { items: [], note: 'Qloo has no restaurant tag for that food.' };
    const out = await nearbyFood(q, { food: r.food, city: c.fosterCity, avoid: buildAvoid(c.triggers), age: c.age });
    return { items: out.items.map(trim), match: out.level, note: out.label, held_back: out.heldBack };
  }
  if (name === 'check_item') {
    const c = validate({ age: a.age, triggers: a.triggers });
    const found = (await q.search(String(a.name || '').slice(0, 80), { types: TYPE[a.kind], take: 3 }))[0];
    if (!found) return { found: false };
    const why = screenEntity(found, { kind: a.kind, age: c.age, avoid: buildAvoid(c.triggers), marked: [] });
    return { found: true, name: found.name, year: found.year, rating: found.rating, allowed: !why, reason: why?.because || null };
  }
  throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 });
}

const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];
export async function handleRpc(msg, q) {
  const { id, method, params } = msg;
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  const err = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (id === undefined) return null; // notification
  switch (method) {
    case 'initialize': return ok({ protocolVersion: SUPPORTED.includes(params?.protocolVersion) ? params.protocolVersion : SUPPORTED[0], capabilities: { tools: {} }, serverInfo: { name: 'foster-first-night', version: '1.0.0' }, instructions: 'Plans a foster child\'s first night from live Qloo taste data with safety rules enforced in code. Never send names, case numbers or addresses.' });
    case 'ping': return ok({});
    case 'tools/list': return ok({ tools: MCP_TOOLS });
    case 'tools/call': {
      try { const out = await callTool(q, params?.name, params?.arguments); return ok({ content: [{ type: 'text', text: JSON.stringify(out) }] }); }
      catch (e) {
        if (e.code === -32602) return err(-32602, e.message);
        return ok({ content: [{ type: 'text', text: `Error: ${String(e.message).slice(0, 200)}` }], isError: true });
      }
    }
    default: return err(-32601, `Method not found: ${method}`);
  }
}
