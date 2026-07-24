import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import type { Environment } from './api.js';
import { EnvironmentsPanel } from './components/app-panels/environments-panel.js';
import { EnvironmentsSidebar } from './components/app-panels/environments-sidebar.js';

const environment: Environment = {
  id: 'environment-1',
  name: 'Production',
  currentRevisionId: 'revision-2',
  currentRevisionNumber: 2,
  repositories: [
    {
      id: 'repository-1',
      provider: 'github',
      owner: 'acme',
      repo: 'widget',
      primary: true,
      position: 0,
    },
  ],
  canManage: true,
  createdAt: '2026-07-16T10:00:00.000Z',
  updatedAt: '2026-07-16T10:00:00.000Z',
};

afterEach(() => vi.restoreAllMocks());

it('provides quick archive and restore actions', () => {
  const onArchiveEnvironment = vi.fn();
  const onRestoreEnvironment = vi.fn();
  const archived = {
    ...environment,
    id: 'environment-2',
    name: 'Legacy',
    archivedAt: '2026-07-16T11:00:00.000Z',
  };

  render(
    <EnvironmentsSidebar
      canCallApi
      canCreateEnvironments
      environments={[environment, archived]}
      footerProps={sidebarFooterProps('environments')}
      loading={false}
      selectedEnvironmentId=""
      onArchiveEnvironment={onArchiveEnvironment}
      onBackToSessions={() => undefined}
      onCollapse={() => undefined}
      onCreateEnvironment={() => undefined}
      onRestoreEnvironment={onRestoreEnvironment}
      onSelectEnvironment={() => undefined}
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: 'Archive Production environment' }));
  expect(onArchiveEnvironment).toHaveBeenCalledWith(environment.id);

  fireEvent.click(screen.getByText('Archived · 1'));
  fireEvent.click(screen.getByRole('button', { name: 'Restore Legacy environment' }));
  expect(onRestoreEnvironment).toHaveBeenCalledWith(archived.id);
});

it('marks environment edits as unsaved without displacing the archive action', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    jsonResponse({ revisions: [environmentRevision('revision-2', 2, 'widget')] }),
  );
  const onDirtyChange = vi.fn();
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  render(
    <EnvironmentsPanel
      environments={[environment]}
      environmentsLoading={false}
      environmentsError=""
      selectedEnvironmentId={environment.id}
      selectedRevisionId=""
      canCallApi
      canManageTenantResources
      token=""
      repositoryOptions={[]}
      repositoryOptionsLoading={false}
      repositoryOptionsError=""
      showOpenSidebar={false}
      onCreateEnvironment={() => true}
      onDirtyChange={onDirtyChange}
      onEnvironmentChanged={() => undefined}
      onOpenSidebar={() => undefined}
      onSelectRevision={() => undefined}
      onError={() => undefined}
    />,
  );

  expect(await screen.findByLabelText('Revision')).toHaveTextContent('Revision 2');
  expect(screen.getByRole('button', { name: 'Save environment' })).toBeDisabled();
  expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Production v2' } });
  expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save environment' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
  expect(confirm).toHaveBeenCalledWith('Discard unsaved changes and archive this environment?');
});

it('shows historical repositories with current access fields and makes the whole editor read-only', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    jsonResponse({
      revisions: [environmentRevision('revision-2', 2, 'widget'), environmentRevision('revision-1', 1, 'legacy')],
    }),
  );

  function Harness() {
    const [selectedRevisionId, setSelectedRevisionId] = useState('revision-1');
    return (
      <EnvironmentsPanel
        {...environmentPanelProps()}
        selectedRevisionId={selectedRevisionId}
        onSelectRevision={setSelectedRevisionId}
      />
    );
  }

  render(<Harness />);

  expect(await screen.findByText(/The name reflects the current environment/)).toBeInTheDocument();
  expect(screen.getByLabelText('Name')).toHaveValue('Production');
  await waitFor(() => expect(screen.getByLabelText('Repository 1')).toHaveTextContent('acme/legacy'));
  expect(screen.getByLabelText('Name')).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Add repo' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Save environment' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Archive' })).toBeDisabled();

  fireEvent.click(screen.getByLabelText('Revision'));
  fireEvent.click(screen.getByTitle('Revision 2'));

  await waitFor(() => expect(screen.getByLabelText('Repository 1')).toHaveTextContent('acme/widget'));
  expect(screen.getByLabelText('Name')).toBeEnabled();
});

it('falls back to current repositories when a requested revision is missing', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    jsonResponse({ revisions: [environmentRevision('revision-2', 2, 'widget')] }),
  );
  render(<EnvironmentsPanel {...environmentPanelProps()} selectedRevisionId="missing-revision" />);

  expect(
    await screen.findByText('The requested revision is unavailable. Showing the current repository configuration.'),
  ).toBeInTheDocument();
  expect(screen.getByLabelText('Repository 1')).toHaveTextContent('acme/widget');
  expect(screen.getByLabelText('Name')).toBeEnabled();
});

it('allows environment readers to inspect revisions without granting edit access', async () => {
  const fetchMock = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(jsonResponse({ revisions: [environmentRevision('revision-2', 2, 'widget')] }));
  render(<EnvironmentsPanel {...environmentPanelProps()} environments={[{ ...environment, canManage: false }]} />);

  expect(await screen.findByLabelText('Revision')).toHaveTextContent('Revision 2');
  expect(screen.getByLabelText('Name')).toBeDisabled();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('lets viewers browse environment revisions without create or edit controls', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    jsonResponse({ revisions: [environmentRevision('revision-2', 2, 'widget')] }),
  );
  render(
    <EnvironmentsPanel
      {...environmentPanelProps()}
      canManageTenantResources={false}
      environments={[{ ...environment, canManage: false }]}
    />,
  );

  expect(await screen.findByLabelText('Revision')).toHaveTextContent('Revision 2');
  expect(screen.getByRole('button', { name: 'New environment' })).toBeDisabled();
  expect(screen.getByLabelText('Name')).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Save environment' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();
});

function environmentPanelProps() {
  return {
    environments: [environment],
    environmentsLoading: false,
    environmentsError: '',
    selectedEnvironmentId: environment.id,
    selectedRevisionId: '',
    canCallApi: true,
    canManageTenantResources: true,
    token: 'test-token',
    repositoryOptions: [
      { fullName: 'acme/widget', owner: 'acme', name: 'widget' },
      { fullName: 'acme/legacy', owner: 'acme', name: 'legacy' },
    ],
    repositoryOptionsLoading: false,
    repositoryOptionsError: '',
    showOpenSidebar: false,
    onCreateEnvironment: () => true,
    onDirtyChange: () => undefined,
    onEnvironmentChanged: () => undefined,
    onOpenSidebar: () => undefined,
    onSelectRevision: () => undefined,
    onError: (error: unknown) => {
      throw error;
    },
  };
}

function sidebarFooterProps(navPage: 'environments' | 'skills') {
  return {
    authRequired: true,
    canViewGroups: true,
    canViewAutomations: true,
    canViewEnvironments: true,
    canViewSkills: true,
    canViewSetup: true,
    health: null,
    navPage,
    themePreference: 'system' as const,
    token: '',
    onOpenGroups: () => undefined,
    onOpenAutomations: () => undefined,
    onOpenEnvironments: () => undefined,
    onOpenSkills: () => undefined,
    onOpenSessions: () => undefined,
    onOpenSetup: () => undefined,
    onSignOut: () => undefined,
    onThemeChange: () => undefined,
  };
}

function environmentRevision(id: string, revisionNumber: number, repo: string) {
  return {
    id,
    environmentId: environment.id,
    revisionNumber,
    actorType: 'user',
    createdAt: `2026-07-${revisionNumber === 2 ? '16' : '15'}T10:00:00.000Z`,
    repositories: [{ provider: 'github', owner: 'acme', repo, primary: true, position: 0 }],
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
