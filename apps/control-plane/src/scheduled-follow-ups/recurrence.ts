import { Temporal } from '@js-temporal/polyfill';
import rrule from 'rrule';
import type { RRule } from 'rrule';

const { rrulestr } = rrule;

export type OnceSchedule = { kind: 'once'; runAt: string; displayTimezone?: string };
export type RecurringSchedule = {
  kind: 'recurring';
  dtstartLocal: string;
  timezone: string;
  rrule: string;
  endsAt?: string;
  maxOccurrences?: number;
};
export type ScheduledFollowUpSchedule = OnceSchedule | RecurringSchedule;
export type NormalizedSchedule =
  | { kind: 'once'; runAt: Date; displayTimezone?: string }
  | {
      kind: 'recurring';
      dtstartLocal: string;
      timezone: string;
      rrule: string;
      endsAt?: Date;
      maxOccurrences: number;
    };

export class ScheduleValidationError extends Error {}
const forbidden = /(^|[;\n])(DTSTART|COUNT|UNTIL)(?:[:=])/i;
const allowedKeys = new Set([
  'FREQ',
  'INTERVAL',
  'BYDAY',
  'BYMONTHDAY',
  'BYMONTH',
  'BYHOUR',
  'BYMINUTE',
  'BYSECOND',
  'WKST',
]);
const weekdays = new Set(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']);
const maxRruleBytes = 512;

export function normalizeSchedule(schedule: ScheduledFollowUpSchedule): NormalizedSchedule {
  if (schedule.kind === 'once') {
    const runAt = parseInstant(schedule.runAt, 'runAt');
    const displayTimezone = schedule.displayTimezone ? canonicalTimezone(schedule.displayTimezone) : undefined;
    return { kind: 'once', runAt, ...(displayTimezone ? { displayTimezone } : {}) };
  }
  if (forbidden.test(schedule.rrule))
    throw new ScheduleValidationError('RRULE body must not contain DTSTART, COUNT, or UNTIL');
  const inputBody = stripPrefix(schedule.rrule);
  validateRruleBody(inputBody);
  const timezone = canonicalTimezone(schedule.timezone);
  let local: Temporal.PlainDateTime;
  try {
    local = Temporal.PlainDateTime.from(schedule.dtstartLocal);
  } catch {
    throw new ScheduleValidationError('dtstartLocal must be an ISO local date-time without an offset');
  }
  if (/Z|[+-]\d\d(?::?\d\d)?$/.test(schedule.dtstartLocal))
    throw new ScheduleValidationError('dtstartLocal must not include an offset');
  validateRruleReachability(inputBody, local);
  let parsed: RRule;
  try {
    parsed = rrulestr(`DTSTART:${toRruleLocal(local)}\nRRULE:${inputBody}`, {
      forceset: false,
    }) as RRule;
  } catch (error) {
    throw new ScheduleValidationError(`Invalid RRULE: ${error instanceof Error ? error.message : String(error)}`);
  }
  const body = parsed
    .toString()
    .split('\n')
    .find((line) => line.startsWith('RRULE:'))
    ?.slice(6);
  if (!body) throw new ScheduleValidationError('Invalid RRULE');
  const frequency = /(?:^|;)FREQ=([^;]+)/.exec(body)?.[1];
  if (!frequency || !['HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(frequency))
    throw new ScheduleValidationError('RRULE frequency must be HOURLY, DAILY, WEEKLY, MONTHLY, or YEARLY');
  const explicitMax = schedule.maxOccurrences;
  if (explicitMax !== undefined && (!Number.isInteger(explicitMax) || explicitMax < 1 || explicitMax > 100))
    throw new ScheduleValidationError('maxOccurrences must be an integer between 1 and 100');
  const endsAt = schedule.endsAt ? parseInstant(schedule.endsAt, 'endsAt') : undefined;
  const maxOccurrences = explicitMax ?? (endsAt ? 100 : 10);
  return {
    kind: 'recurring',
    dtstartLocal: local.toString({ smallestUnit: 'second' }),
    timezone,
    rrule: body,
    ...(endsAt ? { endsAt } : {}),
    maxOccurrences,
  };
}

/** Materializes valid instants. Gap candidates are omitted; overlaps use the earlier offset. */
export function occurrenceInstants(schedule: NormalizedSchedule, limit = 10): Date[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ScheduleValidationError('limit must be 1..100');
  if (schedule.kind === 'once') return [new Date(schedule.runAt)];
  const start = Temporal.PlainDateTime.from(schedule.dtstartLocal);
  const startInstant = new Date(start.toZonedDateTime(schedule.timezone).epochMilliseconds);
  return occurrenceInstantsBetween(
    schedule,
    new Date(startInstant.getTime() - 1),
    undefined,
    Math.min(limit, schedule.maxOccurrences),
  );
}

export function nextOccurrence(schedule: NormalizedSchedule, after: Date): Date | null {
  return occurrenceInstantsBetween(schedule, after, undefined, 1)[0] ?? null;
}

/** Finds occurrences within the absolute ten-year horizon measured from DTSTART. */
export function occurrenceInstantsBetween(
  schedule: NormalizedSchedule,
  after: Date,
  through: Date | undefined,
  limit: number,
): Date[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ScheduleValidationError('limit must be 1..100');
  if (schedule.kind === 'once')
    return schedule.runAt > after && (!through || schedule.runAt <= through) ? [new Date(schedule.runAt)] : [];
  const start = Temporal.PlainDateTime.from(schedule.dtstartLocal);
  const rule = rrulestr(`DTSTART:${toRruleLocal(start)}\nRRULE:${schedule.rrule}`) as RRule;
  const definitionStart = new Date(start.toZonedDateTime(schedule.timezone).epochMilliseconds);
  const horizon = new Date(definitionStart);
  horizon.setUTCFullYear(Math.min(9999, horizon.getUTCFullYear() + 10));
  if (after >= horizon) return [];
  const searchThrough =
    schedule.endsAt && schedule.endsAt < horizon ? schedule.endsAt : through && through < horizon ? through : horizon;
  if (searchThrough <= after) return [];
  // RRULE dates represent local wall time as UTC fields. Starting two days before
  // the instant and ending two days after safely spans all supported IANA offsets.
  const candidateStart = new Date(after.getTime() - 2 * 86_400_000);
  const candidateEnd = new Date(searchThrough.getTime() + 2 * 86_400_000);
  const result: Date[] = [];
  rule.between(candidateStart, candidateEnd, true, (candidate) => {
    const instant = candidateInstant(candidate, schedule.timezone);
    if (!instant || instant <= after) return true;
    if (instant > searchThrough) return true;
    result.push(instant);
    return result.length < limit;
  });
  return result;
}

function validateRruleBody(body: string): void {
  if (Buffer.byteLength(body, 'utf8') > maxRruleBytes) throw new ScheduleValidationError('RRULE is too large');
  const clauses = body.split(';');
  if (clauses.length > 10) throw new ScheduleValidationError('RRULE has too many clauses');
  const values = new Map<string, string[]>();
  for (const clause of clauses) {
    const match = /^([A-Z]+)=([A-Z0-9,+-]+)$/i.exec(clause);
    if (!match) throw new ScheduleValidationError('Invalid RRULE clause');
    const key = match[1]!.toUpperCase();
    if (!allowedKeys.has(key) || values.has(key))
      throw new ScheduleValidationError(`Unsupported or duplicate RRULE key: ${key}`);
    const list = match[2]!.toUpperCase().split(',');
    if (list.length > 7 || new Set(list).size !== list.length)
      throw new ScheduleValidationError(`RRULE ${key} list is too large or contains duplicates`);
    values.set(key, list);
  }
  const one = (key: string) => values.get(key)?.[0];
  if (
    !one('FREQ') ||
    values.get('FREQ')!.length !== 1 ||
    !['HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(one('FREQ')!)
  )
    throw new ScheduleValidationError('RRULE frequency must be HOURLY, DAILY, WEEKLY, MONTHLY, or YEARLY');
  const integerList = (key: string, min: number, max: number, allowNegative = false) => {
    const list = values.get(key);
    if (!list) return [];
    const parsed = list.map(Number);
    if (
      parsed.some(
        (n) => !Number.isInteger(n) || n < (allowNegative ? -max : min) || n > max || (allowNegative && n === 0),
      )
    )
      throw new ScheduleValidationError(`RRULE ${key} contains an out-of-range value`);
    return parsed;
  };
  const interval = integerList('INTERVAL', 1, 365);
  if (interval.length > 1) throw new ScheduleValidationError('RRULE INTERVAL must be a singleton');
  integerList('BYMONTHDAY', 1, 31);
  const months = integerList('BYMONTH', 1, 12);
  for (const key of ['BYHOUR', 'BYMINUTE', 'BYSECOND'] as const) {
    integerList(key, 0, key === 'BYHOUR' ? 23 : 59);
    if ((values.get(key)?.length ?? 0) > 2)
      throw new ScheduleValidationError(`RRULE ${key} supports at most two values`);
  }
  if (
    (values.get('BYHOUR')?.length ?? 1) *
      (values.get('BYMINUTE')?.length ?? 1) *
      (values.get('BYSECOND')?.length ?? 1) >
    8
  )
    throw new ScheduleValidationError('RRULE has too many time combinations');
  for (const day of values.get('BYDAY') ?? []) {
    const match = /^([+-]?(?:[1-4]))?(MO|TU|WE|TH|FR|SA|SU)$/.exec(day);
    if (!match || !weekdays.has(match[2]!)) throw new ScheduleValidationError('RRULE BYDAY is invalid');
  }
  const wkst = values.get('WKST');
  if (wkst && (wkst.length !== 1 || !weekdays.has(wkst[0]!)))
    throw new ScheduleValidationError('RRULE WKST is invalid');
  const monthDays = integerList('BYMONTHDAY', 1, 31);
  const maxDays = (month: number) => (month === 2 ? 29 : [4, 6, 9, 11].includes(month) ? 30 : 31);
  if (months.length && monthDays.length && months.every((month) => monthDays.every((day) => day > maxDays(month))))
    throw new ScheduleValidationError('RRULE BYMONTH and BYMONTHDAY can never occur');
}

/** Rejects filters that rrule can search forever because its interval can never land on their phase. */
function validateRruleReachability(body: string, start: Temporal.PlainDateTime): void {
  const clauses = new Map(
    body.split(';').map((clause) => {
      const [key, raw = ''] = clause.split('=');
      return [key!.toUpperCase(), raw.toUpperCase().split(',')] as const;
    }),
  );
  const frequency = clauses.get('FREQ')![0]!;
  const interval = Number(clauses.get('INTERVAL')?.[0] ?? 1);
  const numbers = (key: string) => clauses.get(key)?.map(Number);
  const dayNumbers = clauses.get('BYDAY')?.map((day) => weekdaysInOrder.indexOf(day) + 1);

  // These combinations are outside the product's supported recurrence shapes and
  // mix calendar filters with a smaller stepping unit in ways rrule may never satisfy.
  if ((frequency === 'HOURLY' || frequency === 'DAILY' || frequency === 'WEEKLY') && clauses.has('BYMONTHDAY'))
    throw new ScheduleValidationError(`RRULE BYMONTHDAY is not supported with ${frequency}`);
  if ((frequency === 'HOURLY' || frequency === 'DAILY' || frequency === 'WEEKLY') && clauses.has('BYMONTH'))
    throw new ScheduleValidationError(`RRULE BYMONTH is not supported with ${frequency}`);
  if ((frequency === 'HOURLY' || frequency === 'DAILY' || frequency === 'WEEKLY') && dayNumbers?.includes(0))
    throw new ScheduleValidationError(`Ordinal RRULE BYDAY is not supported with ${frequency}`);

  if (frequency === 'HOURLY' && (clauses.has('BYHOUR') || dayNumbers)) {
    const hours = numbers('BYHOUR') ?? [...Array(24).keys()];
    const days = dayNumbers ?? [1, 2, 3, 4, 5, 6, 7];
    const cycle = 168 / gcd(interval, 168);
    const reachable = Array.from({ length: cycle }, (_, step) => {
      const elapsed = step * interval;
      const hour = (start.hour + elapsed) % 24;
      const day = ((start.dayOfWeek - 1 + Math.floor((start.hour + elapsed) / 24)) % 7) + 1;
      return hours.includes(hour) && days.includes(day);
    }).some(Boolean);
    if (!reachable)
      throw new ScheduleValidationError('RRULE hourly filters are unreachable from DTSTART at this INTERVAL');
  }

  if (frequency === 'DAILY' && dayNumbers) {
    const cycle = 7 / gcd(interval, 7);
    const reachable = Array.from(
      { length: cycle },
      (_, step) => ((start.dayOfWeek - 1 + step * interval) % 7) + 1,
    ).some((day) => dayNumbers.includes(day));
    if (!reachable) throw new ScheduleValidationError('RRULE BYDAY is unreachable from DTSTART at this INTERVAL');
  }

  if (frequency === 'MONTHLY' && clauses.has('BYMONTH')) {
    const months = numbers('BYMONTH')!;
    const cycle = 12 / gcd(interval, 12);
    const reachable = Array.from({ length: cycle }, (_, step) => ((start.month - 1 + step * interval) % 12) + 1).some(
      (month) => months.includes(month),
    );
    if (!reachable) throw new ScheduleValidationError('RRULE BYMONTH is unreachable from DTSTART at this INTERVAL');
  }

  if (
    (frequency === 'MONTHLY' || frequency === 'YEARLY') &&
    !hasCalendarOccurrenceWithinHorizon(frequency, interval, clauses, start)
  )
    throw new ScheduleValidationError('RRULE calendar filters have no occurrence within the ten-year horizon');
}

const weekdaysInOrder = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
function gcd(left: number, right: number): number {
  while (right !== 0) [left, right] = [right, left % right];
  return left;
}

/**
 * Proves that calendar-frequency filters have a candidate before invoking rrule.
 * rrule only checks its `between` end after finding a candidate, so an empty
 * filter intersection can otherwise scan periods through year 9999.
 */
function hasCalendarOccurrenceWithinHorizon(
  frequency: 'MONTHLY' | 'YEARLY',
  interval: number,
  clauses: ReadonlyMap<string, readonly string[]>,
  start: Temporal.PlainDateTime,
): boolean {
  const startDate = start.toPlainDate();
  const horizon = startDate.add({ years: 10 });
  const months = clauses.get('BYMONTH')?.map(Number);
  const monthDays = clauses.get('BYMONTHDAY')?.map(Number);
  const byDays = clauses.get('BYDAY')?.map((value) => {
    const match = /^([+-]?[1-4])?(MO|TU|WE|TH|FR|SA|SU)$/.exec(value)!;
    return { ordinal: match[1] ? Number(match[1]) : undefined, weekday: weekdaysInOrder.indexOf(match[2]!) + 1 };
  });

  for (let date = startDate; Temporal.PlainDate.compare(date, horizon) <= 0; date = date.add({ days: 1 })) {
    const periodOffset =
      frequency === 'MONTHLY' ? (date.year - start.year) * 12 + date.month - start.month : date.year - start.year;
    if (periodOffset < 0 || periodOffset % interval !== 0) continue;
    if (months && !months.includes(date.month)) continue;
    if (monthDays && !monthDays.includes(date.day)) continue;

    if (byDays) {
      const plainDays = byDays.filter(({ ordinal }) => ordinal === undefined);
      const ordinalDays = byDays.filter(({ ordinal }) => ordinal !== undefined);
      if (plainDays.length && !plainDays.some(({ weekday }) => date.dayOfWeek === weekday)) continue;
      const matchesOrdinal = ordinalDays.some(({ ordinal, weekday }) => {
        if (date.dayOfWeek !== weekday) return false;
        const ordinalInPeriod =
          frequency === 'MONTHLY' || months
            ? ordinal! > 0
              ? Math.ceil(date.day / 7)
              : -Math.ceil((date.daysInMonth - date.day + 1) / 7)
            : ordinal! > 0
              ? Math.ceil(date.dayOfYear / 7)
              : -Math.ceil((date.daysInYear - date.dayOfYear + 1) / 7);
        return ordinalInPeriod === ordinal;
      });
      if (ordinalDays.length && !matchesOrdinal) continue;
    } else if (!monthDays) {
      if (date.day !== start.day) continue;
      if (frequency === 'YEARLY' && !months && date.month !== start.month) continue;
    }
    return true;
  }
  return false;
}

function candidateInstant(candidate: Date, timezone: string): Date | null {
  const local = Temporal.PlainDateTime.from({
    year: candidate.getUTCFullYear(),
    month: candidate.getUTCMonth() + 1,
    day: candidate.getUTCDate(),
    hour: candidate.getUTCHours(),
    minute: candidate.getUTCMinutes(),
    second: candidate.getUTCSeconds(),
  });
  try {
    return new Date(local.toZonedDateTime(timezone, { disambiguation: 'reject' }).epochMilliseconds);
  } catch {
    const zoned = local.toZonedDateTime(timezone, { disambiguation: 'earlier' });
    return zoned.toPlainDateTime().equals(local) ? new Date(zoned.epochMilliseconds) : null;
  }
}

function canonicalTimezone(input: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: input }).resolvedOptions().timeZone;
  } catch {
    throw new ScheduleValidationError('timezone must be a valid IANA timezone');
  }
}
function parseInstant(input: string, field: string): Date {
  try {
    return new Date(Temporal.Instant.from(input).epochMilliseconds);
  } catch {
    throw new ScheduleValidationError(`${field} must be an RFC 3339 instant`);
  }
}
function stripPrefix(value: string): string {
  return value.trim().replace(/^RRULE:/i, '');
}
function toRruleLocal(value: Temporal.PlainDateTime): string {
  return `${String(value.year).padStart(4, '0')}${String(value.month).padStart(2, '0')}${String(value.day).padStart(2, '0')}T${String(value.hour).padStart(2, '0')}${String(value.minute).padStart(2, '0')}${String(value.second).padStart(2, '0')}`;
}
