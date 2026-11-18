/**
 * Tests for core/story-time.js (pure relative-time helper) and the relative-time
 * hint in formatEventsForInjectionDetailed() (core/eventbase-injection.js).
 */

import { describe, it, expect } from 'vitest';
import { parseStoryTime, latestStoryTime, storyNowForBlock, relativeStoryTimeLabel } from '../core/story-time.js';
import { formatEventsForInjectionDetailed } from '../core/eventbase-injection.js';

const NOW = Date.parse('2026-03-31T12:00:00.000Z');
const label = (iso, now = NOW) => relativeStoryTimeLabel(iso, now);

describe('parseStoryTime / latestStoryTime', () => {
    it('parses ISO strings and rejects everything else', () => {
        expect(parseStoryTime('2026-03-31T12:00:00.000Z')).toBe(NOW);
        for (const bad of [null, undefined, '', '   ', 'Tuesday evening', 'not-a-date', 42, {}, []]) {
            expect(parseStoryTime(bad)).toBeNull();
        }
    });

    it('picks the newest parseable value, ignoring junk', () => {
        const a = '2026-03-01T00:00:00.000Z';
        const b = '2026-03-20T00:00:00.000Z';
        expect(latestStoryTime([a, null, 'garbage', b, ''])).toBe(Date.parse(b));
        expect(latestStoryTime([null, 'x'])).toBeNull();
        expect(latestStoryTime([])).toBeNull();
        expect(latestStoryTime(undefined)).toBeNull();
    });
});

describe('storyNowForBlock', () => {
    it('needs at least two parseable dates', () => {
        expect(storyNowForBlock(['2026-03-01T00:00:00.000Z', null, 'x'])).toBeNull();
        expect(storyNowForBlock(['2026-03-01T00:00:00.000Z', '2026-03-05T00:00:00.000Z']))
            .toBe(Date.parse('2026-03-05T00:00:00.000Z'));
    });
});

describe('relativeStoryTimeLabel buckets', () => {
    it('same day, including different times of one UTC day', () => {
        expect(label('2026-03-31T00:00:00.000Z')).toBe('same day');
        expect(label('2026-03-31T12:00:00.000Z')).toBe('same day');
    });

    it('days: 1 and 6', () => {
        expect(label('2026-03-30T23:00:00.000Z')).toBe('1 day earlier');
        expect(label('2026-03-25T12:00:00.000Z')).toBe('6 days earlier');
    });

    it('7 days switches to weeks', () => {
        expect(label('2026-03-24T12:00:00.000Z')).toBe('1 week earlier');
        expect(label('2026-03-17T12:00:00.000Z')).toBe('2 weeks earlier');
        expect(label('2026-03-03T12:00:00.000Z')).toBe('4 weeks earlier'); // 28d
        expect(label('2026-03-02T12:00:00.000Z')).toBe('4 weeks earlier'); // 29d
    });

    it('30/31 days switch to months', () => {
        expect(label('2026-03-01T12:00:00.000Z')).toBe('1 month earlier');  // 30d
        expect(label('2026-02-28T12:00:00.000Z')).toBe('1 month earlier');  // 31d
        expect(label('2025-12-31T12:00:00.000Z')).toBe('2 months earlier'); // 90d
        expect(label('2025-04-01T12:00:00.000Z')).toBe('11 months earlier'); // 364d
    });

    it('365 days switches to years', () => {
        expect(label('2025-03-31T12:00:00.000Z')).toBe('1 year earlier');
        expect(label('2024-03-31T12:00:00.000Z')).toBe('2 years earlier');
    });

    it('future-dated events get no label', () => {
        expect(label('2026-04-01T00:00:00.000Z')).toBe('');
    });

    it('invalid input gets no label', () => {
        expect(label('Tuesday evening')).toBe('');
        expect(label(null)).toBe('');
        expect(label('2026-03-30T00:00:00Z', null)).toBe('');
        expect(label('2026-03-30T00:00:00Z', NaN)).toBe('');
        expect(relativeStoryTimeLabel('2026-03-30T00:00:00Z', undefined)).toBe('');
    });

    it('works for fictional years and clamps absurd spans', () => {
        const now = Date.parse('1577-06-10T08:00:00.000Z');
        expect(relativeStoryTimeLabel('1577-06-07T08:00:00.000Z', now)).toBe('3 days earlier');
        expect(relativeStoryTimeLabel('1576-06-10T08:00:00.000Z', now)).toBe('1 year earlier');
        expect(relativeStoryTimeLabel('0100-01-01T00:00:00.000Z', now)).toBe('over 1000 years earlier');
    });

    it('is timezone-agnostic: offsets are normalized to UTC days', () => {
        // 2026-03-31T01:00+05:00 is 2026-03-30T20:00Z → 1 UTC day before NOW.
        expect(label('2026-03-31T01:00:00+05:00')).toBe('1 day earlier');
    });
});

// ---------------------------------------------------------------------------
// Injection
// ---------------------------------------------------------------------------

const ev = (o) => ({
    event_type: 'plot',
    importance: 5,
    text: `[plot] ${o.summary}`,
    characters: [], locations: [], factions: [], items: [],
    concepts: [], keywords: [], open_threads: [],
    ...o,
});

const events = () => [
    ev({ summary: 'arrival', source_window_end: 10, DateTime: '2026-03-28T09:00:00.000Z' }),
    ev({ summary: 'dinner', source_window_end: 20, DateTime: '2026-03-31T19:00:00.000Z', scene_time: 'Evening' }),
    ev({ summary: 'undated', source_window_end: 30, DateTime: null, scene_time: 'Some time later' }),
];

describe('relative time in injection', () => {
    it('densetext: appends the label to DateTime and extends the header', () => {
        const { text } = formatEventsForInjectionDetailed(events(), { eventbase_injection_format: 'densetext' });
        expect(text).toContain('DateTime: 2026-03-28T09:00:00.000Z (3 days earlier)');
        expect(text).toContain('DateTime: 2026-03-31T19:00:00.000Z (same day)');
        expect(text).toContain('DateTime: -\nscene_time: Some time later'); // untouched
        expect(text.split('\n')[0]).toContain('measured against the latest dated event');
    });

    it('jsonarray: adds time_ago only for events that have a label', () => {
        const { text } = formatEventsForInjectionDetailed(events(), { eventbase_injection_format: 'jsonarray' });
        const arr = JSON.parse(text.split('\n').slice(1).join('\n'));
        expect(arr.map(e => e.time_ago)).toEqual(['3 days earlier', 'same day', undefined]);
        const keys = Object.keys(arr[0]);
        expect(keys.indexOf('time_ago')).toBe(keys.indexOf('scene_time') + 1);
    });

    it('summaryonly: appends the label too', () => {
        const { text } = formatEventsForInjectionDetailed(events(), { eventbase_injection_format: 'summaryonly' });
        expect(text).toContain('(3 days earlier)');
    });

    for (const format of ['densetext', 'jsonarray', 'summaryonly']) {
        it(`${format}: setting off emits no relative hints anywhere`, () => {
            const off = formatEventsForInjectionDetailed(events(), { eventbase_injection_format: format, eventbase_relative_time: false }).text;
            expect(off).not.toContain('earlier');
            expect(off).not.toContain('time_ago');
            expect(off).not.toContain('measured against');
            const on = formatEventsForInjectionDetailed(events(), { eventbase_injection_format: format }).text;
            expect(on).not.toBe(off);
        });

        it(`${format}: on-output equals off-output when no event has a parseable DateTime`, () => {
            const evs = [ev({ summary: 'a', source_window_end: 1, scene_time: 'Monday' }), ev({ summary: 'b', source_window_end: 2 })];
            const on = formatEventsForInjectionDetailed(evs, { eventbase_injection_format: format }).text;
            const off = formatEventsForInjectionDetailed(evs, { eventbase_injection_format: format, eventbase_relative_time: false }).text;
            expect(on).toBe(off);
        });
    }

    it('mixed conversation frames get no labels (timelines not comparable)', () => {
        const evs = [
            ev({ summary: 'old', source_window_end: 1, DateTime: '2020-01-01T00:00:00.000Z', _sortFrame: 'archive' }),
            ev({ summary: 'new', source_window_end: 1, DateTime: '2026-03-31T00:00:00.000Z', _sortFrame: 'live' }),
        ];
        const { text } = formatEventsForInjectionDetailed(evs, { eventbase_injection_format: 'densetext' });
        expect(text).not.toContain('earlier');
    });
});
