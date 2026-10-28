// Thin client for the Qloo hackathon API. Live data only: there is no mock and no fallback catalog.
//   GET /search?query=..&types=..
//   GET /v2/insights?filter.type=..&signal.interests.entities=..&filter.content_rating=..
//   GET /v2/tags?filter.query=..&filter.parents.types=..
// Auth is the X-Api-Key header. The key lives in a Worker secret and never leaves the server.
export const QLOO_BASE = 'https://hackathon.api.qloo.com';

export const TYPE = {
  tv: 'urn:entity:tv_show',
  film: 'urn:entity:movie',
  music: 'urn:entity:artist',
  place: 'urn:entity:place',
};
const KIND_OF = { 'urn:entity:tv_show': 'tv', 'urn:entity:movie': 'film', 'urn:entity:artist': 'music', 'urn:entity:place': 'place', 'urn:entity:video_game': 'game', 'urn:entity:videogame': 'game', 'urn:entity:book': 'book', 'urn:entity:podcast': 'podcast', 'urn:entity:album': 'album', 'urn:entity:brand': 'brand', 'urn:entity:person': 'person', 'urn:entity:author': 'author' };

const asList = (v) => {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') { try { const j = JSON.parse(v.replace(/'/g, '"')); if (Array.isArray(j)) return j; } catch { /* fall through */ } return v ? [v] : []; }
  return [];
};
const strs = (list) => list.map((x) => (typeof x === 'string' ? x : x?.name)).filter(Boolean);

// Keep only what the app needs. Everything below is read from Qloo, nothing is invented.
export function slim(raw) {
  const p = raw.properties || {};
  const type = raw.subtype || raw.type || (raw.types && raw.types[0]) || '';
  const tagNames = (raw.tags || []).map((t) => t.name).filter(Boolean);
  const keywords = [...new Set([...strs(asList(p.keywords)), ...tagNames])].slice(0, 60);
  const description = [p.description, p.plot_summary, p.plot_themes_description].filter(Boolean).join(' ').slice(0, 1200);
  const address = p.address || null;
  return {
    id: raw.entity_id || raw.id,
    name: raw.name,
    kind: KIND_OF[type] || type.replace('urn:entity:', ''),
    year: p.release_year ? Number(p.release_year) : null,
    rating: p.content_rating && p.content_rating !== 'None' ? String(p.content_rating) : null,
    genres: asList(p.genres).slice(0, 4),
    popularity: raw.popularity ?? null,
    keywords,
    description,
    address,
    city: p.geocode?.city || null,
    phone: p.phone && p.phone !== 'None' ? p.phone : null,
    businessRating: p.business_rating ? Number(p.business_rating) : null,
    closed: p.is_closed === true || p.is_closed === 'True',
    lat: raw.location?.lat ?? null,
    lon: raw.location?.lon ?? null,
    affinity: raw.query?.affinity ?? null,
    because: (raw.query?.explainability?.['signal.interests.entities'] || []).map((x) => ({ id: x.entity_id, score: x.score })),
  };
}

export function createQlooClient({ apiKey, baseUrl = QLOO_BASE, fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  if (!apiKey) throw new Error('QLOO_API_KEY is not set');
  let calls = 0;
  async function get(path, params) {
    const url = new URL(path, baseUrl);
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) continue;
      url.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      calls++;
      const res = await fetchImpl(url.toString(), { headers: { 'X-Api-Key': apiKey, accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 429 && attempt === 0) { await new Promise((r) => setTimeout(r, 700)); continue; }
      if (res.status === 404) return {};
      if (!res.ok) throw new Error(`Qloo ${path} returned ${res.status}`);
      const text = await res.text();
      try { return JSON.parse(text); } catch { return {}; }
    }
    throw new Error(`Qloo ${path} was rate limited`);
  }
  return {
    get calls() { return calls; },
    // Free-text search across every entity type.
    search: async (query, { types, take = 8 } = {}) => ((await get('/search', { query, types, take })).results || []).map(slim),
    // Tag lookup, used to turn a dish or cuisine into the tag ids Qloo filters places by.
    tags: async (query, { parent = TYPE.place, take = 8 } = {}) => ((await get('/v2/tags', { 'filter.query': query, 'filter.parents.types': parent, take })).results?.tags || [])
      .map((t) => ({ id: t.id, name: t.name, type: t.type || (t.id || '').split(':').slice(2, 3)[0], popularity: t.popularity ?? 0 })),
    // The recommendation call. `explain` asks Qloo which of your seeds drove each result.
    insights: async (p) => ((await get('/v2/insights', {
      'filter.type': p.type,
      'filter.content_rating': p.ratings,
      'filter.tags': p.filterTags,
      'filter.exclude.entities': p.exclude,
      'filter.location.query': p.near,
      'filter.location.radius': p.radius,
      'signal.interests.entities': p.entities,
      'signal.interests.tags': p.tags,
      'signal.location.query': p.hometown,
      'signal.demographics.age': p.age,
      'feature.explainability': p.explain === false ? undefined : 'true',
      take: p.take ?? 12,
    })).results?.entities || []).map(slim),
  };
}
