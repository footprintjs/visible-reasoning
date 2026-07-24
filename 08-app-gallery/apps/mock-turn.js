// The scripted mock router's two primitives, shared by all three packs.
//
// A turn is multi-phase now that context sources are real tool calls: the mock
// asks for one tool per iteration (in the POST-ABLATION order it was handed),
// then answers. Both primitives read ONLY the `role: 'tool'` messages — never the
// whole request.
//
// That distinction is load-bearing, not tidiness. The composed user message
// carries the RECORDED TRANSCRIPT of earlier turns, and an earlier reply can
// quote the driver source verbatim ("…near-universal acclaim…"). Routing on the
// whole blob would then see the driver even in a re-run that removed it — the
// counterfactual would come back un-flipped and the demo would be quietly lying.
export const toolResults = (req) =>
  req.messages.filter((m) => m.role === 'tool').map((m) => String(m.content ?? ''));

/** The next tool to consult, or null when every available tool has answered. */
export function nextToolCall(req, toolNames, args) {
  const done = toolResults(req).length;
  if (done >= toolNames.length) return null;
  // A reply carrying toolCalls still needs a content string (agentfootprint's
  // message composer reads it).
  return { content: '', toolCalls: [{ id: `t${done}`, name: toolNames[done], args }] };
}

/** Did the driver source actually reach this turn's context? */
export const sawDriver = (req, phrase) => toolResults(req).some((t) => t.includes(phrase));
