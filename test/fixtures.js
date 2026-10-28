// Synthetic fixtures. No Qloo data is stored in this repo: these are made-up titles shaped like Qloo responses.
export const raw = (o) => ({ entity_id: o.id, name: o.name, subtype: o.type, popularity: o.pop ?? 0.8, properties: { release_year: o.year, content_rating: o.rating, genres: o.genres || ['Family'], keywords: o.keywords || [], description: o.desc || '', address: o.address, geocode: o.city ? { city: o.city } : undefined, is_closed: o.closed }, tags: (o.tags || []).map((name) => ({ name })), location: o.lat ? { lat: o.lat, lon: o.lon } : undefined, query: { affinity: o.aff ?? 0.9, explainability: o.because ? { 'signal.interests.entities': o.because } : undefined } });

export const SEEDS = {
  'Test Show One': raw({ id: 'seed-tv-1', name: 'Test Show One', type: 'urn:entity:tv_show', year: 2018, rating: 'TV-Y' }),
  'Test Film One': raw({ id: 'seed-film-1', name: 'Test Film One', type: 'urn:entity:movie', year: 2021, rating: 'PG', pop: 0.7 }),
  'Overlap': raw({ id: 'seed-artist-x', name: 'Overlap', type: 'urn:entity:artist', pop: 0.99 }),
  'Overlap ': raw({ id: 'seed-tv-x', name: 'Overlap', type: 'urn:entity:tv_show', year: 2004, rating: 'TV-Y', pop: 0.5 }),
};
export const TV = [
  raw({ id: 'tv-a', name: 'Gentle Garden', type: 'urn:entity:tv_show', year: 2015, rating: 'TV-Y', because: [{ entity_id: 'seed-tv-1', score: 0.6 }, { entity_id: 'seed-film-1', score: 0.4 }] }),
  raw({ id: 'tv-b', name: 'Puppy Patrol Club', type: 'urn:entity:tv_show', year: 2016, rating: 'TV-Y', keywords: ['dog', 'rescue'] }),
  raw({ id: 'tv-c', name: 'Midnight Court', type: 'urn:entity:tv_show', year: 2019, rating: 'TV-14' }),
  raw({ id: 'tv-d', name: 'Unrated Thing', type: 'urn:entity:tv_show', year: 2020, rating: null }),
  raw({ id: 'tv-e', name: 'New Family Day', type: 'urn:entity:tv_show', year: 2017, rating: 'TV-G', desc: 'A girl is placed in foster care and learns to trust her new home.' }),
  raw({ id: 'tv-f', name: 'Quiet River', type: 'urn:entity:tv_show', year: 2014, rating: 'TV-G', because: [{ entity_id: 'seed-tv-1', score: 1 }] }),
];
export const ARTISTS = [
  raw({ id: 'ar-a', name: 'Lullaby Collective', type: 'urn:entity:artist', genres: ['Children'] }),
  raw({ id: 'ar-b', name: 'Late Night Trap', type: 'urn:entity:artist', genres: ['Trap'], desc: 'Explicit lyrics' }),
];
export const PLACES = [
  raw({ id: 'pl-a', name: 'Pho House', type: 'urn:entity:place', address: '1 Main St Testville, ID', city: 'Testville' }),
  raw({ id: 'pl-b', name: 'Corner Noodle Bar & Cocktails', type: 'urn:entity:place', genres: ['Bar'], address: '2 Main St', city: 'Testville' }),
  raw({ id: 'pl-c', name: 'Closed Kitchen', type: 'urn:entity:place', closed: true }),
  raw({ id: 'pl-d', name: 'Bowl Place', type: 'urn:entity:place', address: '3 Main St', city: 'Testville' }),
];
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
// A fake Qloo that answers the three endpoints from the fixtures above. Records every URL it saw.
export function fakeQlooFetch(seen = []) {
  return async (url) => {
    const u = new URL(url); seen.push(u);
    if (u.pathname === '/search') {
      const q = u.searchParams.get('query');
      return json({ results: Object.values(SEEDS).filter((e) => e.name.toLowerCase() === q.toLowerCase()) });
    }
    if (u.pathname === '/v2/tags') {
      const q = (u.searchParams.get('filter.query') || '').toLowerCase();
      if (q === 'pho') return json({ results: { tags: [{ id: 'urn:tag:specialty_dish:place:pho', name: 'Pho', type: 'urn:tag:specialty_dish:place', popularity: 0.9 }] } });
      if (q === 'vietnamese') return json({ results: { tags: [{ id: 'urn:tag:genre:place:restaurant:vietnamese', name: 'Vietnamese', type: 'urn:tag:genre:place', popularity: 1 }] } });
      return json({ results: { tags: [] } });
    }
    if (u.pathname === '/v2/insights') {
      const type = u.searchParams.get('filter.type');
      if (type === 'urn:entity:tv_show') return json({ results: { entities: TV } });
      if (type === 'urn:entity:artist') return json({ results: { entities: ARTISTS } });
      if (type === 'urn:entity:movie') return json({ results: { entities: [] } });
      if (type === 'urn:entity:place') return json({ results: { entities: u.searchParams.get('filter.tags')?.includes('vietnamese') ? PLACES : [PLACES[0]] } });
    }
    return json({});
  };
}
