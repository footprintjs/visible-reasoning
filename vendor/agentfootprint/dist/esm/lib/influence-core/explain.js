/**
 * explainChoice — a UI-ready VERDICT for one tool pick: which context
 * CHANNEL (system rules / user task / data from earlier tool results)
 * best explains it, with the exact unit text to quote.
 *
 * Thin composite over `attributeChoice` — same math, zero duplication:
 * the ranking, the top unit, and the per-channel share of positive
 * similarity mass all come from the one existing engine. What this adds
 * is presentation shape: the unit TEXT carried through (so a UI can
 * quote the citation verbatim), a per-channel top unit, and a channels
 * array sorted by share that lists EVERY channel present in the units —
 * including zero-share ones, so "the data channel contributed nothing"
 * is a visible verdict, not a missing key.
 *
 * Pattern: pure async function, embedder-injected. No agent/runtime
 *          imports — `src/lib/influence-core/` leaf, same as
 *          `attributeChoice` / `scoreMargin`.
 *
 * Honest claim (RFC-002 §2): every score and share here is embedding
 * geometry between the tool text and each unit — a PROXY for which
 * context the pick ALIGNS with, never proof the model used that unit.
 * This is Tier 1 (similarity); counterfactual ablation (Tier 3) is the
 * ground truth that would validate it.
 */
import { attributeChoice } from './attribute.js';
/**
 * Run `attributeChoice` and reshape the result for a UI: join each unit's
 * text back by id, pick the best unit per channel, and rank the channels
 * by their share of positive similarity mass.
 *
 * Fail-loud validation is inherited from `attributeChoice`: empty units
 * or duplicate unit ids throw — caller wiring bugs, not runtime conditions.
 */
export async function explainChoice(args) {
    const attribution = await attributeChoice({
        tool: args.tool,
        units: args.units,
        embedder: args.embedder,
        ...(args.signal ? { signal: args.signal } : {}),
    });
    // Join the unit text back by id (ids are unique — attributeChoice validated).
    const textById = new Map();
    for (const u of args.units)
        textById.set(u.id, u.text);
    const withText = (score) => ({
        ...score,
        text: textById.get(score.id),
    });
    const ranked = attribution.units.map(withText);
    // One verdict per channel, in first-appearance order (stable tiebreak),
    // then sorted by share descending. `ranked` is already descending, so
    // the first unit seen per channel is that channel's top.
    const channelOrder = [];
    const topByChannel = new Map();
    for (const u of args.units) {
        if (!channelOrder.includes(u.channel))
            channelOrder.push(u.channel);
    }
    for (const unit of ranked) {
        if (!topByChannel.has(unit.channel))
            topByChannel.set(unit.channel, unit);
    }
    const channels = channelOrder.map((channel) => {
        const top = topByChannel.get(channel);
        return {
            channel,
            share: attribution.byChannel[channel] ?? 0,
            ...(top ? { top } : {}),
        };
    });
    // Stable sort — zero-share channels sink to the end, ties keep order.
    channels.sort((a, b) => b.share - a.share);
    return {
        tool: attribution.tool,
        channels,
        top: withText(attribution.top),
        units: ranked,
    };
}
//# sourceMappingURL=explain.js.map