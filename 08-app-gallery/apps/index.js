// The gallery's app packs. One plain object per app — the ONLY thing that forks
// per app; every other moving part lives in ../lib/.
//
// Tool names are globally unique ACROSS packs because all nine are registered on
// ONE local MCP server (mcp-server.js); each app's agent gets only its own subset.
import { stocks } from './stocks.js';
import { movies } from './movies.js';
import { trip } from './trip.js';

export const APPS = [stocks, movies, trip];

export const appById = (id) => APPS.find((a) => a.id === id);

export const ALL_TOOLS = APPS.flatMap((app) => app.tools.map((t) => ({ app, tool: t })));
