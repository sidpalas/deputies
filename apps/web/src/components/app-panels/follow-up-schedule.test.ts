import { describe, expect, it } from 'vitest';
import { civilInstant, inclusiveEndOfDay } from './follow-up-schedule.js';

describe('scheduled follow-up civil time conversion', () => {
  it('uses the selected zone rather than the browser zone', () => {
    expect(civilInstant('2026-01-15T09:00', 'America/New_York')).toBe('2026-01-15T14:00:00Z');
    expect(civilInstant('2026-01-15T09:00', 'Asia/Tokyo')).toBe('2026-01-15T00:00:00Z');
  });

  it('rejects gaps and picks the earlier overlap offset', () => {
    expect(() => civilInstant('2026-03-08T02:30', 'America/New_York')).toThrow(/does not exist/);
    expect(civilInstant('2026-11-01T01:30', 'America/New_York')).toBe('2026-11-01T05:30:00Z');
  });

  it('handles Lord Howe half-hour transitions', () => {
    expect(() => civilInstant('2026-10-04T02:15', 'Australia/Lord_Howe')).toThrow(/does not exist/);
    expect(civilInstant('2026-04-05T01:45', 'Australia/Lord_Howe')).toBe('2026-04-04T14:45:00Z');
  });

  it('makes an end date inclusive in the selected zone', () => {
    expect(inclusiveEndOfDay('2026-01-15', 'Asia/Tokyo')).toBe('2026-01-15T14:59:59.999999999Z');
  });
});
