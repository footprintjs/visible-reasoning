// The movie desk — app pack.
//
// "Should I watch X tonight?" over two KEYLESS public APIs: iTunes Search
// (price / availability / advisory rating) and Wikipedia (plot + reception).
// Honest scope: iTunes gives commerce facts, NOT critic scores — the reception
// sentence comes from the critical-response section of the film's Wikipedia
// article, or says plainly that the article has none. Every `live` handler runs
// inside mcp-server.js and returns ONE sentence whose tail is its provenance
// label.

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
    // Only a parenthetical that ENDS in "film)" counts. "The Godfather (film
    // series)" carries the word too, and answering about the SERIES when someone
    // asked about the FILM is the same confidently-wrong context in a smaller
    // costume — the series article's reception is about three films at once.
    const isFilm = (t) => /\(.*\bfilm\)$/i.test(t);
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

// The whole article as plain text — headings kept, citation markers and markup
// already stripped by MediaWiki. One request, on the SAME /w/api.php endpoint the
// title search uses, which is why this works unchanged in a browser tab: the BYOK
// ctx (byok/browser-ctx.js) appends MediaWiki's `origin=*` CORS switch to that
// path and drops the user-agent a tab may not set. Verified byte-identical with
// and without `origin=*` (2026-07). The REST endpoints were the alternative and
// buy nothing here: /page/html would hand back HTML to strip, and section
// fetching (action=parse&prop=sections then &section=N) costs a second round trip
// for a section index this text already carries.
async function wikiPlainText(ctx, page) {
  const url = 'https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&redirects=1&format=json'
    + `&titles=${encodeURIComponent(page)}`;
  const j = await (await ctx.safeFetch(url, { headers: { 'user-agent': WIKI_UA } })).json();
  const pages = Object.values((j.query && j.query.pages) || {});
  // A miss comes back as a `missing` page with no extract; longest wins if a
  // redirect ever returns more than one.
  return pages.map((p) => String(p.extract || '')).sort((a, b) => b.length - a.length)[0] || '';
}

// Wikipedia files critic sentiment in a SUBSECTION. A film article's
// "== Reception ==" almost always opens with "=== Box office ===", so anchoring
// on "Reception" and reading its first paragraph returns MONEY — which is exactly
// the bug this tool shipped with: it was described to the model as critical
// reception and paid out grosses, and the model apologized for its own source
// mid-reply ("the reception data shows box office information but not critical
// reviews"). Section vocabulary surveyed across 30 film articles (2026-07): 27
// carry "Critical response"/"Critical reception"; older films file it under a
// different word (Casablanca "Initial response", Citizen Kane "Contemporary
// response"); short articles (Heat 1995) carry critic prose directly under a bare
// "Reception" with no subsections at all.
const CRITICAL_SECTION = /^critical\s+(?:response|reception|reaction|reviews?|analysis|reassessment)$/i;
const CRITICAL_SECTION_DATED = /^(?:initial|contemporary|original|modern|retrospective|critics'?)\s+(?:response|reception|reviews?)$/i;
const RECEPTION_SECTION = /^(?:release and )?reception(?:\s+and\s+legacy)?$/i;
// Evidence that a paragraph IS about critics, and evidence that it is about
// takings. Only the bare-"Reception" path needs them — there the heading promises
// nothing, so the prose has to prove itself. The bar deliberately mis-fires
// toward silence: Birdemic's reception paragraph quotes two publications without
// ever using a word from this list, and so comes back as honest absence rather
// than as a guess.
const CRITIC_WORDS = /\b(?:critics?|critical|reviews?|reviewers?|acclaim(?:ed)?|praise[ds]?|panned|consensus|Rotten Tomatoes|Metacritic|CinemaScore)\b|\d\/10/i;
const BOX_OFFICE_WORDS = /\bgross(?:ed|es|ing)?\b|\bbox[- ]office\b|\bopening weekend\b|\bproduction budget\b|\$\d/i;

const HEADING_LINE = /^=+.*=+$/;
// Sentence boundaries, minus the ones that are not: a plain /[.!?]\s/ split ends
// the sentence inside "stars J. K. Simmons", "ranked at No. 1", "Mr. Welles", and
// at the ellipsis in a quoted review ("The Warners ... have a picture").
const SENTENCE_BREAK = /(?<!\.\.)(?<!\b(?:No|Nos|Mr|Mrs|Ms|Dr|St|Jr|Sr|vs|Vol|Inc|Ltd|Co|Prof|Rev|Gen|Sen|Rep|approx|al|[A-Z])\.)(?<=[.!?]["'”’]?)\s+(?=["“'([]?[A-Z0-9])/;

// The article's section tree. `lead` is the section's OWN prose (it stops at the
// first subsection); `body` also spans everything nested under it.
function wikiSections(text) {
  const marks = [];
  const heading = /\n(=+)\s*([^=\n]+?)\s*\1\n/g;
  let m;
  while ((m = heading.exec(text))) marks.push({ level: m[1].length, title: m[2], at: m.index, start: m.index + m[0].length });
  return marks.map((s, i) => {
    const closing = marks.slice(i + 1).find((n) => n.level <= s.level);
    return {
      title: s.title,
      lead: text.slice(s.start, marks[i + 1] ? marks[i + 1].at : text.length),
      body: text.slice(s.start, closing ? closing.at : text.length),
    };
  });
}

const firstParagraph = (body) => body.split('\n').map((l) => l.trim())
  .find((l) => l.length >= 40 && !HEADING_LINE.test(l)) || '';
const firstSentences = (paragraph, n = 2) => paragraph.split(SENTENCE_BREAK).slice(0, n).join(' ').trim();

/**
 * What critics said, or null when the article does not say. Never box office:
 * a tool that promises criticism and pays out grosses is the defect this
 * function exists to make impossible, so every path either returns prose from a
 * section that names critics or returns nothing at all.
 */
function criticalResponse(text) {
  const sections = wikiSections(text);
  const named = sections.find((s) => CRITICAL_SECTION.test(s.title))
    ?? sections.find((s) => CRITICAL_SECTION_DATED.test(s.title));
  if (named) {
    // `body`, not `lead`: Titanic's "Critical response" holds no prose of its
    // own — its first words live in an "==== Initial ====" child.
    const sentence = firstSentences(firstParagraph(named.body));
    if (sentence && !(BOX_OFFICE_WORDS.test(sentence) && !CRITIC_WORDS.test(sentence))) {
      return { heading: named.title, sentence };
    }
  }
  const generic = sections.find((s) => RECEPTION_SECTION.test(s.title));
  if (generic) {
    // `lead`, not `body`: stopping at the first subsection is what keeps a
    // "=== Box office ===" child from bleeding back into the answer.
    const sentence = firstSentences(firstParagraph(generic.lead));
    if (sentence && CRITIC_WORDS.test(sentence) && !BOX_OFFICE_WORDS.test(sentence)) {
      return { heading: generic.title, sentence };
    }
  }
  return null;
}

// Exposed for verify-ia.mjs section F. The defect this file just fixed was
// LIVE-ONLY — the byte gate runs on scripted fixtures and never saw it — so the
// one thing that can catch its return is a pure test of this function against a
// fixture article. Same idiom as byok/browser-ctx.js.
export const __testables = { criticalResponse, wikiSections };

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
      // The description is a CONTRACT with the model, and this tool's original
      // one was broken: it promised criticism and returned box office, so the
      // model consulted it and then apologized for it in the reply ("the
      // reception data shows box office information but not critical reviews").
      // Both halves of what it can now return are named here — the sentiment and
      // the absence — so that "this article has no critical-response section" is
      // a real answer to work with, not a malfunction to apologize for.
      description: 'What critics said about a movie — the critical-response section of its Wikipedia '
        + 'article, never box office; says plainly when the article carries none (Wikipedia, keyless).',
      inputSchema: { type: 'object', properties: { title: { type: 'string', description: 'Movie title' } }, required: ['title'] },
      legendLabel: 'reception',
      // The flakiest fetch in the gallery, and the one with the most ways to be
      // quietly wrong. Both silences below are LABELED and specific rather than
      // invented: a synthetic "acclaim" sentence would steer the live decision
      // with data nobody measured, and box-office prose dressed as criticism
      // would do it while sounding sourced.
      async live({ title }, ctx) {
        try {
          const page = await resolveFilmTitle(ctx, title);
          const text = await wikiPlainText(ctx, page);
          if (!text) {
            return `No Wikipedia article was found for "${title}", so what critics said about it is unknown here.`
              + ctx.labelFallback('no Wikipedia article');
          }
          const found = criticalResponse(text);
          if (!found) {
            // The honest arm. The article exists and was read; it simply carries
            // no critic sentiment, and saying which article was read lets anyone
            // check that in one click.
            return `The Wikipedia article "${page}" has no critical-response section, so there is no critic sentiment to report for "${title}".`
              + ctx.labelFallback('no critical-response section');
          }
          return `${ctx.clip(found.sentence, 300)}` + ctx.labelLive(`Wikipedia — ${page}, ${found.heading} section`);
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
  // Wikipedia plot and Wikipedia critical response (2026-07, re-verified when
  // the reception tool was fixed to read critics instead of grosses); "Dune:
  // Part Two", "Jaws", "Barbie", "Nope" and "The Godfather" answer with real
  // critic sentiment the same way if a swap is ever wanted.
  starters: ['Should I watch "Interstellar" tonight?', 'Is "Dune" worth renting?'],
  // The scripted story is NOT a starter: it drives the byte-gated mock summary
  // (expected-output.txt) and runs on scripted tools that answer for any title.
  story: ['Should I watch "Heat" tonight?'],
};
