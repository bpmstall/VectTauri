/**
 * ============================================================================
 * RETRIEVAL TRACE (Retrieval Inspector)
 * ============================================================================
 * Compact, in-memory record of the MOST RECENT EventBase retrieval per chat, so
 * the "Last retrieval" inspector can explain which events were injected, their
 * scores, and which near-miss candidates were dropped and why.
 *
 * Design constraints:
 *  - Memory only: one trace per chat, bounded chat count, never persisted.
 *  - Bounded: candidates capped at MAX_CANDIDATES, strings truncated.
 *  - Pure + defensive: buildRetrievalTrace never throws (returns null) and never
 *    mutates the retrieval pipeline's objects — retrieval results are identical
 *    with the inspector on or off.
 *  - No host imports, so it is unit-testable in isolation.
 * ============================================================================
 */

export const MAX_CANDIDATES = 60;
export const MAX_SUMMARY_CHARS = 160;
export const MAX_QUERY_CHARS = 300;
const MAX_CHATS = 10;

/** Statuses a candidate can end in. Only reasons the pipeline actually computes. */
export const TRACE_STATUS = Object.freeze({
    INJECTED: 'injected',
    BELOW_TOP_K: 'below_top_k',
    BELOW_MIN_IMPORTANCE: 'below_min_importance',
    DEDUPED: 'deduped',
    FILTERED_OTHER: 'filtered_other',
});

/** @param {object} [settings] */
export function isInspectorEnabled(settings) {
    return settings?.eventbase_inspector_enabled !== false;
}

function _trunc(value, max) {
    const s = String(value ?? '').replace(/\s+/g, ' ').trim();
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function _num(value, digits = 3) {
    return typeof value === 'number' && Number.isFinite(value)
        ? Number(value.toFixed(digits))
        : null;
}

function _keyOf(e) {
    return e?.event_id ?? e?._hash ?? null;
}

/**
 * Build the trace for one retrieveEvents run.
 *
 * Stage arrays hold the SAME object references flowing through the pipeline, so
 * membership is decided by identity (Set) — no re-scoring, no mutation.
 *
 * @param {object} input
 * @param {string} [input.queryText]        - keywordQuery || searchText
 * @param {string} [input.backend]          - settings.vector_backend
 * @param {object[]} input.rejected         - candidates removed by the min-importance filter (never scored)
 * @param {object[]} input.scored           - post importance filter, sorted by final score (desc)
 * @param {object[]} input.deduped          - survivors of similarity dedup
 * @param {object[]} input.contextDeduped   - survivors of dedup-depth filter
 * @param {object[]} input.final            - top-K slice (injected)
 * @param {Map<object, object>|WeakMap<object, object>} [input.components] - per-scored-object score components
 * @returns {object|null} trace, or null on malformed input
 */
export function buildRetrievalTrace(input) {
    try {
        const { rejected, scored, deduped, contextDeduped, final } = input || {};
        if (![rejected, scored, deduped, contextDeduped, final].every(Array.isArray)) return null;

        const dedupedSet = new Set(deduped);
        const contextSet = new Set(contextDeduped);
        const finalSet = new Set(final);
        const scoredSet = new Set(scored);

        const rows = [];
        const pushRow = (e, rank, scoredEntry) => {
            if (!e || typeof e !== 'object') return;
            let status;
            if (finalSet.has(e)) status = TRACE_STATUS.INJECTED;
            else if (!scoredSet.has(e)) status = TRACE_STATUS.BELOW_MIN_IMPORTANCE;   // only reachable via `rejected`
            else if (!dedupedSet.has(e)) status = TRACE_STATUS.DEDUPED;
            else if (!contextSet.has(e)) status = TRACE_STATUS.FILTERED_OTHER;
            else status = TRACE_STATUS.BELOW_TOP_K;

            const comps = scoredEntry ? (input.components?.get?.(e) || null) : null;
            rows.push({
                key: _keyOf(e),
                summary: _trunc(e.summary || e.text, MAX_SUMMARY_CHARS),
                eventType: e.event_type ? _trunc(e.event_type, 40) : null,
                importance: _num(e.importance, 1),
                rank,
                status,
                // Raw similarity as reported by the backend (null when it reports none).
                cosine: e._rerankApplied ? null : _num(typeof e.vectorScore === 'number' ? e.vectorScore : e.score),
                finalScore: scoredEntry ? _num(e._finalScore) : null,
                native: !!e._rerankApplied,
                components: comps,
                note: status === TRACE_STATUS.FILTERED_OTHER ? 'already visible in recent context (dedup depth)' : null,
            });
        };

        // Ranked candidates first (pipeline order), then importance-filtered ones.
        scored.forEach((e, i) => pushRow(e, i + 1, true));
        for (const e of rejected) pushRow(e, null, false);

        const native = rows.filter(r => r.native).length;
        return {
            ts: Date.now(),
            query: _trunc(input.queryText, MAX_QUERY_CHARS),
            backend: _trunc(input.backend || 'standard', 24),
            // 'native' = Qdrant formula scored all; 'js' = client pipeline; 'mixed' = both (e.g. archive events).
            rerank: native === 0 ? 'js' : (native === rows.length ? 'native' : 'mixed'),
            totalCandidates: rows.length,
            truncated: rows.length > MAX_CANDIDATES,
            injectedCount: final.length,
            candidates: rows.slice(0, MAX_CANDIDATES),
        };
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Last-trace-per-chat store (memory only)
// ---------------------------------------------------------------------------

const _traces = new Map();

/** Record the latest trace for a chat. Never throws. */
export function recordRetrievalTrace(chatId, trace) {
    try {
        if (!trace) return;
        const key = String(chatId ?? '');
        _traces.delete(key);            // re-insert to keep Map order = recency
        _traces.set(key, trace);
        while (_traces.size > MAX_CHATS) _traces.delete(_traces.keys().next().value);
    } catch { /* never throw into the generation path */ }
}

/** @returns {object|null} */
export function getLastRetrievalTrace(chatId) {
    return _traces.get(String(chatId ?? '')) || null;
}

export function clearRetrievalTraces() {
    _traces.clear();
}
