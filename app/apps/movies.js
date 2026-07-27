// The movie desk — app pack.
//
// "Should I watch X tonight?" over two KEYLESS public APIs: iTunes Search
// (price / availability / advisory rating) and Wikipedia (plot + reception).
// Honest scope: iTunes gives commerce facts, NOT critic scores — the reception
// sentence comes from Wikipedia and says so. Every `live` handler runs inside
// mcp-server.js and returns ONE sentence whose tail is its provenance label.

import { nextToolCall, sawDriver } from './mock-turn.js';

const WIKI_UA = 'footprintjs-visible-reasoning (https://github.com/footprintjs/visible-reasoning)';

// quoted "Title" first, then `watch <Title>` / `renting <Title>` up to ?/!/.,
// else keep the session's current movie.
function titleFromMessage(msg, fallback = 'Heat') {
  const text = String(msg);
  const quoted = text.match(/["“”']([^"“”']{2,60})["“”']/);
  if (quoted) return quoted[1].trim();
  const verb = text.match(/\b(?:watch|watching|rent|renting|see|seeing)\s+([^?!.]{2,60})/i);
  if (verb) {
    // Strip the time phrases people tack onto "watch X tonight".
    const cleaned = verb[1]
      .replace(/\b(tonight|today|tomorrow|this weekend|again|later|now)\b.*$/i, '')
      .replace(/\s+$/, '')
      .trim();
    if (cleaned.length >= 2) return cleaned;
  }
  return fallback || 'Heat';
}

// Resolve a spoken movie title to the Wikipedia page that is actually about the
// FILM. Guessing `"<title> (film)"` is not enough — "Heat (film)" is a redlink
// and the bare title lands on thermodynamics, which is exactly the kind of
// confidently-wrong context this repo exists to make visible. So ask Wikipedia's
// (keyless) search API and prefer a hit whose title carries the "film"
// disambiguator. Cached per process; failures are NOT cached.
const filmTitleCache = new Map();
async function resolveFilmTitle(ctx, title) {
  const key = String(title).toLowerCase();
  if (filmTitleCache.has(key)) return filmTitleCache.get(key);
  try {
    const j = await (await ctx.safeFetch(
      `https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=5&srsearch=${encodeURIComponent(`${title} film`)}`,
      { headers: { 'user-agent': WIKI_UA } },
    )).json();
    const hits = ((j.query && j.query.search) || []).map((h) => String(h.title));
    const isFilm = (t) => /\(.*film.*\)/i.test(t);
    const resolved =
      hits.find((t) => isFilm(t) && t.toLowerCase().startsWith(key))
      ?? hits.find((t) => t.toLowerCase() === key)
      ?? hits.find(isFilm)
      ?? hits[0]
      ?? title;
    filmTitleCache.set(key, resolved);
    return resolved;
  } catch {
    return title; // no resolution available — the caller's own fallback still applies
  }
}

async function wikiSummary(ctx, title) {
  return (await ctx.safeFetch(
    `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
    { headers: { 'user-agent': WIKI_UA } },
  )).json();
}

export const movies = {
  id: 'movies',
  title: 'The movie desk',
  tagline: 'should I watch it? — with visible reasons',
  assistantLabel: 'Critic',
  accent: '#7A4CBF',
  accentDark: '#5A3395',
  decisionWords: /\b(WATCH|SKIP)\b/,
  driver: 'wiki_reception',
  driverPhrase: 'universal acclaim',

  system:
    'You are a movie critic helping someone decide what to watch tonight. Call ONE tool, '
    + 'wait for its result, then decide whether to call the next — never request more than '
    + 'one tool in a single step. When you have consulted them, answer with a clear decision '
    + 'word (WATCH or SKIP) followed by one sentence of reasoning.',
  // The critic's house rule — LIVE ONLY, and load-bearing. See stocks.js for why
  // it is gated to live mode (the scorer embeds the system prompt, so appending it
  // in mock mode would move the frozen expected-output.txt scores) and why it says
  // "available to you this turn" (a re-run replays this prompt minus one tool).
  consultProtocol:
    ' House rule: never give a verdict until you have consulted EVERY source available to '
    + 'you this turn — itunes_lookup, wiki_plot and wiki_reception — one call each, even '
    + 'when the first result already looks decisive; a verdict that skipped a source is not '
    + 'a verdict. If one of them is not available to you on this turn, use the ones that are '
    + 'and say so.',
  systemForEntity: (title) => ` The movie under discussion is "${title}".`,

  entity: {
    label: 'Movie',
    default: 'Heat',
    parse: (msg, fallback) => titleFromMessage(msg, fallback),
  },

  tools: [
    {
      name: 'itunes_lookup',
      description: 'Price, availability and advisory rating for a movie (iTunes Search, keyless).',
      inputSchema: { type: 'object', properties: { title: { type: 'string', description: 'Movie title' } }, required: ['title'] },
      legendLabel: 'itunes',
      async live({ title }, ctx) {
        try {
          // NOTE: `media=movie` / `entity=movie` returns resultCount 0 from the
          // public endpoint (verified 2026-07); the movie catalog only comes back
          // on an UNFILTERED search, so filter on `kind === 'feature-movie'`
          // client-side instead.
          const url = `https://itunes.apple.com/search?term=${encodeURIComponent(title)}&limit=50`;
          const j = await (await ctx.safeFetch(url)).json();
          const hits = (j.results || []).filter((r) => r && r.kind === 'feature-movie' && r.trackName);
          if (!hits.length) throw new Error('no iTunes movie match');
          const lower = title.toLowerCase();
          const exact = hits.find((r) => String(r.trackName).toLowerCase() === lower);
          const best = exact
            ?? hits.find((r) => String(r.trackName).toLowerCase().startsWith(lower))
            ?? hits[0];
          // Say so when the store has no exact title — an unannounced substitution
          // ("Heat" → "Heatwave") is the quiet kind of wrong this repo is about.
          const lead = exact ? '' : `The closest iTunes match for "${title}" is `;
          const year = best.releaseDate ? String(best.releaseDate).slice(0, 4) : null;
          const rent = typeof best.trackRentalPrice === 'number' && best.trackRentalPrice > 0
            ? `rents for $${best.trackRentalPrice.toFixed(2)}`
            : (typeof best.trackPrice === 'number' && best.trackPrice > 0
              ? `is available to buy for $${best.trackPrice.toFixed(2)}`
              : 'is listed but carries no price right now');
          const rating = best.contentAdvisoryRating ? ` (advisory rating ${best.contentAdvisoryRating})` : '';
          const genre = best.primaryGenreName ? `, a ${best.primaryGenreName.toLowerCase()} title` : '';
          return `${lead}"${best.trackName}"${year ? ` (${year})` : ''}${genre} ${rent} on the iTunes Store${rating}.`
            + ctx.labelLive('iTunes Search');
        } catch (err) {
          return `"${title}" is typically available to rent for around $3.99 in HD (illustrative).`
            + ctx.labelFallback(ctx.reasonOf(err));
        }
      },
      scripted: ({ title }) =>
        `"${title}" rents for $3.99 in HD and is available now (advisory rating R). [source: scripted demo data]`,
    },
    {
      name: 'wiki_plot',
      description: 'One-paragraph plot / overview for a movie (Wikipedia, keyless).',
      inputSchema: { type: 'object', properties: { title: { type: 'string', description: 'Movie title' } }, required: ['title'] },
      legendLabel: 'plot',
      async live({ title }, ctx) {
        try {
          const page = await resolveFilmTitle(ctx, title);
          const j = await wikiSummary(ctx, page);
          const extract = String(j.extract || '').trim();
          if (!extract) throw new Error('no Wikipedia extract');
          return `${ctx.clip(extract, 240)}` + ctx.labelLive(`Wikipedia — ${page}`);
        } catch (err) {
          return `A plot summary for "${title}" could not be retrieved (illustrative — no signal).`
            + ctx.labelFallback(ctx.reasonOf(err));
        }
      },
      scripted: ({ title }) =>
        `"${title}" is a crime drama about a robbery crew and the squad chasing them. [source: scripted demo data]`,
    },
    {
      name: 'wiki_reception',
      description: 'What critics said about a movie — its critical reception (Wikipedia, keyless).',
      inputSchema: { type: 'object', properties: { title: { type: 'string', description: 'Movie title' } }, required: ['title'] },
      legendLabel: 'reception',
      // The flakiest fetch in the gallery. Its fallback is deliberately
      // UNOPINIONATED: a synthetic "acclaim" sentence would steer the live
      // decision with data nobody measured.
      async live({ title }, ctx) {
        try {
          const page = await resolveFilmTitle(ctx, title);
          const url = 'https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&redirects=1&format=json'
            + `&titles=${encodeURIComponent(page)}`;
          const j = await (await ctx.safeFetch(url, { headers: { 'user-agent': WIKI_UA } })).json();
          const pages = Object.values((j.query && j.query.pages) || {});
          const text = pages.map((p) => String(p.extract || '')).sort((a, b) => b.length - a.length)[0] || '';
          if (!text) throw new Error('no Wikipedia extract');
          const m = text.match(/\n==+\s*(Reception|Critical response|Critical reception)[^=]*==+\n([\s\S]{40,4000})/i);
          if (!m) throw new Error('no reception section');
          // Skip the subsection headings ("=== Box office ===") that often open a
          // Reception section — take the first line of actual prose.
          const body = m[2].trim().split('\n')
            .map((l) => l.trim())
            .find((l) => l.length > 60 && !/^=+.*=+$/.test(l)) || '';
          const sentence = body.split(/(?<=[.!?])\s+/).slice(0, 2).join(' ');
          if (!sentence) throw new Error('empty reception section');
          return `${ctx.clip(sentence, 300)}` + ctx.labelLive(`Wikipedia — ${page}, Reception section`);
        } catch (err) {
          return `Critical reception for "${title}" could not be retrieved (illustrative — no signal).`
            + ctx.labelFallback(ctx.reasonOf(err));
        }
      },
      scripted: ({ title }) =>
        `Critics gave "${title}" near-universal acclaim; it is widely called one of the great films of its decade. [source: scripted demo data]`,
    },
  ],

  // One tool per iteration (in the POST-ABLATION order), then the decision — which
  // turns ONLY on whether the driver source reached this turn's tool results.
  scriptedRespond(req, { entity, toolNames }) {
    const call = nextToolCall(req, toolNames, { title: entity });
    if (call) return call;
    return sawDriver(req, movies.driverPhrase)
      ? 'WATCH — near-universal acclaim outweighs the rental price.'
      : 'SKIP — mixed signals: price is fine but nothing here says tonight is the night.';
  },

  // The starters are TAPPABLE on the desk (lib/page.js Starters) — a visitor,
  // and the demo's owner on stage, sends them without typing. So they are not
  // decorative: each one must come back LIVE from all three sources.
  //
  // Apple's public Search API covers movies unevenly (`media=movie` returns
  // nothing at all, and the unfiltered search misses plenty of major titles —
  // "Blade Runner 2049", "The Matrix", "Top Gun: Maverick" all come back empty).
  // "Heat" — the pack's original starter, and still its default subject — has NO
  // exact iTunes match: the tool answers live and honestly, but about
  // "Heatwave" (2021), so the desk priced one film while Wikipedia described
  // another. These two were verified live on all three sources — iTunes Search,
  // Wikipedia plot and Wikipedia Reception (2026-07); "Dune: Part Two", "Jaws",
  // "Barbie" and "Nope" verified the same way if a swap is ever wanted.
  starters: ['Should I watch "Interstellar" tonight?', 'Is "Dune" worth renting?'],
  // The scripted story is NOT a starter: it drives the byte-gated mock summary
  // (expected-output.txt) and runs on scripted tools that answer for any title.
  story: ['Should I watch "Heat" tonight?'],
};
