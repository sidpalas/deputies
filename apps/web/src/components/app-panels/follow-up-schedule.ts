import { Temporal } from '@js-temporal/polyfill';
import type { ScheduledFollowUpSchedule } from '../../api.js';

/** Resolve civil time in its selected zone. Gaps are invalid; overlaps use the earlier offset. */
export function civilInstant(local: string, timeZone: string): string {
  const civil = Temporal.PlainDateTime.from(local);
  const zoned = Temporal.ZonedDateTime.from(
    {
      year: civil.year,
      month: civil.month,
      day: civil.day,
      hour: civil.hour,
      minute: civil.minute,
      second: civil.second,
      timeZone,
    },
    { disambiguation: 'earlier' },
  );
  if (!zoned.toPlainDateTime().equals(civil))
    throw new RangeError('This local time does not exist in the selected timezone');
  return zoned.toInstant().toString();
}

/** Recurrence end dates include the whole selected local day (through its final nanosecond). */
export function inclusiveEndOfDay(date: string, timeZone: string): string {
  return Temporal.PlainDate.from(date)
    .add({ days: 1 })
    .toZonedDateTime({ timeZone, plainTime: '00:00' })
    .subtract({ nanoseconds: 1 })
    .toInstant()
    .toString();
}

export function formatInZone(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(
    new Date(instant),
  );
}

export function scheduleKey(schedule: ScheduledFollowUpSchedule | null): string {
  return schedule ? JSON.stringify(schedule) : '';
}
