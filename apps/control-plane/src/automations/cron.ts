export class CronExpressionError extends Error {
  constructor(message: string) {
    super(message);
  }
}

type CronField = {
  values: Set<number>;
  wildcard: boolean;
};

type ParsedCron = {
  minutes: CronField;
  hours: CronField;
  daysOfMonth: CronField;
  months: CronField;
  daysOfWeek: CronField;
};

const maxSearchMinutes = 366 * 5 * 24 * 60;

export function validateUtcCronExpression(expression: string): void {
  parseUtcCronExpression(expression);
}

export function nextUtcCronInvocation(expression: string, after: Date): Date {
  const cron = parseUtcCronExpression(expression);
  let cursor = nextMinute(after);
  for (let checked = 0; checked < maxSearchMinutes; checked += 1) {
    if (matchesCron(cron, cursor)) return cursor;
    cursor = new Date(cursor.getTime() + 60_000);
  }
  throw new CronExpressionError('Cron expression did not match any UTC minute in the next five years');
}

function parseUtcCronExpression(expression: string): ParsedCron {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new CronExpressionError('Expected 5-field UTC cron expression');

  return {
    minutes: parseField(fields[0]!, 0, 59),
    hours: parseField(fields[1]!, 0, 23),
    daysOfMonth: parseField(fields[2]!, 1, 31),
    months: parseField(fields[3]!, 1, 12),
    daysOfWeek: parseField(fields[4]!, 0, 7, (value) => (value === 7 ? 0 : value)),
  };
}

function parseField(
  raw: string,
  min: number,
  max: number,
  normalize: (value: number) => number = (value) => value,
): CronField {
  const values = new Set<number>();
  const parts = raw.split(',');
  if (!parts.length || parts.some((part) => !part)) throw new CronExpressionError(`Invalid cron field: ${raw}`);

  for (const part of parts) {
    const [rangePart, stepPart] = part.split('/');
    if (!rangePart || part.split('/').length > 2) throw new CronExpressionError(`Invalid cron field: ${raw}`);
    const step = stepPart === undefined ? 1 : parseNumber(stepPart, 1, max);
    const [start, end] = parseRange(rangePart, min, max);
    for (let value = start; value <= end; value += step) values.add(normalize(value));
  }

  if (!values.size) throw new CronExpressionError(`Invalid cron field: ${raw}`);
  return { values, wildcard: raw === '*' };
}

function parseRange(raw: string, min: number, max: number): [number, number] {
  if (raw === '*') return [min, max];
  const pieces = raw.split('-');
  if (pieces.length === 1) {
    const value = parseNumber(pieces[0]!, min, max);
    return [value, value];
  }
  if (pieces.length !== 2) throw new CronExpressionError(`Invalid cron range: ${raw}`);
  const start = parseNumber(pieces[0]!, min, max);
  const end = parseNumber(pieces[1]!, min, max);
  if (end < start) throw new CronExpressionError(`Invalid cron range: ${raw}`);
  return [start, end];
}

function parseNumber(raw: string, min: number, max: number): number {
  if (!/^\d+$/.test(raw)) throw new CronExpressionError(`Invalid cron number: ${raw}`);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new CronExpressionError(`Cron value ${raw} must be between ${min} and ${max}`);
  }
  return value;
}

function matchesCron(cron: ParsedCron, date: Date): boolean {
  return (
    cron.minutes.values.has(date.getUTCMinutes()) &&
    cron.hours.values.has(date.getUTCHours()) &&
    cron.months.values.has(date.getUTCMonth() + 1) &&
    matchesCronDay(cron, date)
  );
}

function matchesCronDay(cron: ParsedCron, date: Date): boolean {
  const dayOfMonthMatches = cron.daysOfMonth.values.has(date.getUTCDate());
  const dayOfWeekMatches = cron.daysOfWeek.values.has(date.getUTCDay());
  if (cron.daysOfMonth.wildcard && cron.daysOfWeek.wildcard) return true;
  if (cron.daysOfMonth.wildcard) return dayOfWeekMatches;
  if (cron.daysOfWeek.wildcard) return dayOfMonthMatches;
  return dayOfMonthMatches || dayOfWeekMatches;
}

function nextMinute(date: Date): Date {
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      date.getUTCHours(),
      date.getUTCMinutes() + 1,
    ),
  );
}
