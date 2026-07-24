import { describe, expect, it } from 'vitest';
import {
  nextOccurrence,
  normalizeSchedule,
  occurrenceInstants,
  ScheduleValidationError,
} from '../../src/scheduled-follow-ups/recurrence.js';

const recurring = (overrides: Partial<Parameters<typeof normalizeSchedule>[0]> = {}) =>
  normalizeSchedule({
    kind: 'recurring',
    dtstartLocal: '2026-01-01T09:00:00',
    timezone: 'America/New_York',
    rrule: 'FREQ=DAILY',
    maxOccurrences: 10,
    ...overrides,
  } as Parameters<typeof normalizeSchedule>[0]);

describe('scheduled follow-up recurrence', () => {
  it('preserves wall clock time and skips spring gaps without consuming', () => {
    const schedule = recurring({ dtstartLocal: '2026-03-07T02:30:00', rrule: 'FREQ=DAILY', maxOccurrences: 3 });
    expect(occurrenceInstants(schedule, 3).map((date) => date.toISOString())).toEqual([
      '2026-03-07T07:30:00.000Z',
      '2026-03-09T06:30:00.000Z',
      '2026-03-10T06:30:00.000Z',
    ]);
  });

  it('uses the earlier offset for an overlap', () => {
    const schedule = recurring({ dtstartLocal: '2026-11-01T01:30:00', maxOccurrences: 1 });
    expect(occurrenceInstants(schedule)[0]!.toISOString()).toBe('2026-11-01T05:30:00.000Z');
  });

  it('handles Lord Howe half-hour DST and inclusive endsAt', () => {
    const schedule = recurring({
      dtstartLocal: '2026-10-03T02:15:00',
      timezone: 'Australia/Lord_Howe',
      maxOccurrences: 3,
      endsAt: '2026-10-05T15:15:00Z',
    });
    expect(occurrenceInstants(schedule, 3).map((date) => date.toISOString())).toEqual([
      '2026-10-02T15:45:00.000Z',
      '2026-10-04T15:15:00.000Z',
      '2026-10-05T15:15:00.000Z',
    ]);
  });

  it('supports leap-day and month-end RRULE semantics', () => {
    const leap = recurring({
      dtstartLocal: '2024-02-29T09:00:00',
      timezone: 'UTC',
      rrule: 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29',
      maxOccurrences: 2,
    });
    expect(occurrenceInstants(leap, 2).map((date) => date.toISOString())).toEqual([
      '2024-02-29T09:00:00.000Z',
      '2028-02-29T09:00:00.000Z',
    ]);
    const monthEnd = recurring({
      dtstartLocal: '2026-01-31T09:00:00',
      timezone: 'UTC',
      rrule: 'FREQ=MONTHLY',
      maxOccurrences: 3,
    });
    expect(occurrenceInstants(monthEnd, 3).map((date) => date.toISOString())).toEqual([
      '2026-01-31T09:00:00.000Z',
      '2026-03-31T09:00:00.000Z',
      '2026-05-31T09:00:00.000Z',
    ]);
  });

  it('rejects embedded bounds and defaults bounded recurrence to ten', () => {
    expect(() => recurring({ rrule: 'FREQ=DAILY;COUNT=2' })).toThrow(ScheduleValidationError);
    const defaulted = normalizeSchedule({
      kind: 'recurring',
      dtstartLocal: '2026-01-01T09:00:00',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY',
    });
    expect((defaulted as { maxOccurrences: number }).maxOccurrences).toBe(10);
  });

  it('rejects minute-level explosive schedules and caps old definitions', () => {
    expect(() => recurring({ rrule: 'FREQ=MINUTELY' })).toThrow(/frequency must be HOURLY/);
    expect(
      nextOccurrence(recurring({ dtstartLocal: '1990-01-01T09:00:00' }), new Date('2060-06-01T00:00:00Z')),
    ).toBeNull();
  });

  it('continues past a daylight-saving gap when finding the next occurrence', () => {
    const schedule = recurring({ dtstartLocal: '2026-03-07T02:30:00', maxOccurrences: 10 });
    expect(nextOccurrence(schedule, new Date('2026-03-07T08:00:00Z'))?.toISOString()).toBe('2026-03-09T06:30:00.000Z');
  });

  it('rejects the negative-month-day hourly denial-of-service rule quickly', () => {
    const started = performance.now();
    expect(() => recurring({ rrule: 'FREQ=HOURLY;BYMONTH=2;BYMONTHDAY=-30' })).toThrow(
      /BYMONTHDAY contains an out-of-range value/,
    );
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('bounds phase-impossible recurrence searches from DTSTART', () => {
    const started = performance.now();
    expect(() =>
      recurring({
        dtstartLocal: '2023-01-01T09:00:00',
        timezone: 'UTC',
        rrule: 'FREQ=YEARLY;INTERVAL=4;BYMONTH=2;BYMONTHDAY=29',
      }),
    ).toThrow(/calendar filters have no occurrence/);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('rejects the exact hourly phase-impossible rule in under a second', () => {
    const started = performance.now();
    expect(() => recurring({ dtstartLocal: '2026-01-01T09:00:00', rrule: 'FREQ=HOURLY;INTERVAL=2;BYHOUR=10' })).toThrow(
      /hourly filters are unreachable/,
    );
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('rejects empty monthly calendar intersections before invoking rrule', () => {
    const started = performance.now();
    expect(() => recurring({ rrule: 'FREQ=MONTHLY;BYMONTHDAY=1;BYDAY=2MO' })).toThrow(
      /calendar filters have no occurrence/,
    );
    expect(() => recurring({ rrule: 'FREQ=MONTHLY;INTERVAL=24;BYMONTHDAY=1;BYDAY=MO' })).toThrow(
      /calendar filters have no occurrence/,
    );
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('rejects incompatible mixed plain and ordinal weekdays before invoking rrule', () => {
    const started = performance.now();
    expect(() => recurring({ rrule: 'FREQ=MONTHLY;BYDAY=MO,1TU' })).toThrow(/calendar filters have no occurrence/);
    expect(() => recurring({ rrule: 'FREQ=YEARLY;BYDAY=MO,1TU' })).toThrow(/calendar filters have no occurrence/);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('preserves reachable ordinal monthly and yearly calendar intersections', () => {
    expect(
      occurrenceInstants(
        recurring({ timezone: 'UTC', rrule: 'FREQ=MONTHLY;BYMONTHDAY=8,9,10,11,12,13,14;BYDAY=2MO' }),
        2,
      ),
    ).toHaveLength(2);
    expect(
      occurrenceInstants(recurring({ timezone: 'UTC', rrule: 'FREQ=YEARLY;BYMONTH=11;BYDAY=4TH' }), 2),
    ).toHaveLength(2);
    expect(occurrenceInstants(recurring({ timezone: 'UTC', rrule: 'FREQ=MONTHLY;BYDAY=MO,TU,1TU' }), 2)).toHaveLength(
      2,
    );
  });

  it('validates daily and monthly modular phases while preserving reachable intervals', () => {
    expect(() => recurring({ rrule: 'FREQ=DAILY;INTERVAL=7;BYDAY=FR' })).toThrow(/BYDAY is unreachable/);
    expect(() => recurring({ rrule: 'FREQ=MONTHLY;INTERVAL=4;BYMONTH=2' })).toThrow(/BYMONTH is unreachable/);

    expect(
      occurrenceInstants(recurring({ timezone: 'UTC', rrule: 'FREQ=HOURLY;INTERVAL=2;BYHOUR=11' }), 2),
    ).toHaveLength(2);
    expect(occurrenceInstants(recurring({ timezone: 'UTC', rrule: 'FREQ=DAILY;INTERVAL=7;BYDAY=TH' }), 2)).toHaveLength(
      2,
    );
    expect(
      occurrenceInstants(recurring({ timezone: 'UTC', rrule: 'FREQ=MONTHLY;INTERVAL=4;BYMONTH=5' }), 2),
    ).toHaveLength(2);
  });

  it('uses an absolute ten-year horizon from the recurrence definition', () => {
    const schedule = recurring({ dtstartLocal: '2026-01-01T09:00:00', timezone: 'UTC' });
    expect(nextOccurrence(schedule, new Date('2036-01-01T09:00:00Z'))).toBeNull();
  });
});
