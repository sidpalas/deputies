import { useState } from 'react';
import type { Group } from '../../api.js';
import { Input } from '../ui/input.js';

export function SharingGroupPicker(props: {
  groups: Group[];
  ownerGroupId: string;
  selectedGroupIds: string[];
  disabled: boolean;
  onSelectedGroupIdsChange: (groupIds: string[]) => void;
}) {
  const [search, setSearch] = useState('');
  const activeGroups = props.groups.filter((group) => !group.archivedAt);
  const activeGroupIds = new Set(activeGroups.map((group) => group.id));
  const groupsById = new Map(props.groups.map((group) => [group.id, group]));
  const unavailableSelectedGroups = props.selectedGroupIds
    .filter((groupId) => !activeGroupIds.has(groupId))
    .map((groupId) => ({ id: groupId, group: groupsById.get(groupId) }));
  const normalizedSearch = search.trim().toLowerCase();
  const filteredGroups = activeGroups.filter((group) => group.name.toLowerCase().includes(normalizedSearch));
  const selectedCount = new Set([
    ...(activeGroupIds.has(props.ownerGroupId) ? [props.ownerGroupId] : []),
    ...props.selectedGroupIds,
  ]).size;

  return (
    <div className="rounded-md border border-border bg-background/70 p-3">
      <p className="text-sm text-muted-foreground">{selectedCount} selected</p>
      {unavailableSelectedGroups.length ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {unavailableSelectedGroups.map(({ id, group }) => (
            <label key={id} className="flex items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                checked
                onChange={() =>
                  props.onSelectedGroupIdsChange(props.selectedGroupIds.filter((groupId) => groupId !== id))
                }
                disabled={props.disabled}
              />
              <span className="min-w-0 truncate">
                {group ? `${group.name} (archived)` : `Unavailable group (${id.slice(-8)})`}
              </span>
            </label>
          ))}
        </div>
      ) : null}
      {activeGroups.length ? (
        <Input
          className="mt-3"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search groups..."
        />
      ) : null}
      {filteredGroups.length ? (
        <div className="mt-3 grid max-h-56 gap-2 overflow-auto pr-1 sm:grid-cols-2">
          {filteredGroups.map((group) => {
            const owner = group.id === props.ownerGroupId;
            return (
              <label key={group.id} className="flex items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={owner || props.selectedGroupIds.includes(group.id)}
                  onChange={(event) =>
                    props.onSelectedGroupIdsChange(
                      event.target.checked
                        ? [...new Set([...props.selectedGroupIds, group.id])]
                        : props.selectedGroupIds.filter((id) => id !== group.id),
                    )
                  }
                  disabled={props.disabled || owner}
                />
                <span className="min-w-0 truncate">
                  {group.name}
                  {owner ? ' (owner)' : ''}
                </span>
              </label>
            );
          })}
        </div>
      ) : activeGroups.length ? (
        <p className="mt-3 text-sm text-muted-foreground">No matching groups.</p>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">No active groups are available.</p>
      )}
    </div>
  );
}
