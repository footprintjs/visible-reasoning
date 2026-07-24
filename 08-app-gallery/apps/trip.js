// The trip advisor — app pack.
//
// "Should I hike X on Saturday?" over KEYLESS public APIs: Open-Meteo (geocode +
// 7-day forecast) and Wikipedia (place facts). The third source, `crowd_level`,
// is SYNTHETIC BY CONSTRUCTION — nobody measured it, so it never fetches anything
// and its sentence ALWAYS ends with a synthetic label, in every mode. That is the
// honesty exhibit of the gallery: a source that says what it is.

import { nextToolCall, sawDriver } from './mock-turn.js';

const WIKI_UA = 'footprintjs-visible-reasoning (https://github.com/footprintjs/visible-reasoning)';

// quoted "Place" first, then `hike|climb|visit <Place>` up to ?/!/. or a
// day/time word, else keep the session's current place.
function placeFromMessage(msg, fallback = 'Mission Peak') {
  const text = String(msg);
  const quoted = text.match(/["“”']([^"“”']{2,60})["“”']/);
  if (quoted) return quoted[1].trim();
  const verb = text.match(/\b(?:hike|hiking|climb|climbing|visit|visiting|walk up)\s+([^?!.]{2,60})/i);
  if (verb) {
    const cleaned = verb[1]
      .replace(/\b(on|this|next)?\s*(saturday|sunday|monday|tuesday|wednesday|thursday|friday|weekend|tomorrow|today)\b.*$/i, '')
      .replace(/\s+$/, '')
      .trim();
    if (cleaned.length >= 2) return cleaned;
  }
  return fallback || 'Mission Peak';
}

// WMO weather codes → one plain word. Open-Meteo documents the full table; these
// ten buckets are what a hiking decision actually turns on.
const WEATHER_WORD = {
  0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'foggy', 48: 'foggy', 51: 'drizzly', 53: 'drizzly', 55: 'drizzly',
  61: 'rainy', 63: 'rainy', 65: 'heavy rain', 71: 'snowy', 73: 'snowy', 75: 'heavy snow',
  80: 'showery', 81: 'showery', 82: 'heavy showers', 95: 'thundery', 96: 'thundery', 99: 'thundery',
};

// Deterministic, place-derived crowd bucket. NOT measured — see the label.
function crowdSentence(place) {
  let h = 0; for (const c of String(place)) h = ((h * 31) + c.charCodeAt(0)) >>> 0;
  const level = ['quietly', 'moderately', 'heavily'][h % 3];
  return `${place} is modeled as ${level} busy on weekend mornings.`
    + ' [source: synthetic — modeled crowd estimate, not measured]';
}

export const trip = {
  id: 'trip',
  title: 'The trip advisor',
  tagline: 'should I hike it? — with visible reasons',
  assistantLabel: 'Guide',
  accent: '#2E7D4F',
  accentDark: '#1E5C38',
  decisionWords: /\b(GO|POSTPONE)\b/,
  driver: 'weather_forecast',
  driverPhrase: 'chance of rain',

  system:
    'You are a trail guide helping someone decide whether to hike this Saturday. Call ONE '
    + 'tool, wait for its result, then decide whether to call the next — never request more '
    + 'than one tool in a single step. When you have consulted them, answer with a clear '
    + 'decision word (GO or POSTPONE) followed by one sentence of reasoning.',
  systemForEntity: (place) => ` The hike under discussion is ${place}.`,

  entity: {
    label: 'Trail',
    default: 'Mission Peak',
    parse: (msg, fallback) => placeFromMessage(msg, fallback),
  },

  tools: [
    {
      name: 'weather_forecast',
      description: "Saturday's forecast for a place — condition, high temperature and rain chance (Open-Meteo, keyless).",
      inputSchema: { type: 'object', properties: { place: { type: 'string', description: 'Trail or place name' } }, required: ['place'] },
      legendLabel: 'weather',
      async live({ place }, ctx) {
        try {
          const g = await (await ctx.safeFetch(
            `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1&format=json`,
          )).json();
          const hit = (g.results || [])[0];
          if (!hit) throw new Error(`no geocode match for ${place}`);
          const f = await (await ctx.safeFetch(
            `https://api.open-meteo.com/v1/forecast?latitude=${hit.latitude}&longitude=${hit.longitude}`
            + '&daily=weathercode,temperature_2m_max,precipitation_probability_max'
            + '&forecast_days=7&timezone=auto&temperature_unit=fahrenheit',
          )).json();
          const days = (f.daily && f.daily.time) || [];
          // Pick the next Saturday in the window (UTC day-of-week on the ISO date).
          let idx = days.findIndex((d) => new Date(`${d}T12:00:00Z`).getUTCDay() === 6);
          if (idx === -1) idx = 0;
          const word = WEATHER_WORD[f.daily.weathercode[idx]] ?? 'mixed';
          const high = Math.round(f.daily.temperature_2m_max[idx]);
          const rain = f.daily.precipitation_probability_max[idx];
          return `${days[idx] === days[0] ? 'The next forecast day' : 'Saturday'} at ${hit.name} looks ${word},`
            + ` with a high near ${high}°F and a ${rain}% chance of rain (${days[idx]}).`
            + ctx.labelLive('Open-Meteo forecast');
        } catch (err) {
          return `A Saturday forecast for ${place} could not be retrieved (illustrative — no signal).`
            + ctx.labelFallback(ctx.reasonOf(err));
        }
      },
      scripted: ({ place }) =>
        `Saturday at ${place} looks clear, with a high near 71°F and a 5% chance of rain. [source: scripted demo data]`,
    },
    {
      name: 'wiki_place',
      description: 'What a place is — a one-paragraph description (Wikipedia, keyless).',
      inputSchema: { type: 'object', properties: { place: { type: 'string', description: 'Trail or place name' } }, required: ['place'] },
      legendLabel: 'place',
      async live({ place }, ctx) {
        try {
          const j = await (await ctx.safeFetch(
            `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(place)}`,
            { headers: { 'user-agent': WIKI_UA } },
          )).json();
          const extract = String(j.extract || '').trim();
          if (!extract) throw new Error('no Wikipedia extract');
          return `${ctx.clip(extract, 240)}` + ctx.labelLive('Wikipedia');
        } catch (err) {
          return `A description of ${place} could not be retrieved (illustrative — no signal).`
            + ctx.labelFallback(ctx.reasonOf(err));
        }
      },
      scripted: ({ place }) =>
        `${place} is a summit reached by a steep, exposed trail with a wide view from the top. [source: scripted demo data]`,
    },
    {
      name: 'crowd_level',
      description: 'How busy a trail tends to be on a Saturday morning — a MODELED estimate, not measured data.',
      inputSchema: { type: 'object', properties: { place: { type: 'string', description: 'Trail or place name' } }, required: ['place'] },
      legendLabel: 'crowd',
      alwaysSynthetic: true,
      // No fetch in ANY mode — there is no keyless crowd API worth trusting, so
      // this source is honest about being a model instead of pretending.
      async live({ place }) { return crowdSentence(place); },
      scripted: ({ place }) => crowdSentence(place),
    },
  ],

  // One tool per iteration (in the POST-ABLATION order), then the decision — which
  // turns ONLY on whether the driver source reached this turn's tool results.
  scriptedRespond(req, { entity, toolNames }) {
    const call = nextToolCall(req, toolNames, { place: entity });
    if (call) return call;
    return sawDriver(req, trip.driverPhrase)
      ? 'GO — Saturday looks clear with a high near 71°F and only a 5% chance of rain.'
      : 'POSTPONE — without a forecast to rely on, nothing here says Saturday is the day for it.';
  },

  starters: ['Should I hike Mission Peak on Saturday?', 'What about "Mount Tamalpais"?'],
  story: ['Should I hike Mission Peak on Saturday?'],
};
