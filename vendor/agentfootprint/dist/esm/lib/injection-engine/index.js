/**
 * agentfootprint Injection Engine — public barrel.
 *
 * The unifying primitive of agentfootprint context engineering.
 * One `Injection` type. One `InjectionEngine` subflow. N typed sugar
 * factories. See `README.md` in this folder for the full concept.
 */
// POJO projection — used by slot subflows + advanced consumers
export { projectActiveInjection } from './types.js';
// Engine
export { evaluateInjections } from './evaluator.js';
export { buildInjectionEngineSubflow, } from './buildInjectionEngineSubflow.js';
// Sugar factories — Ships four; more flavors planned (RAG / Memory / Guardrail)
export { defineInstruction } from './factories/defineInstruction.js';
export { defineRelevanceHint } from './factories/defineRelevanceHint.js';
export { defineSkill, resolveSurfaceMode, } from './factories/defineSkill.js';
export { SkillRegistry } from './SkillRegistry.js';
// Skill-tool builders — used by SkillRegistry.toTools() and the Agent's
// auto-attach path. Exported so consumers building custom tool wiring
// (e.g., gatedTools chains) can compose the same `list_skills` /
// `read_skill` tools directly.
export { buildListSkillsTool, buildReadSkillTool } from './skillTools.js';
export { defineSteering } from './factories/defineSteering.js';
export { defineFact } from './factories/defineFact.js';
// Unified factory — a `type` discriminant routes to the four named factories
// above. Use when the flavor is chosen programmatically; prefer the named
// factories when you know the flavor at author time.
export { defineInjection, } from './factories/defineInjection.js';
// Declarative skill graph (proposal 002) — declare skills + routing edges →
// graph-derived triggers + a drawable topology. Sugar over the trigger model.
export { skillGraph, decideSkill, SKILL_GRAPH_METADATA_KEY, } from './skillGraph.js';
export { keywordScorer, embeddingScorer, rankEntries, } from './entryScorer.js';
export { checkSkillContract, checkSkillContracts, skillToolNames } from './skillContract.js';
//# sourceMappingURL=index.js.map