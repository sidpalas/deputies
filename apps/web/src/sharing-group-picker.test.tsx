import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Group } from './api.js';
import { SharingGroupPicker } from './components/app-panels/sharing-group-picker.js';

const groupDefaults = {
  defaultVisibility: 'organization' as const,
  defaultWritePolicy: 'group_members' as const,
  automationCreateRequiredRole: 'member' as const,
  canCreateSessions: true,
  canCreateAutomations: true,
  canManage: true,
  createdAt: '2026-07-16T10:00:00.000Z',
  updatedAt: '2026-07-16T10:00:00.000Z',
};
const groups: Group[] = [
  { ...groupDefaults, id: 'owner', name: 'Platform' },
  { ...groupDefaults, id: 'target', name: 'Product' },
];

it('searches groups while keeping the owner selected', () => {
  const onChange = vi.fn();
  render(
    <SharingGroupPicker
      groups={groups}
      ownerGroupId="owner"
      selectedGroupIds={[]}
      disabled={false}
      onSelectedGroupIdsChange={onChange}
    />,
  );

  expect(screen.getByRole('checkbox', { name: 'Platform (owner)' })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'Platform (owner)' })).toBeDisabled();
  fireEvent.change(screen.getByPlaceholderText('Search groups...'), { target: { value: 'prod' } });
  expect(screen.queryByText('Platform (owner)')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Product' }));
  expect(onChange).toHaveBeenCalledWith(['target']);
});

it('keeps archived and inaccessible selected groups visible and removable', () => {
  function Harness() {
    const [selectedGroupIds, setSelectedGroupIds] = useState(['archived', 'inaccessible']);
    return (
      <SharingGroupPicker
        groups={[
          ...groups,
          { ...groupDefaults, id: 'archived', name: 'Legacy', archivedAt: '2026-07-16T11:00:00.000Z' },
        ]}
        ownerGroupId="owner"
        selectedGroupIds={selectedGroupIds}
        disabled={false}
        onSelectedGroupIdsChange={setSelectedGroupIds}
      />
    );
  }

  render(<Harness />);

  expect(screen.getByRole('checkbox', { name: 'Legacy (archived)' })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: /Unavailable group/ })).toBeChecked();
  expect(screen.getByText('3 selected')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('checkbox', { name: 'Product' }));
  expect(screen.getByText('4 selected')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('checkbox', { name: /Unavailable group/ }));
  expect(screen.queryByRole('checkbox', { name: /Unavailable group/ })).not.toBeInTheDocument();
  expect(screen.getByText('3 selected')).toBeInTheDocument();
});

it('shows unavailable selections when there are no active groups', () => {
  render(
    <SharingGroupPicker
      groups={[]}
      ownerGroupId="owner"
      selectedGroupIds={['inaccessible']}
      disabled={false}
      onSelectedGroupIdsChange={() => undefined}
    />,
  );

  expect(screen.getByRole('checkbox', { name: /Unavailable group/ })).toBeChecked();
  expect(screen.getByText('No active groups are available.')).toBeInTheDocument();
});
