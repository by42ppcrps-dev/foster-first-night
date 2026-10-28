import { createQlooClient } from './qloo.js';
import { createGemini } from './gemini.js';
import { validate } from './safety.js';
import { plan } from './engine.js';
import { planWithAgent } from './agent.js';
import { handleRpc, MCP_TOOLS } from './mcp.js';

const MAX_BODY = 20000;
const DEFAULT_MODEL = 'gemini-3.1-flash-lite';
const DEFAULT_DAILY_CAP = 300;

// Nothing about a child is stored. The only thing written anywhere is a per-day run counter.
const json = (b, s = 200, h = {}) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...h } });
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, GET, OPTIONS', 'access-control-allow-headers': 'content-type, mcp-protocol-version, mcp-session-id, authorization' };

export const makeQloo = (env, fetchImpl) => createQlooClient({ apiKey: env.QLOO_API_KEY, baseUrl: env.QLOO_BASE_URL, ...(fetchImpl ? { fetchImpl } : {}) });
export const makeGemini = (env, fetchImpl) => (env.GEMINI_API_KEY ? createGemini({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL || DEFAULT_MODEL, ...(fetchImpl ? { fetchImpl } : {}) }) : null);

async function limited(env, request, bucket) {
  if (!env.LIMITER) return false;
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const { success } = await env.LIMITER.limit({ key: `${bucket}:${ip}` });
  return !success;
}
// A per-day cap on model runs keeps the spend bounded. Past the cap the built-in planner still works.
async function takeAgentRun(env) {
  const kv = env.BUDGET; if (!kv) return true;
  const key = `agent-runs:${new Date().toISOString().slice(0, 10)}`;
  const n = Number(await kv.get(key)) || 0;
  if (n >= Number(env.AGENT_DAILY_CAP || DEFAULT_DAILY_CAP)) return false;
  await kv.put(key, String(n + 1), { expirationTtl: 172800 });
  return true;
}
async function readBody(request) {
  const raw = await request.text();
  if (raw.length > MAX_BODY) throw Object.assign(new Error('Too much text. Share only a few favorites.'), { status: 413 });
  try { return JSON.parse(raw); } catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

export async function handleApi(request, env, ctx) {
  const url = new URL(request.url);
  if (url.pathname === '/api/meta') return json({ mode: 'live', agent: !!env.GEMINI_API_KEY, model: env.GEMINI_API_KEY ? (env.GEMINI_MODEL || DEFAULT_MODEL) : null, mcp: '/mcp', tools: MCP_TOOLS.map((t) => t.name), storesData: false });
  if (request.method !== 'POST') return json({ error: 'Not found' }, 404);
  if (url.pathname !== '/api/plan' && url.pathname !== '/api/agent') return json({ error: 'Not found' }, 404);
  if (await limited(env, request, 'plan')) return json({ error: 'A lot of plans from this network. Try again in a minute.' }, 429, { 'retry-after': '60' });
  let body;
  try { body = await readBody(request); validate(body || {}); } catch (e) { return json({ error: e.message }, e.status || 400); }

  if (url.pathname === '/api/plan') {
    try { return json(await plan(makeQloo(env, env.__fetch), body)); } catch (e) { return json({ error: 'Qloo did not answer. Try again in a moment.' }, 502); }
  }
  // /api/agent streams newline-delimited JSON: {type:'step'}* then {type:'result'} or {type:'error'}.
  const { readable, writable } = new TransformStream();
  const w = writable.getWriter(); const enc = new TextEncoder();
  const send = (o) => w.write(enc.encode(JSON.stringify(o) + '\n')).catch(() => {});
  ctx.waitUntil((async () => {
    try {
      const q = makeQloo(env, env.__fetch);
      let gemini = makeGemini(env, env.__geminiFetch);
      if (gemini && !(await takeAgentRun(env))) { gemini = null; await send({ type: 'step', text: 'Today\'s agent budget is used up, so the built-in planner is answering.' }); }
      const result = await planWithAgent({ q, gemini, input: body, emit: send });
      await send({ type: 'result', plan: result });
    } catch (e) { await send({ type: 'error', error: 'Could not build a plan. Try again.' }); }
    finally { await w.close().catch(() => {}); }
  })());
  return new Response(readable, { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } });
}

async function handleMcp(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  // Streamable HTTP: this server answers every request with a single JSON response, so GET (the
  // optional server-to-client stream) is not offered.
  if (request.method === 'GET') return new Response('This MCP server answers POST requests with JSON.', { status: 405, headers: { allow: 'POST, OPTIONS', ...CORS } });
  if (request.method === 'DELETE') return new Response(null, { status: 405, headers: { allow: 'POST, OPTIONS', ...CORS } });
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: CORS });
  if (await limited(env, request, 'mcp')) return json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Rate limited. Try again in a minute.' } }, 429, CORS);
  let msg;
  try { msg = await readBody(request); } catch (e) { return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: e.message } }, 400, CORS); }
  const q = makeQloo(env, env.__fetch);
  const batch = Array.isArray(msg);
  const out = (await Promise.all((batch ? msg : [msg]).slice(0, 10).map((m) => handleRpc(m, q)))).filter(Boolean);
  if (!out.length) return new Response(null, { status: 202, headers: CORS });
  return json(batch ? out : out[0], 200, CORS);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/mcp') return handleMcp(request, env);
    if (url.pathname.startsWith('/api/')) return handleApi(request, env, ctx);
    return env.ASSETS.fetch(request);
  },
};
