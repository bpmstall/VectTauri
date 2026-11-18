/**
 * ============================================================================
 * CORE FACTS CACHE
 * ============================================================================
 * Memory-only cache of the pinned events loaded for each collection, so a
 * generation does not re-list the whole collection (up to 50000 chunks, read one
 * by one from the built-in store) just to fetch a handful of pinned events.
 *
 * An entry is valid only while the pinned-hash set is unchanged (the signature),
 * so pinning/unpinning invalidates by itself. Anything that can change the CONTENT
 * of a stored event (insert, edit, delete, purge) calls invalidateCoreFactsCache();
 * a TTL bounds staleness for mutations that bypass those paths (import, direct
 * store edits). No imports, so any module can call it without creating a cycle.
 * ============================================================================
 */

/** Upper bound on staleness for changes that do not go through an invalidation hook. */
export const CORE_FACTS_CACHE_TTL_MS = 5 * 60 * 1000;

/** @type {Map<string, { sig: string, ts: number, items: object[] }>} */
const _cache = new Map();

/**
 * @param {(number|string)[]} hashes
 * @returns {string} order-independent signature of a pinned-hash set
 */
export function pinSignature(hashes) {
    return [...(hashes || [])].map(String).sort().join(',');
}

/**
 * @param {string} registryKey
 * @param {string} sig - pinSignature of the CURRENT pinned set
 * @param {number} [now]
 * @returns {object[]|null} cached loaded items, or null on miss / stale / changed pin set
 */
export function getCachedCoreFacts(registryKey, sig, now = Date.now()) {
    const hit = _cache.get(registryKey);
    if (!hit || hit.sig !== sig || now - hit.ts > CORE_FACTS_CACHE_TTL_MS) return null;
    return hit.items;
}

/**
 * @param {string} registryKey
 * @param {string} sig
 * @param {object[]} items - loaded pinned items for this collection
 * @param {number} [now]
 */
export function setCachedCoreFacts(registryKey, sig, items, now = Date.now()) {
    _cache.set(registryKey, { sig, ts: now, items });
}

/** Drop every cached entry. Cheap, and always safe: the next read reloads. */
export function invalidateCoreFactsCache() {
    _cache.clear();
}
