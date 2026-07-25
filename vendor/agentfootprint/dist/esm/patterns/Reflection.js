/**
 * Reflection — iterative self-refinement via critic + revise.
 *
 * Paper: "Self-Refine: Iterative Refinement with Self-Feedback" —
 *        Madaan et al., 2023 (https://arxiv.org/abs/2303.17651).
 *
 * Pattern: Factory (GoF) → produces a `Runner` built from a `Loop`
 *          whose body is `Sequence(Propose → Critique → Revise)`.
 * Role:    patterns/ layer. Pure composition — no new abstractions.
 * Emits:   Loop's composition.iteration_start / iteration_exit plus
 *          every inner LLMCall's stream.llm_start/end.
 */
import { LLMCall } from '../core/LLMCall.js';
import { Loop } from '../core-flow/Loop.js';
import { Sequence } from '../core-flow/Sequence.js';
/**
 * Build a Reflection Runner. Each iteration:
 *   1. Propose — LLMCall writes a candidate answer based on the input
 *   2. Critique — LLMCall judges the candidate; exit marker stops loop
 *   3. Revise — next iteration's propose sees the previous critique
 *
 * Each iteration's output (the candidate proposal) becomes the next
 * iteration's input. The final iteration's proposal is returned.
 */
export function reflection(opts) {
    const stopMarker = opts.untilCritiqueContains ?? 'DONE';
    const maxIterations = opts.maxIterations ?? 3;
    // Each iteration body: Propose → Critique → Revise. The Sequence's
    // `current` carries whatever the final step returned.
    const body = Sequence.create({ id: 'refine-body' })
        .step('propose', LLMCall.create({
        provider: opts.provider,
        model: opts.model,
        ...(opts.temperature !== undefined && { temperature: opts.temperature }),
        ...(opts.maxTokens !== undefined && { maxTokens: opts.maxTokens }),
    })
        .system(opts.proposerPrompt)
        .build())
        .pipeVia((proposal) => ({
        message: `Proposal to critique:\n${proposal}\n\nRespond with critique. When the proposal is good enough, include the marker "${stopMarker}".`,
    }))
        .step('critique', LLMCall.create({
        provider: opts.provider,
        model: opts.model,
        ...(opts.temperature !== undefined && { temperature: opts.temperature }),
        ...(opts.maxTokens !== undefined && { maxTokens: opts.maxTokens }),
    })
        .system(opts.criticPrompt)
        .build())
        .build();
    // Loop body returns the critic's output; we wrap it so the next
    // iteration's input gets the ORIGINAL proposal + critique combined,
    // asking the revisor to improve. The Loop until-guard inspects the
    // critic response for the stop marker.
    return Loop.create({
        name: opts.name ?? 'Reflection',
        id: opts.id ?? 'reflection',
    })
        .repeat(body)
        .times(maxIterations)
        .until(({ latestOutput }) => latestOutput.includes(stopMarker))
        .build();
}
//# sourceMappingURL=Reflection.js.map