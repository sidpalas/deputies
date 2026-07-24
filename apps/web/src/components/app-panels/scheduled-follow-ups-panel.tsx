import { useState } from 'react';
import type {
  ScheduledFollowUp,
  ScheduledFollowUpOccurrence,
  ScheduledFollowUpOccurrencePage,
  ScheduledFollowUpPreview,
  ScheduledFollowUpSchedule,
} from '../../api.js';
import { Button } from '../ui/button.js';
import { FollowUpScheduleFields } from './follow-up-schedule-fields.js';

const reasonLabels: Record<string, string> = {
  missed_during_downtime: 'Missed while the scheduler was offline',
  previous_message_unfinished: 'Previous scheduled message is still unfinished',
  invalid_context: 'Saved context is no longer valid',
  resource_unavailable: 'A selected resource is unavailable',
  external_binding_invalid: 'External thread binding is invalid',
};

export function ScheduledFollowUpsPanel(props: {
  followUps: ScheduledFollowUp[];
  hasMore: boolean;
  loadingOlder: boolean;
  archived: boolean;
  onCancel: (item: ScheduledFollowUp) => Promise<void>;
  onHistory: (item: ScheduledFollowUp, cursor?: number) => Promise<ScheduledFollowUpOccurrencePage>;
  onPreview: (schedule: ScheduledFollowUpSchedule) => Promise<ScheduledFollowUpPreview>;
  onUpdate: (item: ScheduledFollowUp, prompt: string, schedule?: ScheduledFollowUpSchedule) => Promise<void>;
  onLoadOlder: () => Promise<void>;
}) {
  const [open, setOpen] = useState('');
  const [history, setHistory] = useState<Record<string, ScheduledFollowUpOccurrence[]>>({});
  const [loading, setLoading] = useState('');
  const [cursors, setCursors] = useState<Record<string, string | undefined>>({});
  const [editing, setEditing] = useState('');
  const [editPrompt, setEditPrompt] = useState('');
  const [editSchedule, setEditSchedule] = useState<ScheduledFollowUpSchedule | null>(null);
  const [editPreviewValid, setEditPreviewValid] = useState(false);
  const [replacingSchedule, setReplacingSchedule] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const activeFollowUps = props.followUps.filter((item) => item.status === 'active');
  async function load(item: ScheduledFollowUp, append = false) {
    setLoading(item.id);
    const current = history[item.id] ?? [];
    try {
      const page = await props.onHistory(item, append && cursors[item.id] ? Number(cursors[item.id]) : undefined);
      setHistory((value) => ({ ...value, [item.id]: append ? [...current, ...page.occurrences] : page.occurrences }));
      setCursors((value) => ({ ...value, [item.id]: page.hasMore ? page.nextCursor : undefined }));
    } finally {
      setLoading('');
    }
  }
  if (!activeFollowUps.length) return null;
  return (
    <section className="shrink-0 rounded-md border border-border bg-background p-2" aria-label="Scheduled Follow-ups">
      <details open={expanded}>
        <summary
          className="cursor-pointer text-sm font-semibold"
          onClick={(event) => {
            event.preventDefault();
            setExpanded((value) => !value);
          }}
        >
          Scheduled Follow-ups ({activeFollowUps.length})
        </summary>
        {expanded ? (
          <div
            id="scheduled-follow-ups-content"
            className="mt-1 max-h-[45dvh] space-y-1 overflow-y-auto overscroll-contain pr-1 lg:max-h-none"
          >
            {activeFollowUps.map((item) => (
              <article key={item.id} className="rounded border border-border p-2 text-xs">
                <div className="flex flex-wrap items-start gap-2 sm:flex-nowrap">
                  <div className="min-w-0 basis-full sm:flex-1 sm:basis-auto">
                    <strong className="capitalize">{item.status}</strong> · {scheduleLabel(item)}
                    <p className="truncate" title={item.prompt}>
                      {item.prompt}
                    </p>
                    <p className="text-muted-foreground">
                      {item.nextDueAt ? `Next: ${new Date(item.nextDueAt).toLocaleString()}` : 'No future occurrence'}
                      {item.timezone ? ` · ${item.timezone}` : ''}
                      {item.endsAt ? ` · ends ${new Date(item.endsAt).toLocaleDateString()}` : ''}
                      {item.maxOccurrences ? ` · max ${item.maxOccurrences}` : ''}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    type="button"
                    onClick={() => {
                      setOpen(open === item.id ? '' : item.id);
                      if (open !== item.id && !history[item.id]) void load(item);
                    }}
                  >
                    History
                  </Button>
                  {item.status === 'active' && item.canManage && !props.archived && editing !== item.id ? (
                    <>
                      <Button
                        size="sm"
                        variant="secondary"
                        type="button"
                        onClick={() => {
                          setEditing(item.id);
                          setEditPrompt(item.prompt);
                          setEditPreviewValid(false);
                          setEditSchedule(null);
                          setReplacingSchedule(false);
                        }}
                      >
                        Edit
                      </Button>
                      <Button size="sm" variant="destructive" type="button" onClick={() => void props.onCancel(item)}>
                        Cancel
                      </Button>
                    </>
                  ) : null}
                </div>
                {editing === item.id ? (
                  <div className="mt-2 space-y-2 border-t border-border pt-2">
                    <label className="block">
                      Prompt
                      <textarea
                        className="mt-1 w-full rounded border border-input bg-background p-2"
                        value={editPrompt}
                        onChange={(event) => setEditPrompt(event.target.value)}
                      />
                    </label>
                    {isSupportedSchedule(item) || replacingSchedule ? (
                      <FollowUpScheduleFields
                        {...(!replacingSchedule ? { initialSchedule: scheduleFromDefinition(item) } : {})}
                        onChange={setEditSchedule}
                        onPreview={props.onPreview}
                        onPreviewValid={setEditPreviewValid}
                      />
                    ) : (
                      <div className="rounded-md border border-border p-2">
                        <strong>Schedule: {scheduleLabel(item)}</strong>
                        <p className="text-muted-foreground">
                          This custom recurrence is read-only. Saving the prompt will preserve it exactly.
                        </p>
                        <Button size="sm" variant="secondary" type="button" onClick={() => setReplacingSchedule(true)}>
                          Replace schedule
                        </Button>
                      </div>
                    )}
                    <div className="flex gap-1">
                      <Button
                        size="sm"
                        type="button"
                        disabled={
                          !editPrompt.trim() ||
                          (isSupportedSchedule(item) || replacingSchedule ? !editSchedule || !editPreviewValid : false)
                        }
                        onClick={() => {
                          if ((isSupportedSchedule(item) || replacingSchedule) && !editSchedule) return;
                          void props
                            .onUpdate(item, editPrompt.trim(), editSchedule ?? undefined)
                            .then(() => setEditing(''));
                        }}
                      >
                        Save
                      </Button>
                      <Button size="sm" variant="secondary" type="button" onClick={() => setEditing('')}>
                        Cancel editing
                      </Button>
                    </div>
                  </div>
                ) : null}
                {open === item.id ? (
                  <div className="mt-2 border-t border-border pt-1">
                    {loading === item.id ? (
                      <p>Loading history…</p>
                    ) : !history[item.id]?.length ? (
                      <p>No occurrences yet.</p>
                    ) : (
                      <ol className="space-y-1">
                        {(history[item.id] ?? []).map((row) => (
                          <li key={row.id}>
                            #{row.occurrenceNumber} · {new Date(row.scheduledAt).toLocaleString()} ·{' '}
                            <strong>{row.outcome.replaceAll('_', ' ')}</strong>
                            {row.reason ? ` — ${reasonLabels[row.reason] ?? row.reason.replaceAll('_', ' ')}` : ''}
                            {row.error ? `: ${row.error}` : ''}
                          </li>
                        ))}
                      </ol>
                    )}
                    {cursors[item.id] ? (
                      <Button
                        className="mt-1"
                        size="sm"
                        variant="secondary"
                        type="button"
                        onClick={() => void load(item, true)}
                      >
                        Load older
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </article>
            ))}
            {props.hasMore ? (
              <Button
                size="sm"
                variant="secondary"
                type="button"
                disabled={props.loadingOlder}
                onClick={() => void props.onLoadOlder()}
              >
                {props.loadingOlder ? 'Loading older…' : 'Load older'}
              </Button>
            ) : null}
          </div>
        ) : null}
      </details>
    </section>
  );
}

const supportedRules = new Set([
  'FREQ=HOURLY;INTERVAL=1',
  'FREQ=DAILY;INTERVAL=1',
  'FREQ=WEEKLY;INTERVAL=1',
  'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
]);

function normalizedRule(rule?: string): string {
  return (rule ?? '').replace(/^RRULE:/i, '').toUpperCase();
}

export function isSupportedSchedule(item: ScheduledFollowUp): boolean {
  return item.scheduleKind === 'once' || supportedRules.has(normalizedRule(item.rrule));
}

export function scheduleLabel(item: ScheduledFollowUp): string {
  if (item.scheduleKind === 'once') return 'Once';
  const rule = normalizedRule(item.rrule);
  if (rule === 'FREQ=HOURLY;INTERVAL=1') return 'Hourly';
  if (rule === 'FREQ=DAILY;INTERVAL=1') return 'Daily';
  if (rule === 'FREQ=WEEKLY;INTERVAL=1') return 'Weekly';
  if (rule === 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR') return 'Weekdays';
  const fields = Object.fromEntries(rule.split(';').map((part) => part.split('=', 2)));
  if (fields.FREQ === 'MONTHLY') return fields.BYMONTHDAY ? `Monthly (day ${fields.BYMONTHDAY})` : 'Monthly (custom)';
  if (fields.FREQ === 'YEARLY') {
    const month = Number(fields.BYMONTH);
    const monthName =
      month >= 1 && month <= 12
        ? new Intl.DateTimeFormat('en', { month: 'long' }).format(new Date(2020, month - 1))
        : '';
    return monthName && fields.BYMONTHDAY ? `Yearly (${monthName} ${fields.BYMONTHDAY})` : 'Yearly (custom)';
  }
  return 'Custom recurrence';
}

function scheduleFromDefinition(item: ScheduledFollowUp): ScheduledFollowUpSchedule {
  if (item.scheduleKind === 'once')
    return { kind: 'once', runAt: item.runAt!, displayTimezone: item.timezone ?? 'UTC' };
  return {
    kind: 'recurring',
    dtstartLocal: item.dtstartLocal!,
    timezone: item.timezone!,
    rrule: item.rrule!,
    ...(item.endsAt ? { endsAt: item.endsAt } : {}),
    ...(item.maxOccurrences ? { maxOccurrences: item.maxOccurrences } : {}),
  };
}
