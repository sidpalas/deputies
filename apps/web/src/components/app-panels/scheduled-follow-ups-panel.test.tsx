import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ScheduledFollowUp } from '../../api.js';
import { ScheduledFollowUpsPanel } from './scheduled-follow-ups-panel.js';

function definition(rrule: string): ScheduledFollowUp {
  return {
    id: rrule,
    sessionId: 'session-1',
    status: 'active',
    scheduleKind: 'recurring',
    prompt: 'Original prompt',
    dtstartLocal: '2026-07-25T10:00',
    timezone: 'UTC',
    rrule,
    definitionRevision: 1,
    createdAt: '2026-07-24T10:00:00Z',
    updatedAt: '2026-07-24T10:00:00Z',
    canManage: true,
  };
}

function panel(followUps: ScheduledFollowUp[], onUpdate = vi.fn().mockResolvedValue(undefined)) {
  return {
    onUpdate,
    view: render(
      <ScheduledFollowUpsPanel
        followUps={followUps}
        hasMore={false}
        loadingOlder={false}
        archived={false}
        onCancel={vi.fn()}
        onHistory={vi.fn()}
        onPreview={vi.fn()}
        onUpdate={onUpdate}
        onLoadOlder={vi.fn()}
      />,
    ),
  };
}

function expandPanel() {
  fireEvent.click(screen.getByText(/Scheduled Follow-ups/, { selector: 'summary' }));
}

it('renders accurate monthly and yearly custom recurrence labels', () => {
  panel([definition('FREQ=MONTHLY;BYMONTHDAY=15'), definition('FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=20')]);
  expect(screen.queryByText(/Monthly \(day 15\)/)).not.toBeInTheDocument();
  expandPanel();
  expect(screen.getByText(/Monthly \(day 15\)/)).toBeInTheDocument();
  expect(screen.getByText(/Yearly \(March 20\)/)).toBeInTheDocument();
});

it('hides completed follow-ups and the panel when none remain active', () => {
  const completed = {
    ...definition('FREQ=DAILY;INTERVAL=1'),
    status: 'completed' as const,
    prompt: 'Completed prompt',
  };
  const active = { ...definition('FREQ=WEEKLY;INTERVAL=1'), prompt: 'Active prompt' };

  const { view } = panel([completed, active]);
  expect(screen.queryByText(completed.prompt)).not.toBeInTheDocument();
  expandPanel();
  expect(screen.queryByText(completed.prompt)).not.toBeInTheDocument();
  expect(screen.getByText(active.prompt)).toBeInTheDocument();

  view.rerender(
    <ScheduledFollowUpsPanel
      followUps={[completed]}
      hasMore={false}
      loadingOlder={false}
      archived={false}
      onCancel={vi.fn()}
      onHistory={vi.fn()}
      onPreview={vi.fn()}
      onUpdate={vi.fn()}
      onLoadOlder={vi.fn()}
    />,
  );
  expect(screen.queryByText(/Scheduled Follow-ups/, { selector: 'summary' })).not.toBeInTheDocument();
});

it('preserves a custom schedule when editing only its prompt', async () => {
  const item = definition('FREQ=MONTHLY;BYMONTHDAY=15');
  const onUpdate = vi.fn().mockResolvedValue(undefined);
  panel([item], onUpdate);
  expandPanel();
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Cancel editing' })).toBeInTheDocument();
  expect(screen.getByText(/custom recurrence is read-only/i)).toBeInTheDocument();
  expect(screen.queryByRole('group', { name: 'Schedule settings' })).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole('textbox', { name: 'Prompt' }), { target: { value: 'Changed prompt' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(onUpdate).toHaveBeenCalledWith(item, 'Changed prompt', undefined));
});
