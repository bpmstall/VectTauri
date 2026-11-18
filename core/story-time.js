/**
 * ============================================================================
 * STORY TIME
 * ============================================================================
 * Pure helpers that turn an event's in-story DateTime into a short relative
 * label ("3 days earlier") measured against a reference "story now".
 *
 * Never guesses: anything missing, unparseable, or dated AFTER the reference
 * yields no label. All math is UTC calendar-day arithmetic, so fictional
 * years (e.g. 1577) and machine timezones cannot skew the result.
 * ============================================================================
 */

const MS_PER_DAY = 86_400_000;
const DAYS_PER_MONTH = 30.4375;
const DAYS_PER_YEAR = 365;
/** Beyond this many years the exact figure is noise (fictional/garbled dates). */
const MAX_YEARS = 1000;

/**
 * Parse an ISO-ish DateTime into epoch milliseconds.
 * @param {unknown} value
 * @returns {number|null} null when missing or unparseable
 */
export function parseStoryTime(value) {
    if (typeof value !== 'string') return null;
    const s = value.trim();
    if (!s) return null;
    const ms = Date.parse(s);
    return Number.isNaN(ms) ? null : ms;
}

/**
 * Newest parseable DateTime among the given values — the "story now".
 * @param {unknown[]} values
 * @returns {number|null} epoch ms, or null when none parse
 */
export function latestStoryTime(values) {
    let max = null;
    for (const v of values || []) {
        const ms = parseStoryTime(v);
        if (ms !== null && (max === null || ms > max)) max = ms;
    }
    return max;
}

/**
 * Story-now for a block of events: the newest parseable DateTime, but only when
 * at least TWO events carry one — with a single dated event the anchor is the
 * event itself, so every label would be a meaningless "same day".
 * @param {unknown[]} values
 * @returns {number|null}
 */
export function storyNowForBlock(values) {
    const parsed = (values || []).map(parseStoryTime).filter(ms => ms !== null);
    return parsed.length >= 2 ? Math.max(...parsed) : null;
}

/** UTC calendar day index (days since epoch, floored) for an epoch-ms value. */
function _dayIndex(ms) {
    return Math.floor(ms / MS_PER_DAY);
}

/** @param {number} n @param {string} unit */
function _plural(n, unit) {
    return `${n} ${unit}${n === 1 ? '' : 's'} earlier`;
}

/**
 * Relative label for an event DateTime against a reference moment.
 * Buckets: same day, N days (1-6), N weeks (7-29 days), N months (30-364 days),
 * N years (365+ days; "over 1000 years" when absurd).
 *
 * @param {unknown} eventDateTime - event DateTime string
 * @param {number|null} nowMs     - reference story-now (epoch ms) or null
 * @returns {string} label, or '' when it cannot be computed (never a guess)
 */
export function relativeStoryTimeLabel(eventDateTime, nowMs) {
    if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) return '';
    const ms = parseStoryTime(eventDateTime);
    if (ms === null) return '';

    const days = _dayIndex(nowMs) - _dayIndex(ms);
    if (days < 0) return '';            // dated after "now": don't invent a "later"
    if (days === 0) return 'same day';
    if (days < 7) return _plural(days, 'day');
    if (days < 30) return _plural(Math.floor(days / 7), 'week');
    if (days < 365) return _plural(Math.max(1, Math.floor(days / DAYS_PER_MONTH)), 'month');

    const years = Math.max(1, Math.floor(days / DAYS_PER_YEAR));
    if (years >= MAX_YEARS) return `over ${MAX_YEARS} years earlier`;
    return _plural(years, 'year');
}
