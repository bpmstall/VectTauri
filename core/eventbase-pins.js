/**
 * ============================================================================
 * EVENTBASE PINS (CORE FACTS — FLAG, SELECTION)
 * ============================================================================
 * Pinned EventBase events that are ALWAYS injected, whatever the current scene
 * is about. A premise told once in chat ("the player only arrived on Earth this
 * week") is outranked in vector retrieval by similar-looking events, so later
 * scenes contradict it; pinning takes that fact out of the ranking contest.
 *
 * STORAGE: the pin flag is a per-collection set of event hashes in the
 * collection-metadata store (`pinnedEventHashes`, keyed by registry key), NOT a
 * field on the vector payload. Updating payload metadata in place needs the
 * Similharity plugin's PATCH route (Standard backend without the plugin cannot
 * do it at all) and its merge semantics are server-side; the metadata store
 * works identically on every backend, needs no network call, and cannot
 * trigger a re-embed. Trade-off: the pin lives in the browser's extension
 * settings, so it does not travel with an exported collection.
 *
 * Deliberately free of backend imports so eventbase-store.js (auto-pin at insert)
 * can use it; loading + injection live in eventbase-core-facts.js.
 * ============================================================================
 */

import { getCollectionMeta, setCollectionMeta } from './collection-metadata.js';

/** Setting bounds for `eventbase_core_facts_max` (0 = off). */
export const CORE_FACTS_MAX_DEFAULT = 8;
export const CORE_FACTS_MAX_LIMIT = 30;

/**
 * Resolve the per-turn cap from settings. 0 disables the feature.
 * @param {object} [settings]
 * @returns {number}
 */
export function resolveCoreFactsMax(settings) {
    const raw = settings?.eventbase_core_facts_max;
    const n = raw === undefined || raw === null || raw === '' ? CORE_FACTS_MAX_DEFAULT : Number(raw);
    if (!Number.isFinite(n)) return CORE_FACTS_MAX_DEFAULT;
    return Math.max(0, Math.min(CORE_FACTS_MAX_LIMIT, Math.floor(n)));
}

// ---------------------------------------------------------------------------
// Pin flag (collection-metadata store)
// ---------------------------------------------------------------------------

/**
 * @param {string} registryKey - "backend:collectionId"
 * @returns {number[]} pinned event hashes (empty when none)
 */
export function getPinnedHashes(registryKey) {
    if (!registryKey) return [];
    const list = getCollectionMeta(registryKey)?.pinnedEventHashes;
    return Array.isArray(list) ? list : [];
}

/**
 * @param {string} registryKey
 * @param {number|string} hash
 * @returns {boolean}
 */
export function isEventPinned(registryKey, hash) {
    return getPinnedHashes(registryKey).some(h => String(h) === String(hash));
}

/**
 * Pin or unpin events. Idempotent; writes only when the set actually changes.
 * Hashes are stored as numbers (they are 53-bit integers, JSON-safe).
 * @param {string} registryKey
 * @param {(number|string)[]} hashes
 * @param {boolean} pinned
 * @returns {boolean} true when the stored set changed
 */
export function setEventsPinned(registryKey, hashes, pinned) {
    if (!registryKey || !hashes?.length) return false;
    const set = new Set(getPinnedHashes(registryKey).map(String));
    let changed = false;
    for (const h of hashes) {
        const key = String(h);
        if (pinned && !set.has(key)) { set.add(key); changed = true; }
        else if (!pinned && set.delete(key)) { changed = true; }
    }
    if (!changed) return false;
    setCollectionMeta(registryKey, { pinnedEventHashes: [...set].map(Number) });
    return true;
}

/**
 * Single-event convenience wrapper over setEventsPinned.
 * @returns {boolean} true when the stored set changed
 */
export function setEventPinned(registryKey, hash, pinned) {
    return setEventsPinned(registryKey, [hash], pinned);
}

/** Auto-pin thresholds: only genuinely critical, explicitly persistent events. */
export const AUTO_PIN_MIN_IMPORTANCE = 8;

/**
 * Which hashes of a freshly stored batch qualify for auto-pinning
 * (importance >= 8 AND should_persist === true). `hashes[i]` belongs to `events[i]`.
 * @param {object[]} events
 * @param {(number|string)[]} hashes
 * @returns {(number|string)[]}
 */
export function pickAutoPinHashes(events, hashes) {
    return (events || [])
        .map((e, i) => (e?.should_persist === true && Number(e.importance) >= AUTO_PIN_MIN_IMPORTANCE ? hashes[i] : null))
        .filter(h => h != null);
}

// ---------------------------------------------------------------------------
// Selection (cap + order)
// ---------------------------------------------------------------------------

/**
 * Apply the cap: highest importance first, then most recent (by message order).
 * @param {object[]} events
 * @param {number} max
 * @returns {{ selected: object[], skipped: object[] }}
 */
export function selectCoreFacts(events, max) {
    if (!events?.length) return { selected: [], skipped: [] };
    if (!(max > 0)) return { selected: [], skipped: [...events] };
    const recency = (e) => (typeof e.source_window_end === 'number' ? e.source_window_end : -Infinity);
    const ranked = [...events].sort((a, b) =>
        (Number(b.importance) || 0) - (Number(a.importance) || 0) || recency(b) - recency(a));
    return { selected: ranked.slice(0, max), skipped: ranked.slice(max) };
}

/**
 * Remove from `retrieved` any event already present in `coreFacts`
 * (matched by event_id, falling back to the vector hash).
 * @param {object[]} retrieved
 * @param {object[]} coreFacts
 * @returns {object[]}
 */
export function dedupeAgainstCoreFacts(retrieved, coreFacts) {
    if (!coreFacts?.length || !retrieved?.length) return retrieved || [];
    const ids = new Set();
    const hashes = new Set();
    for (const c of coreFacts) {
        if (c.event_id) ids.add(c.event_id);
        if (c._hash != null) hashes.add(String(c._hash));
    }
    return retrieved.filter(e =>
        !(e.event_id && ids.has(e.event_id)) && !(e._hash != null && hashes.has(String(e._hash))));
}
