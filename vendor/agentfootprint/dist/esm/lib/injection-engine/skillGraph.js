/**
 * skillGraph — a declarative, visualizable skill-dependency graph (proposal 002).
 *
 * The consumer declares skills + routing EDGES; `skillGraph()` compiles each edge
 * to the existing injection-engine TRIGGER on the target skill — so the dynamic,
 * token-efficient loading the engine already does becomes *declared* and *drawn*.
 *
 *   .entry(skill, { when? })              → trigger: `always` (or `rule` if when)
 *   .route(a, b, { onToolReturn | when }) → b compiles to a CURSOR-GATED `rule`
 *   (a skill with no declared incoming edge keeps its default `llm-activated`
 *    trigger — still reachable via `read_skill`, drawn as a dashed "model" edge)
 *
 * **v2 keystone — `from` IS enforced (a sticky cursor state machine).** A skill
 * graph is a state machine over skills; the engine tracks which node it is in via
 * `InjectionContext.currentSkillId` (the cursor). One pure resolver — `nextSkill(ctx)`
 * (see `makeNextSkill`) — is the single source of truth: each route target B
 * compiles to the trigger `nextSkill(ctx) === B`, which delivers `from`-gating
 * (an edge `A→B` fires only while the cursor is on A — no cross-skill edge bleed),
 * stickiness (the cursor stays on B until an edge leaves B), and a clean handoff
 * (B deactivates the same iteration C activates). The Injection Engine's Evaluate
 * stage advances the cursor with the SAME ctx (`currentSkillId = nextSkill(ctx)`),
 * so the active set and the persisted cursor never disagree. The DRAWN edge kind
 * (`on-tool-return` vs `predicate`) is preserved for rendering even though the
 * compiled trigger is always a `rule`. `toMermaid()` renders declared === drawn.
 *
 * A decision `tree()` routes per-iteration by stable `ctx` predicates (no cursor)
 * and is unaffected by `from`-gating. Scoped `read_skill` (bounding the
 * model-reachable set by graph position) remains deferred — see proposal 002.
 */
import { isDevMode } from 'footprintjs';
import { embeddingScorer } from './entryScorer.js';
import { checkupGraph, formatCheckup } from './skillGraphCheckup.js';
import { checkSkillContracts } from './skillContract.js';
/** Build a decision node. Leaves are skills (an `Injection`); internal nodes are
 *  other `decideSkill(...)` results. (Renamed from `decide` in v7 to avoid
 *  colliding with footprintjs's `decide()`.) */
export function decideSkill(predicate, whenTrue, whenFalse, label) {
    return { kind: 'decision', predicate, whenTrue, whenFalse, label };
}
function isDecisionNode(n) {
    return n.kind === 'decision';
}
/** The metadata key carrying a skill's routing provenance. */
export const SKILL_GRAPH_METADATA_KEY = 'skillGraph';
/** Mermaid node ids must be identifier-safe; keep the original id as the label. */
function nodeId(id) {
    return 'n_' + id.replace(/[^A-Za-z0-9_]/g, '_');
}
function toolMatcher(toolName) {
    return typeof toolName === 'string' ? (n) => n === toolName : (n) => toolName.test(n);
}
export function skillGraph(config) {
    const skillsById = new Map();
    const entries = [];
    const routes = [];
    let treeRoot;
    let treeScopeTools = true;
    let entryScorer;
    let entryByReadFlag = false;
    const remember = (skill) => {
        if (skill.flavor !== 'skill') {
            throw new Error(`skillGraph: "${skill.id}" is not a skill (flavor='${skill.flavor}').`);
        }
        skillsById.set(skill.id, skill);
        return skill.id;
    };
    const builder = {
        entry(skill, opts) {
            const id = remember(skill);
            entries.push({ id, when: opts?.when, label: opts?.label });
            return builder;
        },
        route(from, to, opts) {
            const fromId = remember(from);
            const toId = remember(to);
            if (opts?.when && opts?.onToolReturn) {
                throw new Error(`skillGraph: route ${fromId}→${toId} sets both 'when' and 'onToolReturn' — pick one.`);
            }
            routes.push({
                fromId,
                toId,
                when: opts?.when,
                onToolReturn: opts?.onToolReturn,
                label: opts?.label,
            });
            return builder;
        },
        tree(root, opts) {
            treeRoot = root;
            if (opts?.scopeTools === false)
                treeScopeTools = false;
            return builder;
        },
        entryBy(scorer) {
            entryScorer = scorer;
            return builder;
        },
        entryByRelevance(embedder) {
            entryScorer = embeddingScorer(embedder);
            return builder;
        },
        entryByRead() {
            entryByReadFlag = true;
            return builder;
        },
        build(opts = {}) {
            if (entryByReadFlag && entryScorer) {
                throw new Error('skillGraph: pick one of .entryByRead() or .entryBy()/.entryByRelevance() — not ' +
                    'both (the LLM reads the menu, OR a scorer ranks it).');
            }
            if (entryByReadFlag && treeRoot) {
                throw new Error('skillGraph: .entryByRead() is for flat entry/route graphs; a .tree() already ' +
                    'routes by predicate (no entry menu).');
            }
            if (entryScorer && treeRoot) {
                throw new Error('skillGraph: .entryBy()/.entryByRelevance() is for flat entry/route graphs; a ' +
                    '.tree() already routes by predicate (the scorer would be ignored).');
            }
            const skills = [];
            const nodes = [];
            const edges = [];
            // The build-time check-up — pure over the declared entries/routes/skills,
            // PLUS the proposal-009 Tier-1 skill-body ↔ tool-contract checks (warnings).
            const checkup = () => {
                const wiring = checkupGraph({
                    skillIds: new Set(skillsById.keys()),
                    entryIds: entries.map((e) => e.id),
                    routes: routes.map((r) => ({
                        fromId: r.fromId,
                        toId: r.toId,
                        deterministic: !!(r.when || r.onToolReturn),
                    })),
                    isTree: treeRoot !== undefined,
                });
                const contract = checkSkillContracts([...skillsById.values()]);
                const problems = [...wiring.problems, ...contract];
                return { ok: !problems.some((p) => p.kind === 'error'), problems };
            };
            // The cursor resolver — the single source of truth for `from`-gated, sticky
            // routing. Flat mode wires it into each route target's trigger AND returns it
            // for the loop's cursor-update stage. Tree mode has no cursor (per-iteration
            // predicate routing), so it stays a no-op there.
            let nextSkill = (ctx) => ctx.currentSkillId;
            // The reachable-set resolver — what `read_skill` may jump to from the cursor
            // (the runtime gate enforces it). Default empty; set per mode below.
            let reachableSkills = () => [];
            // The relevance entry scorer — present only with `.entryByRelevance()` (flat).
            let scoreEntries;
            if (treeRoot) {
                // Decision-tree mode (v3): compile each leaf to a path-conjunction trigger.
                compileTree(treeRoot, () => true, { skills, nodes, edges }, null, { n: 0 }, [], treeScopeTools);
                attachExactlyOneLeafMonitor(skills);
                // Tree mode has no cursor — `read_skill` stays a full escape hatch (all leaves).
                const leafIds = skills.map((s) => s.id);
                reachableSkills = () => leafIds;
            }
            else {
                // Flat entry/route mode (v1 + v2 keystone). `from`-gating + sticky cursor
                // both derive from one pure resolver so they can never diverge.
                // `.entryByRead()` makes the entries EXCLUSIVE (like `.entryByRelevance()`),
                // but the cold-start pick is the model's: no entry auto-loads — the LLM picks
                // one via `read_skill`, and that choice becomes the cursor (see makeNextSkill).
                const llmReadEntry = entryByReadFlag;
                nextSkill = makeNextSkill(entries, routes, llmReadEntry);
                reachableSkills = makeReachableSkills(entries, routes);
                if (entryScorer)
                    scoreEntries = makeScoreEntries(entries, skillsById, entryScorer);
                for (const [id, skill] of skillsById) {
                    const trigger = deriveTrigger(id, skill, entries, routes, nextSkill, entryScorer !== undefined || llmReadEntry);
                    const routing = routingFor(id, entries, routes);
                    skills.push({
                        ...skill,
                        ...(trigger && { trigger }),
                        metadata: { ...skill.metadata, [SKILL_GRAPH_METADATA_KEY]: routing },
                    });
                    nodes.push({ id, kind: 'skill', label: id });
                }
                edges.push(...entries.map((e) => ({ from: null, to: e.id, kind: 'entry', label: e.label })), ...routes.map((r) => ({
                    from: r.fromId,
                    to: r.toId,
                    kind: r.onToolReturn ? 'on-tool-return' : r.when ? 'predicate' : 'model',
                    label: r.label ?? (r.onToolReturn ? `on ${String(r.onToolReturn)}` : undefined),
                })));
            }
            // Run the check-up per the `check` mode (default 'warn'): 'throw' fails loud on
            // an error; 'warn' prints in dev mode only (quiet in prod / tests); 'off' skips.
            const check = opts.check ?? 'warn';
            if (check !== 'off') {
                const result = checkup();
                if (check === 'throw' && !result.ok) {
                    throw new Error(`skillGraph: build-time check-up failed:\n${formatCheckup(result)}`);
                }
                if (result.problems.length > 0 && isDevMode()) {
                    // eslint-disable-next-line no-console
                    console.warn(`skillGraph: build-time check-up found problems:\n${formatCheckup(result)}`);
                }
            }
            return {
                skills,
                edges,
                nodes,
                toMermaid: () => renderMermaid(nodes, edges),
                nextSkill: (ctx) => nextSkill(ctx),
                reachableSkills: (currentSkillId) => reachableSkills(currentSkillId),
                checkup,
                ...(scoreEntries && { scoreEntries }),
            };
        },
    };
    // Object-literal form → translate to the fluent calls + build. Listing skills
    // independently of the wiring is what lets the check-up flag a listed-but-unwired
    // skill (every config skill is registered, even if no edge references it).
    if (config) {
        for (const s of config.skills)
            remember(s);
        const resolve = (id) => {
            const s = skillsById.get(id);
            if (!s)
                throw new Error(`skillGraph: config references skill "${id}" not in skills[].`);
            return s;
        };
        if (config.tree) {
            builder.tree(config.tree);
        }
        else if (config.start !== undefined) {
            const start = config.start;
            if (typeof start === 'string')
                builder.entry(resolve(start));
            else if ('use' in start)
                builder.entry(resolve(start.use));
            else if ('rules' in start)
                for (const r of start.rules)
                    builder.entry(resolve(r.use), { when: r.when });
            else {
                for (const id of start.entries)
                    builder.entry(resolve(id));
                // scoredBy (any scorer) > byRelevance (embedder sugar) > entryByRead (LLM picks).
                if (start.scoredBy)
                    builder.entryBy(start.scoredBy);
                else if (start.byRelevance)
                    builder.entryByRelevance(start.byRelevance);
                else
                    builder.entryByRead();
            }
        }
        for (const step of config.steps ?? []) {
            builder.route(resolve(step.from), resolve(step.to), {
                ...(step.when && { when: step.when }),
                ...(step.onToolReturn && { onToolReturn: step.onToolReturn }),
                ...(step.label && { label: step.label }),
            });
        }
        return builder.build({ check: config.check ?? 'throw' });
    }
    return builder;
}
/**
 * The reachable-set resolver (the read_skill gate's allowed set). Pure +
 * deterministic over the build-time entries/routes:
 *   • cold start (cursor undefined) → the entry skills (you enter via entries);
 *   • otherwise → the cursor's direct successors (ANY declared edge out of it,
 *     deterministic OR bare/model) ∪ the entry skills, minus the cursor itself
 *     (a deliberate "stay" is the no-tool-call ReAct stop, not a self-`read_skill`).
 * Declaration order preserved; ids de-duplicated.
 */
function makeReachableSkills(entries, routes) {
    const entryIds = entries.map((e) => e.id);
    return (cur) => {
        const ids = cur === undefined ? [...entryIds] : [...successorsOf(cur, routes), ...entryIds];
        return dedupe(cur === undefined ? ids : ids.filter((id) => id !== cur));
    };
}
/** Direct successors of `from` — every declared route edge out of it (any kind). */
function successorsOf(from, routes) {
    return routes.filter((r) => r.fromId === from).map((r) => r.toId);
}
function dedupe(ids) {
    return [...new Set(ids)];
}
/**
 * Bind the chosen `EntryScorer` strategy into `graph.scoreEntries`. The engine owns
 * the `when`-filtering (it needs `ctx` + the entry predicates); the scorer owns the
 * ranking. Filters the entries to the `when`-passing candidates, hands the scorer
 * `{ userMessage, candidates: { id, description } }`, and returns its `EntryScoring`.
 * Async wrapper so a sync scorer (`keywordScorer`) and an async one (`embeddingScorer`)
 * present identically; runs once per turn in the OFF-LOOP PickEntry stage, never in
 * the sync route triggers, so `nextSkill` stays synchronous. An empty candidate set
 * (or a throwing scorer, caught by PickEntry) falls back to the normal cold-start entry.
 */
function makeScoreEntries(entries, skillsById, scorer) {
    return async (ctx, signal) => {
        const candidates = entries
            .filter((e) => {
            if (!e.when)
                return true;
            try {
                return e.when(ctx);
            }
            catch (err) {
                warnMatcherThrew(`entry "${e.id}"`, err);
                return false;
            }
        })
            .map((e) => ({ id: e.id, description: skillsById.get(e.id)?.description ?? e.id }));
        return scorer.score({ userMessage: ctx.userMessage, candidates }, signal);
    };
}
/** Does a single route edge fire for this context? Reads the previous
 *  iteration's tool result; `onToolReturn` matches the tool NAME, `when` runs
 *  the predicate over the result. No match (and no tool result) → false. */
function routeMatches(r, ctx) {
    const ltr = ctx.lastToolResult;
    if (!ltr)
        return false;
    if (r.onToolReturn)
        return toolMatcher(r.onToolReturn)(ltr.toolName);
    return r.when ? r.when(ltr) : false;
}
/**
 * The cursor resolver (the keystone). Pure + deterministic. Given the iteration
 * context, returns the skill the graph should be *in* after this iteration:
 *   • cold start (`currentSkillId` unset) → first `entry` whose `when` passes
 *     (an `always`-entry — no `when` — matches unconditionally);
 *   • a `from`-gated route (`fromId === currentSkillId`) whose predicate matches
 *     `lastToolResult`, first by declaration order → its target (the transition);
 *   • otherwise the current cursor unchanged (sticky stay).
 *
 * Each candidate predicate runs in its OWN try/catch so one throwing edge can't
 * block its siblings or crash the loop — a throw is treated as "no match" and,
 * in dev mode, warned. This is the design's `routeForResult` pin-table target.
 */
function makeNextSkill(entries, routes, llmReadEntry = false) {
    return (ctx) => {
        const cur = ctx.currentSkillId;
        if (cur === undefined) {
            if (llmReadEntry) {
                // LLM-read entry (`.entryByRead()`): the library does NOT auto-pick. The
                // cursor is whichever entry the model has chosen via `read_skill` (so it's
                // in `activatedInjectionIds`) and whose intent predicate passes — the first
                // such in declaration order. Until the model picks, there is NO current skill
                // (so no entry body loads), and `read_skill`'s cold-start gate offers exactly
                // the entries (see makeReachableSkills). This reuses the existing
                // read_skill → activatedInjectionIds path; the chosen entry's EXCLUSIVE
                // trigger (`nextSkill(ctx) === id`) then fires and the cursor takes over.
                for (const e of entries) {
                    if (!ctx.activatedInjectionIds.includes(e.id))
                        continue;
                    if (!e.when)
                        return e.id;
                    try {
                        if (e.when(ctx))
                            return e.id;
                    }
                    catch (err) {
                        warnMatcherThrew(`entry "${e.id}"`, err);
                    }
                }
                return undefined;
            }
            // Cold start: declaration-order first entry whose intent predicate passes.
            for (const e of entries) {
                if (!e.when)
                    return e.id;
                try {
                    if (e.when(ctx))
                        return e.id;
                }
                catch (err) {
                    warnMatcherThrew(`entry "${e.id}"`, err);
                }
            }
            return undefined;
        }
        // Transition: first from-gated deterministic edge that fires.
        for (const r of routes) {
            if (r.fromId !== cur)
                continue;
            if (!r.when && !r.onToolReturn)
                continue; // model edges don't auto-fire
            try {
                if (routeMatches(r, ctx))
                    return r.toId;
            }
            catch (err) {
                warnMatcherThrew(`route ${r.fromId}→${r.toId}`, err);
            }
        }
        return cur; // sticky stay — no edge out of the current skill fired
    };
}
function warnMatcherThrew(edge, err) {
    if (!isDevMode())
        return;
    // eslint-disable-next-line no-console
    console.warn(`agentfootprint skillGraph: ${edge} predicate threw — treated as no-match. ` +
        `Predicates must be pure + total. ${err instanceof Error ? err.message : String(err)}`);
}
/** Compile a skill's incoming edges → one injection trigger (or null = keep the
 *  skill's default `llm-activated` trigger, i.e. model-reachable via read_skill).
 *
 *  A route target B is active iff `nextSkill(ctx) === B`. That single expression
 *  delivers all three keystone properties from ONE source of truth:
 *    • `from`-gating  — `nextSkill` only fires an edge `A→B` while the cursor is
 *      on A, so the edge no longer bleeds into an unrelated skill D (the v1 bug);
 *    • stickiness     — when the cursor is on B and no edge leaves B, `nextSkill`
 *      returns B (sticky stay), so B re-activates each iteration;
 *    • clean handoff  — the iteration a `B→C` edge fires, `nextSkill` returns C,
 *      so B deactivates the SAME step C activates — no double-active overlap.
 *  Because the loop's cursor-update stage is ALSO `currentSkillId = nextSkill(ctx)`,
 *  the trigger and the cursor can never disagree. */
function deriveTrigger(id, _skill, entries, routes, nextSkill, exclusiveEntries) {
    const entry = entries.find((e) => e.id === id);
    if (entry) {
        // `.entryByRelevance()` / `.entryByRead()` make the entries EXCLUSIVE candidates:
        // exactly ONE loads — the best match (embedder) or the model's pick (read_skill) —
        // as the cursor, so only that entry's body lands (token-efficient). The same
        // cursor-gated trigger as a route target delivers that for both modes.
        if (exclusiveEntries) {
            return { kind: 'rule', activeWhen: (ctx) => nextSkill(ctx) === id };
        }
        // Default (v1): a persistent base (always) or intent-conditional (rule).
        // `currentSkillId` tracks the latest transitioned-into skill, orthogonal to an
        // always-on base, so entry semantics are non-breaking without entryByRelevance.
        return entry.when ? { kind: 'rule', activeWhen: entry.when } : { kind: 'always' };
    }
    // Deterministic incoming edges (when / onToolReturn) → cursor-gated + sticky.
    const incoming = routes.filter((r) => r.toId === id && (r.when || r.onToolReturn));
    if (incoming.length === 0)
        return null; // model-reachable — keep default trigger
    return { kind: 'rule', activeWhen: (ctx) => nextSkill(ctx) === id };
}
/** Walk a decision tree → push each leaf skill (with its path-conjunction trigger,
 *  earlier-sibling negation baked into the path) plus predicate/skill nodes +
 *  branch edges for drawing. */
function compileTree(node, pathCond, out, parent, counter, path, scopeTools) {
    if (isDecisionNode(node)) {
        const id = `d${counter.n++}`;
        const label = node.label ?? 'decide';
        out.nodes.push({ id, kind: 'predicate', label });
        out.edges.push({
            from: parent ? parent.id : null,
            to: id,
            kind: 'predicate',
            label: parent?.branch,
        });
        compileTree(node.whenTrue, (ctx) => pathCond(ctx) && node.predicate(ctx), out, { id, branch: 'yes' }, counter, [...path, { label, branch: 'yes' }], scopeTools);
        compileTree(node.whenFalse, (ctx) => pathCond(ctx) && !node.predicate(ctx), out, { id, branch: 'no' }, counter, [...path, { label, branch: 'no' }], scopeTools);
    }
    else {
        if (node.flavor !== 'skill') {
            throw new Error(`skillGraph.tree: leaf "${node.id}" is not a skill (flavor='${node.flavor}').`);
        }
        // The SAME skill may be the leaf of several branches ("ESXi questions" and
        // "io questions" both route to the io-profile bundle). Compile it ONCE:
        // merge repeated leaves into one injection whose trigger ORs the path
        // predicates — pushing a second same-id injection would explode in
        // Agent.injection()'s duplicate-id guard.
        const existingIdx = out.skills.findIndex((skill) => skill.id === node.id);
        if (existingIdx >= 0) {
            const prev = out.skills[existingIdx];
            const prevWhen = prev.trigger
                .activeWhen;
            const prevRouting = prev.metadata[SKILL_GRAPH_METADATA_KEY];
            const allPaths = [
                ...(prevRouting.paths ?? (prevRouting.path ? [prevRouting.path] : [])),
                path,
            ];
            out.skills[existingIdx] = {
                ...prev,
                trigger: {
                    kind: 'rule',
                    activeWhen: (ctx) => prevWhen(ctx) || pathCond(ctx),
                },
                metadata: {
                    ...prev.metadata,
                    [SKILL_GRAPH_METADATA_KEY]: { ...prevRouting, paths: allPaths },
                },
            };
            // Node already exists — add only the second parent edge (the drawing
            // correctly shows two predicate diamonds converging on one leaf).
            out.edges.push({
                from: parent ? parent.id : null,
                to: node.id,
                kind: 'predicate',
                label: parent?.branch,
            });
            return;
        }
        const routing = { via: 'tree', path };
        // On-demand tools: a tree routes to exactly one leaf per iteration, so scope
        // each leaf's tools to itself (`autoActivate: 'currentSkill'`) unless the user
        // opted out (`scopeTools: false`) or the skill already declared its own mode.
        const existingAuto = node.metadata?.autoActivate;
        const autoActivate = existingAuto ?? (scopeTools ? 'currentSkill' : undefined);
        out.skills.push({
            ...node,
            trigger: { kind: 'rule', activeWhen: pathCond },
            metadata: {
                ...node.metadata,
                [SKILL_GRAPH_METADATA_KEY]: routing,
                ...(autoActivate && { autoActivate }),
            },
        });
        out.nodes.push({ id: node.id, kind: 'skill', label: node.id });
        out.edges.push({
            from: parent ? parent.id : null,
            to: node.id,
            kind: 'predicate',
            label: parent?.branch,
        });
    }
}
/**
 * Dev-mode "exactly one leaf fires" monitor (backlog B11).
 *
 * A binary decision tree is exhaustive and non-overlapping BY CONSTRUCTION
 * (each leaf's trigger conjoins its root→leaf predicates with earlier-sibling
 * negation), so static analysis has nothing to check. The invariant breaks at
 * RUNTIME only — when a predicate is impure/non-deterministic: the evaluator
 * re-runs each `decide(...)` predicate once per leaf trigger, so a predicate
 * that answers differently across those calls can fire 0 or ≥2 leaves.
 *
 * In dev mode (footprintjs `enableDevMode()`), each compiled leaf trigger is
 * wrapped to tally fires per evaluation pass (keyed on the shared `ctx`
 * identity — `evaluateInjections` passes one ctx object to every trigger in a
 * pass). When all leaves have been evaluated for one ctx and the fired count
 * is not exactly 1, a console.warn names the leaves. Production pays one
 * `isDevMode()` check per evaluation; a throwing predicate is excluded here
 * because the evaluator already reports it (`skipped: 'predicate-threw'`).
 */
function attachExactlyOneLeafMonitor(skills) {
    const total = skills.length;
    if (total < 2)
        return; // single leaf — trivially exactly-one
    const passes = new WeakMap();
    for (let i = 0; i < skills.length; i++) {
        const skill = skills[i];
        const inner = skill.trigger.activeWhen;
        skills[i] = {
            ...skill,
            trigger: {
                kind: 'rule',
                activeWhen: (ctx) => {
                    if (!isDevMode())
                        return inner(ctx);
                    const fired = inner(ctx); // may throw → evaluator reports 'predicate-threw'
                    let pass = passes.get(ctx);
                    if (!pass) {
                        pass = { evaluated: 0, fired: [] };
                        passes.set(ctx, pass);
                    }
                    pass.evaluated += 1;
                    if (fired)
                        pass.fired.push(skill.id);
                    if (pass.evaluated === total) {
                        passes.delete(ctx); // reset so a reused ctx object starts a fresh pass
                        if (pass.fired.length !== 1) {
                            // eslint-disable-next-line no-console
                            console.warn(pass.fired.length === 0
                                ? `agentfootprint skillGraph.tree: NO leaf fired this iteration (expected exactly one). ` +
                                    `The tree is exhaustive by construction, so a decide() predicate likely returned ` +
                                    `different answers across leaf evaluations — predicates must be pure and deterministic. ` +
                                    `Leaves: ${skills.map((s) => s.id).join(', ')}.`
                                : `agentfootprint skillGraph.tree: ${pass.fired.length} leaves fired simultaneously ` +
                                    `(expected exactly one): ${pass.fired.join(', ')}. Each decide() predicate is ` +
                                    `re-evaluated per leaf, so impure/non-deterministic predicates break if/else exclusivity.`);
                        }
                    }
                    return fired;
                },
            },
        };
    }
}
/** Routing provenance for a flat entry/route skill (the v1 model). */
function routingFor(id, entries, routes) {
    const entry = entries.find((e) => e.id === id);
    if (entry)
        return { via: 'entry', ...(entry.label && { label: entry.label }) };
    const incoming = routes.filter((r) => r.toId === id && (r.when || r.onToolReturn));
    const first = incoming[0];
    if (first) {
        return {
            via: 'route',
            from: first.fromId,
            ...(first.label && { label: first.label }),
            triggerKind: first.onToolReturn ? 'on-tool-return' : 'rule',
        };
    }
    return { via: 'model' }; // model-reachable via read_skill
}
function renderMermaid(nodes, edges) {
    const kindById = new Map(nodes.map((n) => [n.id, n.kind]));
    const ref = (id) => (kindById.get(id) === 'predicate' ? id : nodeId(id));
    const lines = ['flowchart TD', '  __start__([▶ start])'];
    for (const n of nodes) {
        lines.push(n.kind === 'predicate'
            ? `  ${n.id}{"${n.label ?? n.id}"}` // predicate → diamond
            : `  ${nodeId(n.id)}["${n.label ?? n.id}"]`);
    }
    for (const e of edges) {
        const from = e.from === null ? '__start__' : ref(e.from);
        const arrow = e.kind === 'model' ? '-.->' : '-->'; // model edges dashed
        const label = e.label ? `|${e.label}|` : '';
        lines.push(`  ${from} ${arrow}${label} ${ref(e.to)}`);
    }
    return lines.join('\n');
}
//# sourceMappingURL=skillGraph.js.map