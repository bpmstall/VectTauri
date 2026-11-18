/**
 * ============================================================================
 * EVENTBASE INJECTION
 * ============================================================================
 * Formats retrieved EventRecord objects into a prompt block for injection.
 * No hard character budget is enforced — Top-K and retrieval filters control
 * payload size.
 * ============================================================================
 */

import { storyNowForBlock, relativeStoryTimeLabel } from './story-time.js';

// ---------------------------------------------------------------------------
// Relative story time
// ---------------------------------------------------------------------------

/**
 * Per-event relative-time labels ("3 days earlier"), measured against the newest
 * parseable DateTime in the block (needs 2+ dated events). Returns all-empty labels (output unchanged)
 * when the setting is off, when the block mixes conversation frames (archive /
 * cross-chat timelines are not comparable), or when no DateTime parses.
 * @param {object[]} events
 * @param {object} [settings]
 * @returns {string[]} one label per event ('' = none)
 */
function _relativeTimeLabels(events, settings) {
    const none = events.map(() => '');
    if (settings?.eventbase_relative_time === false) return none;
    if (new Set(events.map(e => e._sortFrame ?? '__default__')).size > 1) return none;
    const now = storyNowForBlock(events.map(e => e.DateTime));
    if (now === null) return none;
    return events.map(e => relativeStoryTimeLabel(e.DateTime, now));
}

// ---------------------------------------------------------------------------
// JSON format
// ---------------------------------------------------------------------------

/**
 * Extract the summary line from an event's stored embed text.
 * The text is built by buildEmbedText() and starts with "[event_type] summary"
 * on its first line. Strips the bracketed event_type prefix.
 * @param {string} text
 * @returns {string}
 */
function _summaryFromText(text) {
    if (!text) return '';
    const firstLine = String(text).split('\n')[0];
    const match = firstLine.match(/^\[[^\]]+\]\s*(.*)$/);
    return match ? match[1] : firstLine;
}

/**
 * Strip internal scoring/ingestion fields that should not be injected.
 * Returns only the canonical EventRecord fields.
 * @param {object} event
 * @returns {object}
 */
function _cleanEventForInjection(event, timeAgo = '') {
    return {
        event_type: event.event_type,
        // Relative retrieval-relevance rank within this injected batch (1 = closest
        // match to the current moment). Stamped from score order before the
        // chronological re-sort. A rank, NOT the raw score — the raw _finalScore is
        // uncalibrated and its scale shifts across backends, so it would mislead.
        context_relevance_rank: event._contextRelevanceRank != null
            ? `${event._contextRelevanceRank} of ${event._contextRelevanceTotal}`
            : null,
        importance: event.importance,
        message_order: event.source_window_end ?? null,
        summary: _summaryFromText(event.text),
        DateTime: event.DateTime || null,
        scene_time: event.scene_time || '',
        ...(timeAgo ? { time_ago: timeAgo } : {}),
        cause: event.cause || '',
        result: event.result || '',
        characters: event.characters || [],
        locations: event.locations || [],
        factions: event.factions || [],
        items: event.items || [],
        concepts: event.concepts || [],
        keywords: event.keywords || [],
        open_threads: event.open_threads || [],
        should_persist: event.should_persist === true,
    };
}

/**
 * Format events as a JSON array string (canonical format).
 * @param {object[]} events
 * @returns {string}
 */
function _formatAsJson(events, labels = []) {
    return JSON.stringify(events.map((e, i) => _cleanEventForInjection(e, labels?.[i])), null, 2);
}

// ---------------------------------------------------------------------------
// Dense text format
// ---------------------------------------------------------------------------

/**
 * @param {unknown} value
 * @returns {string}
 */
function _stringifyList(value) {
    if (!Array.isArray(value) || value.length === 0) return '-';
    return value.map(v => String(v)).join(', ');
}

/**
 * Format events as compact dense text blocks.
 * @param {object[]} events
 * @returns {string}
 */
function _formatAsDenseText(events, labels = []) {
    return events.map((rawEvent, idx) => {
        const event = _cleanEventForInjection(rawEvent);
        return [
            `# Event ${idx + 1}`,
            `context_relevance_rank: ${event.context_relevance_rank || '-'}`,
            `event_type: ${event.event_type || '-'}`,
            `importance: ${event.importance ?? '-'}`,
            `message_order: ${event.message_order ?? '-'}`,
            `summary: ${event.summary || '-'}`,
            `DateTime: ${event.DateTime || '-'}${labels?.[idx] && event.DateTime ? ` (${labels?.[idx]})` : ''}`,
            `scene_time: ${event.scene_time || '-'}`,
            `cause: ${event.cause || '-'}`,
            `result: ${event.result || '-'}`,
            `characters: ${_stringifyList(event.characters)}`,
            `locations: ${_stringifyList(event.locations)}`,
            `factions: ${_stringifyList(event.factions)}`,
            `items: ${_stringifyList(event.items)}`,
            `concepts: ${_stringifyList(event.concepts)}`,
            `keywords: ${_stringifyList(event.keywords)}`,
            `open_threads: ${_stringifyList(event.open_threads)}`,
            `should_persist: ${event.should_persist ? 'true' : 'false'}`,
        ].join('\n');
    }).join('\n\n');
}

/**
 * Format events as summary + DateTime only — minimal prompt footprint.
 * @param {object[]} events
 * @returns {string}
 */
function _formatAsSummaryOnly(events, labels = []) {
    return events.map((rawEvent, idx) => {
        const event = _cleanEventForInjection(rawEvent);
        return [
            `# Event ${idx + 1}`,
            `context_relevance_rank: ${event.context_relevance_rank || '-'}`,
            `message_order: ${event.message_order ?? '-'}`,
            `summary: ${event.summary || '-'}`,
            `DateTime: ${event.DateTime || '-'}${labels?.[idx] && event.DateTime ? ` (${labels?.[idx]})` : ''}`,
            `scene_time: ${event.scene_time || '-'}`,
        ].join('\n');
    }).join('\n\n');
}

// ---------------------------------------------------------------------------
// Presentation order
// ---------------------------------------------------------------------------

/**
 * One-line instruction prepended to every injected block so the model knows the
 * events are in chronological order and which field encodes it. A silent
 * re-order only half-helps; naming the ordering makes it usable.
 */
const INJECTION_HEADER =
    'Past events, ordered oldest → newest by message_order (position in the conversation). '
    + "Use each event's DateTime/scene_time to place it on the story timeline. "
    + 'context_relevance_rank shows how closely each event matches the current moment '
    + '(1 = closest match) — this is retrieval relevance, NOT story importance '
    + '(see the separate importance field for how significant the event is).';

/** Appended to the header only when at least one event carries a relative label. */
const RELATIVE_TIME_NOTE =
    'time_ago / "(… earlier)" is measured against the latest dated event in this block, '
    + 'not against real-world time.';

/**
 * Re-order retrieved events for presentation: chronological, oldest → newest.
 * Relevance (retrieval score) decides WHICH events are included upstream; this
 * only decides DISPLAY order — no events are added or dropped.
 *
 * Sort key is `source_window_end` (message_order): ingestion-stamped,
 * deterministic, monotonic within a conversation. NOT the LLM-extracted
 * `DateTime`, which is nullable and can mis-parse — a bad parse would teleport
 * an event across the timeline. DateTime/scene_time still print per event as
 * labels the model can read.
 *
 * Cross-frame safety: `source_window_end` is a message index within ONE
 * conversation, so it is meaningless across collections (archive chats,
 * cross-chat locks). Events are grouped by their source frame (`_sortFrame`,
 * stamped at query time) and only sorted within a frame. Frames are then ordered
 * by their most-recent `real_world_date` (wall-clock send time, comparable
 * across conversations) so the actively-played chat lands last and older
 * archives first. Frames with no real-world anchor sort first.
 *
 * Array#sort is stable, so ties (same window, or a frame with no anchor) retain
 * the incoming relevance order as a sensible tie-break.
 *
 * @param {object[]} events
 * @returns {object[]} new array, same members, presentation order
 */
function _orderEventsForPresentation(events) {
    const byWindow = (a, b) => {
        const av = typeof a.source_window_end === 'number' ? a.source_window_end : Infinity;
        const bv = typeof b.source_window_end === 'number' ? b.source_window_end : Infinity;
        return av - bv;
    };

    // Fast path: a single (or absent) frame — no cross-conversation risk.
    const frames = new Set(events.map(e => e._sortFrame ?? '__default__'));
    if (frames.size <= 1) {
        return [...events].sort(byWindow);
    }

    const groups = new Map();
    for (const e of events) {
        const key = e._sortFrame ?? '__default__';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(e);
    }

    // A frame's timeline position = the newest real-world send time it contains.
    // No anchor anywhere in the frame → -Infinity → sorts first (unknown/oldest).
    const frameAnchor = (list) => {
        let max = -Infinity;
        for (const e of list) {
            const t = e.real_world_date ? Date.parse(e.real_world_date) : NaN;
            if (!Number.isNaN(t) && t > max) max = t;
        }
        return max;
    };

    return [...groups.values()]
        .map(list => ({ list: [...list].sort(byWindow), anchor: frameAnchor(list) }))
        .sort((a, b) => a.anchor - b.anchor)
        .flatMap(g => g.list);
}

// ---------------------------------------------------------------------------
// Main formatter
// ---------------------------------------------------------------------------

/**
 * Format retrieved events into a prompt injection string.
 * No hard cap is applied here; Top-K and retrieval filters control payload size.
 * Events are re-ordered chronologically for presentation before formatting.
 *
 * @param {object[]} events   - Re-ranked EventRecord objects (highest score first)
 * @param {object}   settings - VectTauri settings
 * @returns {string}          - Formatted string ready for injection (empty string if nothing fits)
 */
export function formatEventsForInjectionDetailed(events, _settings) {
    if (!events?.length) {
        return { text: '', includedCount: 0, requestedCount: 0 };
    }

    // Events arrive in score-descending (relevance) order. Capture that as an
    // explicit rank BEFORE the chronological re-sort scrambles position, so the
    // model can still tell which recalled memory best matches the current moment.
    const total = events.length;
    const ranked = events.map((e, i) => ({ ...e, _contextRelevanceRank: i + 1, _contextRelevanceTotal: total }));

    const ordered = _orderEventsForPresentation(ranked);

    const format = String(_settings?.eventbase_injection_format || 'densetext').toLowerCase();
    const labels = _relativeTimeLabels(ordered, _settings);
    const body = format === 'densetext'
        ? _formatAsDenseText(ordered, labels)
        : format === 'summaryonly'
            ? _formatAsSummaryOnly(ordered, labels)
            : _formatAsJson(ordered, labels);
    const header = labels.some(Boolean) ? `${INJECTION_HEADER} ${RELATIVE_TIME_NOTE}` : INJECTION_HEADER;

    return {
        text: `${header}\n${body}`,
        includedCount: ordered.length,
        requestedCount: events.length,
    };
}

// ---------------------------------------------------------------------------
// Core facts block (pinned events)
// ---------------------------------------------------------------------------

/**
 * Header for the pinned block. Stronger than INJECTION_HEADER on purpose: these
 * are premises the user marked as permanently true, not recalled memories.
 */
const CORE_FACTS_HEADER =
    'Core facts — always true. The user pinned these events as established premises of the story; '
    + 'they hold regardless of the current scene and must never be contradicted. '
    + 'Ordered oldest → newest by message_order.';

/**
 * Format pinned events as a standalone "Core facts" block, using the same
 * per-event formatters as retrieved events (so densetext/jsonarray/summaryonly
 * stay consistent). Pinned events are not ranked by retrieval, so the
 * relevance-rank field is left empty. Not part of Top-K.
 *
 * @param {object[]} events   - pinned EventRecord objects
 * @param {object}   settings - VectTauri settings (eventbase_injection_format)
 * @returns {{ text: string, includedCount: number }}
 */
export function formatCoreFactsBlock(events, settings) {
    if (!events?.length) return { text: '', includedCount: 0 };

    const ordered = _orderEventsForPresentation(events);
    const format = String(settings?.eventbase_injection_format || 'densetext').toLowerCase();
    const body = format === 'densetext'
        ? _formatAsDenseText(ordered)
        : format === 'summaryonly'
            ? _formatAsSummaryOnly(ordered)
            : _formatAsJson(ordered);

    return { text: `${CORE_FACTS_HEADER}\n${body}`, includedCount: ordered.length };
}

