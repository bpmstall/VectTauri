/**
 * Retrieval Inspector tests: trace builder (status assignment, caps, robustness),
 * the last-trace-per-chat store, and proof that retrieveEvents returns identical
 * events with the inspector on or off. Mocks mirror eventbase-retrieval.test.js.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryCollectionMock = vi.fn();
vi.mock('../core/core-vector-api.js', () => ({
    queryCollection: (...a) => queryCollectionMock(...a),
    getQueryVector: vi.fn(async (_b, text) => [text.length, 0.5]),
}));
vi.mock('../backends/backend-manager.js', () => ({
    getBackendForCollection: vi.fn(async () => null),
    getBackend: vi.fn(async () => null),
}));
vi.mock('../core/collection-ids.js', () => ({
    parseRegistryKey: vi.fn((id) => ({ backend: null, collectionId: id })),
}));
vi.mock('../core/eventbase-schema.js', () => ({ parseEmbedText: vi.fn(() => ({})) }));
vi.mock('../core/collection-loader.js', () => ({ checkPluginAvailable: vi.fn(async () => true) }));
vi.mock('../core/log.js', () => ({
    log: {
        enabled: () => false, domainEnabled: () => false,
        error: () => {}, warn: () => {}, lifecycle: () => {}, verbose: () => {}, trace: () => {}, domain: () => {},
    },
    LOG_DOMAINS: [],
}));

import {
    buildRetrievalTrace, recordRetrievalTrace, getLastRetrievalTrace, clearRetrievalTraces,
    isInspectorEnabled, MAX_CANDIDATES, MAX_SUMMARY_CHARS, TRACE_STATUS,
} from '../core/retrieval-trace.js';
import { retrieveEvents } from '../core/eventbase-retrieval.js';

const ev = (i, extra = {}) => ({ event_id: `e${i}`, summary: `summary ${i}`, importance: 5, _finalScore: 1 - i * 0.01, ...extra });

describe('buildRetrievalTrace', () => {
    it('assigns a status to every pipeline stage', () => {
        const inj = ev(1), topk = ev(2), dup = ev(3), ctx = ev(4), lowImp = ev(5, { importance: 1 });
        const trace = buildRetrievalTrace({
            queryText: 'q', backend: 'qdrant',
            rejected: [lowImp],
            scored: [inj, topk, dup, ctx],
            deduped: [inj, topk, ctx],
            contextDeduped: [inj, topk],
            final: [inj],
        });
        const by = Object.fromEntries(trace.candidates.map(c => [c.key, c]));
        expect(by.e1.status).toBe(TRACE_STATUS.INJECTED);
        expect(by.e2.status).toBe(TRACE_STATUS.BELOW_TOP_K);
        expect(by.e3.status).toBe(TRACE_STATUS.DEDUPED);
        expect(by.e4.status).toBe(TRACE_STATUS.FILTERED_OTHER);
        expect(by.e5.status).toBe(TRACE_STATUS.BELOW_MIN_IMPORTANCE);
        expect(by.e1.rank).toBe(1);
        expect(by.e5.rank).toBeNull();
        expect(trace.injectedCount).toBe(1);
        expect(trace.rerank).toBe('js');
    });

    it('caps candidates and truncates strings', () => {
        const many = Array.from({ length: 100 }, (_, i) => ev(i, { summary: 'x'.repeat(500) }));
        const trace = buildRetrievalTrace({
            queryText: 'q'.repeat(1000), rejected: [], scored: many, deduped: many, contextDeduped: many, final: many.slice(0, 5),
        });
        expect(trace.candidates).toHaveLength(MAX_CANDIDATES);
        expect(trace.totalCandidates).toBe(100);
        expect(trace.truncated).toBe(true);
        expect(trace.candidates[0].summary.length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS);
        expect(trace.query.length).toBeLessThanOrEqual(300);
    });

    it('reports native rerank and carries components', () => {
        const e = ev(1, { _rerankApplied: true, score: 0.9 });
        const comps = new WeakMap([[e, { formula: 0.9, anchor: 0.2 }]]);
        const trace = buildRetrievalTrace({ rejected: [], scored: [e], deduped: [e], contextDeduped: [e], final: [e], components: comps });
        expect(trace.rerank).toBe('native');
        expect(trace.candidates[0].components).toEqual({ formula: 0.9, anchor: 0.2 });
        expect(trace.candidates[0].cosine).toBeNull();
    });

    it('never throws on malformed input', () => {
        expect(buildRetrievalTrace(undefined)).toBeNull();
        expect(buildRetrievalTrace({})).toBeNull();
        expect(buildRetrievalTrace({ rejected: 1, scored: [], deduped: [], contextDeduped: [], final: [] })).toBeNull();
        const weird = [null, 5, 'x', { summary: { toString() { throw new Error('boom'); } } }];
        expect(() => buildRetrievalTrace({ rejected: weird, scored: weird, deduped: weird, contextDeduped: weird, final: weird })).not.toThrow();
    });
});

describe('trace store and setting', () => {
    beforeEach(() => clearRetrievalTraces());

    it('keeps only the last trace per chat', () => {
        recordRetrievalTrace('chatA', { ts: 1 });
        recordRetrievalTrace('chatA', { ts: 2 });
        recordRetrievalTrace('chatB', { ts: 3 });
        expect(getLastRetrievalTrace('chatA').ts).toBe(2);
        expect(getLastRetrievalTrace('chatB').ts).toBe(3);
        expect(getLastRetrievalTrace('none')).toBeNull();
    });

    it('bounds the number of chats held', () => {
        for (let i = 0; i < 25; i++) recordRetrievalTrace(`c${i}`, { ts: i });
        expect(getLastRetrievalTrace('c0')).toBeNull();
        expect(getLastRetrievalTrace('c24').ts).toBe(24);
    });

    it('recording a null trace or odd chat id does not throw', () => {
        expect(() => recordRetrievalTrace(undefined, null)).not.toThrow();
        expect(() => recordRetrievalTrace(undefined, { ts: 1 })).not.toThrow();
    });

    it('is enabled by default and disabled only by an explicit false', () => {
        expect(isInspectorEnabled({})).toBe(true);
        expect(isInspectorEnabled(undefined)).toBe(true);
        expect(isInspectorEnabled({ eventbase_inspector_enabled: false })).toBe(false);
    });
});

describe('retrieveEvents integration', () => {
    const run = (settings) => retrieveEvents({
        searchText: 'what happened to the hero', keywordQuery: 'hero', chatLength: 50,
        settings: { vector_backend: 'standard', eventbase_retrieval_top_k: 2, eventbase_retrieval_min_importance: 3, ...settings },
        liveCollectionIds: ['standard:vf_eventbase_x'], additionalCandidates: [], skipLiveQuery: false,
    });

    beforeEach(() => {
        queryCollectionMock.mockReset();
        const metadata = [1, 2, 3, 4].map(i => ({
            event_id: `evt_${i}`, event_type: `type_${i}`, text: `Event ${i}`, importance: i === 4 ? 1 : 6,
            should_persist: false, source_window_end: i * 30, score: 0.9 - i * 0.1, keywords: [], characters: [`c${i}`],
        }));
        queryCollectionMock.mockImplementation(async () => ({ hashes: metadata.map((_, i) => `h${i}`), metadata: metadata.map(m => ({ ...m })) }));
    });

    it('returns identical events with the inspector on or off', async () => {
        const on = await run({ eventbase_inspector_enabled: true });
        const off = await run({ eventbase_inspector_enabled: false });
        expect(on.events).toEqual(off.events);
        expect(on.events.length).toBe(2);
    });

    it('attaches a trace only when enabled', async () => {
        const on = await run({});
        const off = await run({ eventbase_inspector_enabled: false });
        expect(off.debug.trace).toBeUndefined();
        const byKey = Object.fromEntries(on.debug.trace.candidates.map(c => [c.key, c.status]));
        expect(byKey.evt_1).toBe('injected');
        expect(byKey.evt_2).toBe('injected');
        expect(byKey.evt_3).toBe('below_top_k');
        expect(byKey.evt_4).toBe('below_min_importance');
        expect(on.debug.trace.candidates[0].components).toHaveProperty('cosine');
    });
});
