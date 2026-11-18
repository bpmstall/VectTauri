/**
 * ============================================================================
 * EVENTBASE CORE FACTS (LOAD + INJECT)
 * ============================================================================
 * Loads the pinned events of a chat's EventBase collection(s) and composes the
 * "Core facts" block that is prepended to the retrieved-events injection. The
 * pin flag itself lives in eventbase-pins.js.
 *
 * Loaded pinned events are cached per collection (core-facts-cache.js), so the
 * collection listing happens once, not every generation.
 *
 * Reads cost nothing when nothing is pinned (the overwhelmingly common case):
 * no backend call is made, so default behaviour is untouched. No embedding call
 * is ever made — pinned events are listed by hash, not searched.
 * ============================================================================
 */

import { getBackendForCollection, getBackend } from '../backends/backend-manager.js';
import { resolveBackendForCollection } from './collection-ids.js';
import { getPinnedHashes, resolveCoreFactsMax, selectCoreFacts } from './eventbase-pins.js';
import { formatCoreFactsBlock } from './eventbase-injection.js';
import { getCachedCoreFacts, setCachedCoreFacts, pinSignature } from './core-facts-cache.js';
import { log } from './log.js';

export { dedupeAgainstCoreFacts } from './eventbase-pins.js';

// ---------------------------------------------------------------------------
// Fetch (no embedding call)
// ---------------------------------------------------------------------------

/**
 * Load the pinned events of the given collections and apply the cap.
 * Uses listChunks (a plain metadata listing — no embedding, no query vector).
 * Collections with nothing pinned are skipped without any backend call. A
 * collection that fails to list is logged and skipped; this never throws.
 *
 * @param {{ collectionId: string, registryKey: string }[]} collections
 * @param {object} settings
 * @returns {Promise<{ events: object[], skipped: object[] }>}
 */
export async function fetchCoreFacts(collections, settings) {
    const max = resolveCoreFactsMax(settings);
    if (max === 0 || !collections?.length) return { events: [], skipped: [] };

    const withPins = collections
        .map(c => ({ ...c, pinned: new Set(getPinnedHashes(c.registryKey).map(String)) }))
        .filter(c => c.pinned.size > 0);
    if (withPins.length === 0) return { events: [], skipped: [] };

    const all = [];
    for (const col of withPins) {
        const sig = pinSignature([...col.pinned]);
        const cached = getCachedCoreFacts(col.registryKey, sig);
        if (cached) {
            all.push(...cached);
            continue;
        }
        try {
            const resolved = resolveBackendForCollection(col.registryKey);
            const backend = resolved.backend
                ? await getBackendForCollection(resolved.backend, settings)
                : await getBackend(settings);
            const result = await backend.listChunks(resolved.collectionId || col.collectionId, settings, { limit: 50000 });
            const items = Array.isArray(result?.items) ? result.items : [];
            const loaded = [];
            for (const it of items) {
                if (!it?.metadata?.eventbase || !col.pinned.has(String(it.hash))) continue;
                loaded.push({ ...it.metadata, text: it.text ?? it.metadata.text, _hash: it.hash, _sortFrame: col.collectionId });
            }
            // Only a successful listing is cached: a failure must be retried next turn.
            setCachedCoreFacts(col.registryKey, sig, loaded);
            all.push(...loaded);
        } catch (err) {
            log.warn(`[EventBase] Core facts: could not load pinned events from ${col.collectionId}:`, err?.message || err);
        }
    }

    const { selected, skipped } = selectCoreFacts(all, max);
    if (skipped.length > 0) {
        log.lifecycle(`[EventBase] Core facts: ${all.length} pinned, cap ${max} — skipped ${skipped.length}: ${skipped.map(e => e.event_id || e._hash).join(', ')}`);
    }
    return { events: selected, skipped };
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/**
 * Prepend the Core facts block to the retrieved-events text. With no core facts
 * the retrieved text is returned untouched (byte-for-byte the old behaviour).
 * @param {object[]} coreEvents
 * @param {string} retrievedText - output of formatEventsForInjectionDetailed ('' if none)
 * @param {object} settings
 * @returns {{ text: string, coreCount: number }}
 */
export function combineWithCoreFacts(coreEvents, retrievedText, settings) {
    if (!coreEvents?.length) return { text: retrievedText, coreCount: 0 };
    const core = formatCoreFactsBlock(coreEvents, settings);
    return {
        text: retrievedText ? `${core.text}\n\n${retrievedText}` : core.text,
        coreCount: core.includedCount,
    };
}
