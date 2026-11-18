/**
 * Core Facts (pinned EventBase events) — pin flag round trip, cap/order,
 * dedup against retrieved events, the "Core facts" injection block, and
 * graceful degradation.
 *
 * Host/backend modules are mocked; eventbase-injection.js is pure and real.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    meta: {},                       // in-memory collection-metadata store
    listChunks: vi.fn(),
}));

vi.mock('../backends/backend-manager.js', () => ({
    getBackend: vi.fn(async () => ({ listChunks: mocks.listChunks })),
    getBackendForCollection: vi.fn(async () => ({ listChunks: mocks.listChunks })),
}));
vi.mock('../core/collection-ids.js', () => ({
    resolveBackendForCollection: (key) => {
        const [backend, ...rest] = String(key).split(':');
        return { backend, collectionId: rest.join(':') };
    },
}));
vi.mock('../core/collection-metadata.js', () => ({
    getCollectionMeta: (key) => ({ ...(mocks.meta[key] || {}) }),
    setCollectionMeta: (key, data) => { mocks.meta[key] = { ...(mocks.meta[key] || {}), ...data }; },
}));
vi.mock('../core/log.js', () => ({ log: { warn: vi.fn(), error() {}, domain() {}, trace() {}, verbose() {}, lifecycle: vi.fn(), enabled: () => false } }));

import {
    resolveCoreFactsMax, getPinnedHashes, isEventPinned, setEventPinned, setEventsPinned,
    selectCoreFacts, dedupeAgainstCoreFacts, pickAutoPinHashes,
} from '../core/eventbase-pins.js';
import { fetchCoreFacts, combineWithCoreFacts } from '../core/eventbase-core-facts.js';
import { formatCoreFactsBlock, formatEventsForInjectionDetailed } from '../core/eventbase-injection.js';
import { invalidateCoreFactsCache, getCachedCoreFacts, setCachedCoreFacts, pinSignature, CORE_FACTS_CACHE_TTL_MS } from '../core/core-facts-cache.js';
import { log } from '../core/log.js';

const KEY = 'vectra:vf_eventbase_standard_c1';
const COL = [{ collectionId: 'vf_eventbase_standard_c1', registryKey: KEY }];

const ev = (id, o = {}) => ({
    event_id: id, eventbase: true, event_type: 'fact', importance: 5,
    text: `[fact] summary_${id}`, source_window_end: 10,
    characters: [], locations: [], factions: [], items: [], concepts: [], keywords: [], open_threads: [],
    ...o,
});
const item = (hash, e) => ({ hash, text: e.text, metadata: e });

beforeEach(() => {
    invalidateCoreFactsCache();
    mocks.meta = {};
    mocks.listChunks.mockReset();
    vi.mocked(log.warn).mockClear();
});

describe('pin flag round trip', () => {
    it('starts empty, pins, reports pinned, unpins', () => {
        expect(getPinnedHashes(KEY)).toEqual([]);
        expect(setEventPinned(KEY, 123, true)).toBe(true);
        expect(isEventPinned(KEY, 123)).toBe(true);
        expect(isEventPinned(KEY, '123')).toBe(true);   // string/number tolerant
        expect(setEventPinned(KEY, 123, false)).toBe(true);
        expect(isEventPinned(KEY, 123)).toBe(false);
        expect(getPinnedHashes(KEY)).toEqual([]);
    });

    it('is idempotent and reports no change', () => {
        setEventPinned(KEY, 1, true);
        expect(setEventPinned(KEY, 1, true)).toBe(false);
        expect(setEventPinned(KEY, 2, false)).toBe(false);
        expect(getPinnedHashes(KEY)).toEqual([1]);
    });

    it('is per-collection and keeps other metadata', () => {
        mocks.meta[KEY] = { enabled: false };
        setEventsPinned(KEY, [1, 2], true);
        setEventPinned('qdrant:other', 9, true);
        expect(getPinnedHashes(KEY)).toEqual([1, 2]);
        expect(getPinnedHashes('qdrant:other')).toEqual([9]);
        expect(mocks.meta[KEY].enabled).toBe(false);
    });
});

describe('resolveCoreFactsMax', () => {
    it('defaults to 8, clamps to 0..30', () => {
        expect(resolveCoreFactsMax({})).toBe(8);
        expect(resolveCoreFactsMax({ eventbase_core_facts_max: 0 })).toBe(0);
        expect(resolveCoreFactsMax({ eventbase_core_facts_max: 99 })).toBe(30);
        expect(resolveCoreFactsMax({ eventbase_core_facts_max: -4 })).toBe(0);
        expect(resolveCoreFactsMax({ eventbase_core_facts_max: 'x' })).toBe(8);
    });
});

describe('selectCoreFacts — cap and order', () => {
    it('keeps highest importance first, then most recent', () => {
        const events = [
            ev('a', { importance: 5, source_window_end: 90 }),
            ev('b', { importance: 9, source_window_end: 10 }),
            ev('c', { importance: 9, source_window_end: 50 }),
            ev('d', { importance: 7, source_window_end: 70 }),
        ];
        const { selected, skipped } = selectCoreFacts(events, 3);
        expect(selected.map(e => e.event_id)).toEqual(['c', 'b', 'd']);
        expect(skipped.map(e => e.event_id)).toEqual(['a']);
    });

    it('max 0 selects nothing', () => {
        expect(selectCoreFacts([ev('a')], 0).selected).toEqual([]);
    });
});

describe('dedupeAgainstCoreFacts', () => {
    it('drops retrieved events already pinned (by event_id or hash)', () => {
        const core = [ev('a', { _hash: 1 }), { ...ev('zz'), _hash: 7 }];
        const retrieved = [ev('a'), ev('b', { _hash: 7 }), ev('c')];
        expect(dedupeAgainstCoreFacts(retrieved, core).map(e => e.event_id)).toEqual(['c']);
    });

    it('returns the retrieved array unchanged with no core facts', () => {
        const retrieved = [ev('a')];
        expect(dedupeAgainstCoreFacts(retrieved, [])).toBe(retrieved);
    });
});

describe('fetchCoreFacts', () => {
    it('makes no backend call when nothing is pinned', async () => {
        const out = await fetchCoreFacts(COL, {});
        expect(out.events).toEqual([]);
        expect(mocks.listChunks).not.toHaveBeenCalled();
    });

    it('returns only pinned eventbase events, honouring the cap and logging skipped', async () => {
        setEventsPinned(KEY, [1, 2, 3], true);
        mocks.listChunks.mockResolvedValue({ items: [
            item(1, ev('e1', { importance: 9 })),
            item(2, ev('e2', { importance: 6 })),
            item(3, ev('e3', { importance: 8 })),
            item(4, ev('e4', { importance: 10 })),                 // not pinned
            item(5, { event_id: 'chunk', importance: 10 }),        // not eventbase
        ] });
        const out = await fetchCoreFacts(COL, { eventbase_core_facts_max: 2 });
        expect(out.events.map(e => e.event_id)).toEqual(['e1', 'e3']);
        expect(out.events[0]._hash).toBe(1);
        expect(out.skipped.map(e => e.event_id)).toEqual(['e2']);
        expect(log.lifecycle).toHaveBeenCalledWith(expect.stringContaining('e2'));
    });

    it('is off when the cap is 0', async () => {
        setEventPinned(KEY, 1, true);
        const out = await fetchCoreFacts(COL, { eventbase_core_facts_max: 0 });
        expect(out.events).toEqual([]);
        expect(mocks.listChunks).not.toHaveBeenCalled();
    });

    it('degrades gracefully when the backend listing fails', async () => {
        setEventPinned(KEY, 1, true);
        mocks.listChunks.mockRejectedValue(new Error('plugin down'));
        await expect(fetchCoreFacts(COL, {})).resolves.toEqual({ events: [], skipped: [] });
        expect(log.warn).toHaveBeenCalled();
    });
});

describe('core facts cache', () => {
    const listing = () => ({ items: [item(1, ev('e1')), item(2, ev('e2'))] });

    it('lists the collection once, then serves repeat generations from memory', async () => {
        setEventsPinned(KEY, [1], true);
        mocks.listChunks.mockResolvedValue(listing());
        const first = await fetchCoreFacts(COL, {});
        const second = await fetchCoreFacts(COL, {});
        expect(mocks.listChunks).toHaveBeenCalledTimes(1);
        expect(second.events.map(e => e.event_id)).toEqual(first.events.map(e => e.event_id));
    });

    it('reloads when the pinned set changes (pin and unpin)', async () => {
        setEventsPinned(KEY, [1], true);
        mocks.listChunks.mockResolvedValue(listing());
        await fetchCoreFacts(COL, {});
        setEventsPinned(KEY, [2], true);
        const out = await fetchCoreFacts(COL, {});
        expect(mocks.listChunks).toHaveBeenCalledTimes(2);
        expect(out.events.map(e => e.event_id).sort()).toEqual(['e1', 'e2']);
        setEventsPinned(KEY, [1, 2], false);
        expect((await fetchCoreFacts(COL, {})).events).toEqual([]);
    });

    it('reloads after invalidateCoreFactsCache() (insert/edit/delete/purge hook)', async () => {
        setEventsPinned(KEY, [1], true);
        mocks.listChunks.mockResolvedValue(listing());
        await fetchCoreFacts(COL, {});
        mocks.listChunks.mockResolvedValue({ items: [item(1, ev('e1', { importance: 9 }))] });
        invalidateCoreFactsCache();
        const out = await fetchCoreFacts(COL, {});
        expect(mocks.listChunks).toHaveBeenCalledTimes(2);
        expect(out.events[0].importance).toBe(9);
    });

    it('does not cache a failed listing, so the next turn retries', async () => {
        setEventsPinned(KEY, [1], true);
        mocks.listChunks.mockRejectedValueOnce(new Error('store down'));
        expect((await fetchCoreFacts(COL, {})).events).toEqual([]);
        mocks.listChunks.mockResolvedValue(listing());
        expect((await fetchCoreFacts(COL, {})).events.map(e => e.event_id)).toEqual(['e1']);
        expect(mocks.listChunks).toHaveBeenCalledTimes(2);
    });

    it('applies the cap per call, not per cache entry', async () => {
        setEventsPinned(KEY, [1, 2], true);
        mocks.listChunks.mockResolvedValue({ items: [item(1, ev('e1', { importance: 9 })), item(2, ev('e2', { importance: 5 }))] });
        expect((await fetchCoreFacts(COL, { eventbase_core_facts_max: 1 })).events.map(e => e.event_id)).toEqual(['e1']);
        expect((await fetchCoreFacts(COL, { eventbase_core_facts_max: 2 })).events).toHaveLength(2);
        expect(mocks.listChunks).toHaveBeenCalledTimes(1);
    });

    it('expires after the TTL and ignores hash order in the signature', () => {
        const sig = pinSignature([2, 1]);
        expect(sig).toBe(pinSignature(['1', '2']));
        setCachedCoreFacts('k', sig, [{ a: 1 }], 1000);
        expect(getCachedCoreFacts('k', sig, 1000 + CORE_FACTS_CACHE_TTL_MS)).toEqual([{ a: 1 }]);
        expect(getCachedCoreFacts('k', sig, 1000 + CORE_FACTS_CACHE_TTL_MS + 1)).toBeNull();
        expect(getCachedCoreFacts('k', pinSignature([1]), 1000)).toBeNull();
    });
});

describe('Core facts injection block', () => {
    const settings = { eventbase_injection_format: 'densetext' };

    it('is clearly labelled and uses the shared per-event format', () => {
        const { text, includedCount } = formatCoreFactsBlock([ev('a')], settings);
        expect(includedCount).toBe(1);
        expect(text.startsWith('Core facts — always true')).toBe(true);
        expect(text).toContain('# Event 1');
        expect(text).toContain('summary: summary_a');
    });

    it.each(['densetext', 'summaryonly', 'jsonarray'])('never carries relative-time labels (%s), even with the setting on', (format) => {
        const dated = (id, DateTime) => ({ ...ev(id), DateTime });
        const { text } = formatCoreFactsBlock(
            [dated('a', '2026-03-01T09:00:00Z'), dated('b', '2026-03-28T09:00:00Z')],
            { eventbase_injection_format: format, eventbase_relative_time: true },
        );
        expect(text).not.toMatch(/earlier|time_ago|same day/);
    });

    it('follows the jsonarray format setting', () => {
        const { text } = formatCoreFactsBlock([ev('a')], { eventbase_injection_format: 'jsonarray' });
        expect(text).toContain('"summary": "summary_a"');
    });

    it('is placed ahead of the retrieved block, each event appearing once', () => {
        const pinned = ev('p', { text: '[fact] pinned_one', _hash: 1 });
        const retrieved = dedupeAgainstCoreFacts(
            [ev('p', { text: '[fact] pinned_one' }), ev('r', { text: '[fact] retrieved_one' })], [pinned]);
        const retrievedText = formatEventsForInjectionDetailed(retrieved, settings).text;
        const { text, coreCount } = combineWithCoreFacts([pinned], retrievedText, settings);
        expect(coreCount).toBe(1);
        expect(text.indexOf('Core facts')).toBe(0);
        expect(text.indexOf('pinned_one')).toBeLessThan(text.indexOf('retrieved_one'));
        expect(text.split('pinned_one').length - 1).toBe(1);
    });

    it('works with no retrieved events (core only)', () => {
        const { text } = combineWithCoreFacts([ev('p')], '', settings);
        expect(text.startsWith('Core facts')).toBe(true);
        expect(text.endsWith('\n')).toBe(false);
    });

    it('leaves the retrieved text byte-for-byte unchanged when nothing is pinned', () => {
        const retrievedText = formatEventsForInjectionDetailed([ev('r')], settings).text;
        expect(combineWithCoreFacts([], retrievedText, settings)).toEqual({ text: retrievedText, coreCount: 0 });
        expect(combineWithCoreFacts(undefined, retrievedText, settings).text).toBe(retrievedText);
    });
});

describe('auto-pin selection', () => {
    it('picks only importance >= 8 AND should_persist === true', () => {
        const events = [
            ev('a', { importance: 8, should_persist: true }),
            ev('b', { importance: 9, should_persist: false }),
            ev('c', { importance: 7, should_persist: true }),
            ev('d', { importance: 10, should_persist: true }),
            ev('e', { importance: 10 }),
        ];
        expect(pickAutoPinHashes(events, [11, 12, 13, 14, 15])).toEqual([11, 14]);
    });
});
