import { useEffect, useRef, useState } from 'react';
import type { ScheduledFollowUpPreview, ScheduledFollowUpSchedule } from '../../api.js';
import { civilInstant, formatInZone, inclusiveEndOfDay, scheduleKey } from './follow-up-schedule.js';

export type RecurrencePattern = 'hourly' | 'daily' | 'weekly' | 'weekdays';

export function recurrenceRule(pattern: RecurrencePattern): string {
  switch (pattern) {
    case 'hourly':
      return 'FREQ=HOURLY;INTERVAL=1';
    case 'daily':
      return 'FREQ=DAILY;INTERVAL=1';
    case 'weekly':
      return 'FREQ=WEEKLY;INTERVAL=1';
    case 'weekdays':
      return 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR';
  }
}

function localDefault() {
  const date = new Date(Date.now() + 60 * 60_000);
  date.setSeconds(0, 0);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function FollowUpScheduleFields(props: {
  onChange: (schedule: ScheduledFollowUpSchedule | null) => void;
  onPreview: (schedule: ScheduledFollowUpSchedule) => Promise<ScheduledFollowUpPreview>;
  onPreviewValid?: (valid: boolean) => void;
  initialSchedule?: ScheduledFollowUpSchedule;
}) {
  const initial = props.initialSchedule;
  const [kind, setKind] = useState<'once' | 'recurring'>(initial?.kind ?? 'once');
  const [local, setLocal] = useState(() =>
    initial?.kind === 'once'
      ? instantAsCivil(initial.runAt, initial.displayTimezone ?? 'UTC')
      : (initial?.dtstartLocal ?? localDefault()),
  );
  const [timezone, setTimezone] = useState(
    () =>
      (initial?.kind === 'once' ? initial.displayTimezone : initial?.timezone) ??
      Intl.DateTimeFormat().resolvedOptions().timeZone ??
      'UTC',
  );
  const [pattern, setPattern] = useState<RecurrencePattern>(() =>
    patternFromRule(initial?.kind === 'recurring' ? initial.rrule : ''),
  );
  const [ends, setEnds] = useState(() =>
    initial?.kind === 'recurring' && initial.endsAt
      ? new Intl.DateTimeFormat('en-CA', { timeZone: initial.timezone }).format(new Date(initial.endsAt))
      : '',
  );
  const [maximum, setMaximum] = useState(() =>
    initial?.kind === 'recurring' ? String(initial.maxOccurrences ?? '') : '10',
  );
  const [preview, setPreview] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const schedule = buildSchedule(kind, local, timezone, pattern, ends, maximum);
  const generation = useRef(0);

  useEffect(() => {
    generation.current += 1;
    props.onChange(schedule);
    setPreview([]);
    setError('');
    props.onPreviewValid?.(false);
  }, [scheduleKey(schedule)]);

  async function showPreview() {
    if (!schedule) return;
    const requestGeneration = generation.current;
    setError('');
    setLoading(true);
    try {
      const result = await props.onPreview(schedule);
      if (requestGeneration !== generation.current) return;
      setPreview(result.occurrences.slice(0, 6));
      props.onPreviewValid?.(true);
    } catch (error) {
      if (requestGeneration !== generation.current) return;
      setPreview([]);
      setError(error instanceof Error ? error.message : 'Unable to calculate send times');
      props.onPreviewValid?.(false);
    } finally {
      if (requestGeneration === generation.current) setLoading(false);
    }
  }

  const inputClass = 'h-8 rounded-md border border-input bg-background px-2 text-xs';
  return (
    <fieldset className="basis-full rounded-md border border-border p-2" aria-label="Schedule settings">
      <div className="flex flex-wrap gap-2">
        <label className="text-xs">
          Schedule{' '}
          <select className={inputClass} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="once">Once</option>
            <option value="recurring">Recurring</option>
          </select>
        </label>
        <label className="text-xs">
          Date and time{' '}
          <input
            className={inputClass}
            type="datetime-local"
            required
            value={local}
            onChange={(e) => setLocal(e.target.value)}
          />
        </label>
        <label className="text-xs">
          Timezone{' '}
          <input
            className={`${inputClass} w-44`}
            required
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            placeholder="America/New_York"
          />
        </label>
        {kind === 'recurring' ? (
          <>
            <label className="text-xs">
              Repeat{' '}
              <select
                className={inputClass}
                value={pattern}
                onChange={(e) => setPattern(e.target.value as RecurrencePattern)}
              >
                <option value="hourly">Hourly</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="weekdays">Weekdays</option>
              </select>
            </label>
            <label className="text-xs">
              End date{' '}
              <input className={inputClass} type="date" value={ends} onChange={(e) => setEnds(e.target.value)} />
            </label>
            <label className="text-xs">
              Maximum{' '}
              <input
                className={`${inputClass} w-20`}
                type="number"
                min="1"
                max="100"
                value={maximum}
                onChange={(e) => setMaximum(e.target.value)}
              />
            </label>
          </>
        ) : null}
        <button
          type="button"
          className="h-8 rounded-md border border-border px-2 text-xs"
          disabled={!schedule}
          onClick={() => void showPreview()}
        >
          {loading ? 'Calculating…' : 'Show send times'}
        </button>
      </div>
      {error ? (
        <p className="mt-1 text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      {preview.length ? (
        <div className="mt-1 text-xs" aria-live="polite">
          <strong>Send times:</strong> {preview.map((item) => formatInZone(item, timezone.trim())).join(' · ')}
        </div>
      ) : null}
    </fieldset>
  );
}

function instantAsCivil(instant: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(instant));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}T${value('hour')}:${value('minute')}`;
}

function patternFromRule(rule: string): RecurrencePattern {
  if (rule.includes('HOURLY')) return 'hourly';
  if (rule.includes('BYDAY=MO')) return 'weekdays';
  if (rule.includes('WEEKLY')) return 'weekly';
  return 'daily';
}

function buildSchedule(
  kind: 'once' | 'recurring',
  local: string,
  timezone: string,
  pattern: RecurrencePattern,
  ends: string,
  maximum: string,
): ScheduledFollowUpSchedule | null {
  if (!local || !timezone.trim()) return null;
  if (kind === 'once') {
    try {
      return { kind, runAt: civilInstant(local, timezone.trim()), displayTimezone: timezone.trim() };
    } catch {
      return null;
    }
  }
  const maxOccurrences = maximum ? Number(maximum) : undefined;
  if (maxOccurrences !== undefined && (!Number.isInteger(maxOccurrences) || maxOccurrences < 1 || maxOccurrences > 100))
    return null;
  return {
    kind,
    dtstartLocal: local,
    timezone: timezone.trim(),
    rrule: recurrenceRule(pattern),
    ...(ends ? { endsAt: inclusiveEndOfDay(ends, timezone.trim()) } : {}),
    ...(maxOccurrences ? { maxOccurrences } : {}),
  };
}
