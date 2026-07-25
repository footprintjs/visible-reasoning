/**
 * LoggingRecorder — firehose-style structured logging of every event.
 *
 * Pattern: Facade over EventDispatcher's wildcard subscription.
 * Role:    Tier 3 observability — the low-level helper behind
 *          `attachLogging(dispatcher, {...})` (exported from
 *          `agentfootprint/observe`). For the high-level, uniform path use
 *          `agent.enable.observability({ strategy: consoleObservability() })`.
 *          Developer debugging tool; production typically uses an OTEL
 *          recorder instead.
 * Emits:   Does NOT emit; READS the dispatcher and writes to the logger.
 *
 * Filtering: consumer picks DOMAINS by name — the same domain segment that
 * appears in event types (`agentfootprint.<domain>.<action>`). No internal
 * tier jargon leaks into the public API.
 */
/**
 * Domain constants — one per event-registry domain. Use these instead of
 * raw strings for autocomplete, typo protection, and rename safety.
 *
 * Raw strings still work (backed by the same literal union type below).
 *
 * @example
 *   attachLogging(dispatcher, { domains: [LoggingDomains.CONTEXT, LoggingDomains.STREAM] });
 *   attachLogging(dispatcher, { domains: ['context', 'stream'] }); // equivalent
 */
export const LoggingDomains = {
    /** Context-engineering events (the 3-slot model). THE DEBUG CORE. */
    CONTEXT: 'context',
    /** LLM + tool request/response stream. */
    STREAM: 'stream',
    /** Composition control flow (Sequence / Parallel / Conditional / Loop). */
    COMPOSITION: 'composition',
    /** Agent lifecycle (turn · iteration · route_decided · handoff). */
    AGENT: 'agent',
    /** Memory strategy + store operations. */
    MEMORY: 'memory',
    /** Tool offered / activated / deactivated. */
    TOOLS: 'tools',
    /** Skill activation + deactivation. */
    SKILL: 'skill',
    /** Permission checks + gates. */
    PERMISSION: 'permission',
    /** Risk / guardrail detections. */
    RISK: 'risk',
    /** Provider / tool / skill fallback triggers. */
    FALLBACK: 'fallback',
    /** Cost + budget tracking. */
    COST: 'cost',
    /** Eval scores + threshold crossings. */
    EVAL: 'eval',
    /** Error retries + recoveries. */
    ERROR: 'error',
    /** Pause / resume requests. */
    PAUSE: 'pause',
    /** Embedding generation. */
    EMBEDDING: 'embedding',
};
/**
 * Attach a logging subscription to the event dispatcher.
 * Returns an Unsubscribe — call to detach.
 */
export function attachLogging(dispatcher, options = {}) {
    const logger = options.logger ?? defaultLogger();
    const domains = options.domains ?? ['context', 'stream'];
    const logAll = domains === 'all';
    const prefixes = logAll
        ? []
        : domains.map((d) => `agentfootprint.${d}.`);
    const format = options.format ?? defaultFormat;
    return dispatcher.on('*', (event) => {
        if (!shouldLog(event.type, logAll, prefixes))
            return;
        logger.log(format(event), event.payload);
    });
}
function shouldLog(name, logAll, prefixes) {
    if (logAll)
        return true;
    for (const p of prefixes)
        if (name.startsWith(p))
            return true;
    return false;
}
function defaultFormat(event) {
    const short = event.type.replace(/^agentfootprint\./, '');
    return `[${short}]`;
}
function defaultLogger() {
    return {
        log: (msg, data) => {
            // eslint-disable-next-line no-console
            if (data === undefined)
                console.log(msg);
            // eslint-disable-next-line no-console
            else
                console.log(msg, data);
        },
    };
}
//# sourceMappingURL=LoggingRecorder.js.map