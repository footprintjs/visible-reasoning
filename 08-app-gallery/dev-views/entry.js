// The two REAL developer views of this ecosystem, in one browser file.
//
// Nothing here is written for this demo: `ExplainableShell` is footprintjs's
// own inspector (footprint-explainable-ui) and `Lens` is agentfootprint's own
// agent debugger (agentfootprint-lens) — the same components their libraries
// ship to anyone. The desks mount them over a RECORDED turn, so what a visitor
// sees in the debug modal is what a developer of these libraries sees, reading
// the same bytes.
//
// The whole file is a re-export: it exists so esbuild has one entry to bundle
// (dev-views/build.mjs), and so the page has ONE global (`VRDevViews`) to reach
// both namespaces through.
export * as eui from 'footprint-explainable-ui';
export * as lens from 'agentfootprint-lens';

// agentfootprint's own post-hoc step-graph builder — "so an offline Trace can
// be rebuilt without re-running" (its words). Exported alongside the views
// because the offline Lens mount is exactly that case.
export { buildStepGraphFromEvents } from 'agentfootprint/observe';
