import { fireEvent, render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import type { Automation } from './api.js';
import { AutomationsPanel } from './components/app-panels/automations-panel.js';
import { AutomationsSidebar } from './components/app-panels/automations-sidebar.js';

const activeAutomation: Automation = {
  id: 'active',
  kind: 'scheduled',
  name: 'Nightly review',
  prompt: 'Review changes',
  scheduleCron: '0 9 * * *',
  scheduleTimezone: 'UTC',
  enabled: true,
  canManage: true,
  createdAt: '2026-07-24T00:00:00.000Z',
  updatedAt: '2026-07-24T00:00:00.000Z',
};
const archivedAutomation: Automation = {
  ...activeAutomation,
  id: 'archived',
  name: 'Legacy review',
  archivedAt: '2026-07-23T00:00:00.000Z',
};

it('lets viewers navigate active and archived automations without management controls', () => {
  const onSelect = vi.fn();
  render(
    <AutomationsSidebar
      archivedAutomationsOpen
      automations={[activeAutomation, archivedAutomation]}
      canCallApi
      canCreateAutomations={false}
      canManageTenantResources={false}
      footerProps={{} as never}
      loading={false}
      selectedAutomationId=""
      onArchiveAutomation={() => undefined}
      onArchivedAutomationsOpenChange={() => undefined}
      onBackToSessions={() => undefined}
      onCollapse={() => undefined}
      onCreateAutomation={() => undefined}
      onSelectAutomation={onSelect}
      onUnarchiveAutomation={() => undefined}
    />,
  );

  fireEvent.click(screen.getByText('Nightly review'));
  fireEvent.click(screen.getByText('Legacy review'));
  expect(onSelect).toHaveBeenNthCalledWith(1, 'active');
  expect(onSelect).toHaveBeenNthCalledWith(2, 'archived');
  expect(screen.getByRole('button', { name: 'New automation' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: /Archive .* automation/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Restore .* automation/ })).not.toBeInTheDocument();
});

it('shows automation details to viewers without edit, archive, or manual invoke actions', async () => {
  render(
    <AutomationsPanel
      automation={activeAutomation}
      automationsLoaded
      automationsLoading={false}
      canCallApi
      canCreateAutomations={false}
      canManageTenantResources={false}
      token=""
      environmentOptions={[]}
      environmentOptionsLoading={false}
      environmentOptionsError=""
      repositoryOptions={[]}
      repositoryOptionsLoading={false}
      repositoryOptionsError=""
      modelChoices={[]}
      defaultReasoningLevel=""
      selectedAutomationId="active"
      showOpenSidebar={false}
      loadInvocationPage={async () => ({ invocations: [] })}
      onAutomationChanged={() => undefined}
      onArchiveAutomation={() => undefined}
      onAutomationSaved={() => undefined}
      onOpenSidebar={() => undefined}
      onSessionCreated={() => undefined}
      onSelectSession={() => undefined}
      onUnarchiveAutomation={() => undefined}
      onError={(error) => {
        throw error;
      }}
    />,
  );

  expect(screen.getByLabelText('Name')).toHaveValue('Nightly review');
  expect(screen.getByLabelText('Name')).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Save automation' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: /Invoke now/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Archive automation/ })).not.toBeInTheDocument();
  expect(await screen.findByText('No invocations recorded yet.')).toBeVisible();
});
