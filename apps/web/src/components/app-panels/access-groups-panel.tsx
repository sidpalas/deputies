import { useEffect, useState } from 'react';
import type { SelectHTMLAttributes, SyntheticEvent } from 'react';
import { Archive, ChevronDown, CornerUpLeft, PanelLeftClose, PanelLeftOpen, Plus, Save, X } from 'lucide-react';
import type {
  AuthUser,
  AutomationCreateRequiredRole,
  Group,
  GroupMember,
  GroupRole,
  Health,
  Session,
  SessionVisibility,
  SessionWritePolicy,
} from '../../api.js';
import { cn } from '../../lib/utils.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Card } from '../ui/card.js';
import { Input } from '../ui/input.js';
import { ApiStatusFooter, ThemeToggle } from './session-sidebar.js';
import type { ConnectionStatus, ThemePreference } from './types.js';

const archivedGroupsOpenStorageKey = 'deputies-archived-groups-open';

export type AccessGroupFormState = {
  name: string;
  visibility: SessionVisibility;
  writePolicy: SessionWritePolicy;
  automationCreateRequiredRole: AutomationCreateRequiredRole;
  serverError: string;
};

export type AccessGroupUserSearchState = {
  query: string;
  loading: boolean;
  userId: string;
  options: AuthUser[];
};

export type AccessGroupMemberSearchState = AccessGroupUserSearchState & {
  role: GroupRole;
};

export function GroupsSidebar(props: {
  authRequired: boolean;
  canCreateGroups: boolean;
  canViewGroups: boolean;
  canViewAutomations: boolean;
  canViewSetup: boolean;
  connectionStatus: ConnectionStatus;
  currentUser: AuthUser | null;
  groups: Group[];
  health: Health | null;
  navPage: 'sessions' | 'setup' | 'groups' | 'automations';
  selectedGroupId: string;
  selectedView: 'group' | 'super_admins';
  superAdminUsers: AuthUser[];
  themePreference: ThemePreference;
  token: string;
  onBackToSessions: () => void;
  onCollapse: () => void;
  onCreateGroup: () => void;
  onOpenGroups: () => void;
  onOpenAutomations: () => void;
  onOpenSessions: () => void;
  onOpenSetup: () => void;
  onSelectGroup: (groupId: string) => void;
  onSelectSuperAdmins: () => void;
  onSignOut: () => void;
  onThemeChange: (value: ThemePreference) => void;
}) {
  const [groupSearch, setGroupSearch] = useState('');
  const [archivedGroupsOpen, setArchivedGroupsOpen] = useState(
    () => sessionStorage.getItem(archivedGroupsOpenStorageKey) === 'true',
  );
  const normalizedGroupSearch = groupSearch.trim().toLowerCase();
  const searchingGroups = Boolean(normalizedGroupSearch);
  const activeGroups = props.groups.filter(
    (group) => !group.archivedAt && (!searchingGroups || group.name.toLowerCase().includes(normalizedGroupSearch)),
  );
  const archivedGroups = props.groups.filter(
    (group) => group.archivedAt && (!searchingGroups || group.name.toLowerCase().includes(normalizedGroupSearch)),
  );
  const archivedOpen = searchingGroups || archivedGroupsOpen;
  const hasMatchingGroups = activeGroups.length > 0 || archivedGroups.length > 0;
  const currentUserIsSuperAdmin = props.currentUser?.role === 'super_admin';

  function handleArchivedGroupsToggle(event: SyntheticEvent<HTMLDetailsElement>) {
    if (searchingGroups) return;
    const open = event.currentTarget.open;
    sessionStorage.setItem(archivedGroupsOpenStorageKey, String(open));
    setArchivedGroupsOpen(open);
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <div className="mb-3 flex shrink-0 items-center gap-2">
        <Button
          className="shrink-0"
          variant="ghost"
          size="icon"
          onClick={props.onCollapse}
          aria-label="Hide sidebar"
          title="Hide sidebar"
        >
          <PanelLeftClose className="h-4 w-4" />
        </Button>
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">Access groups</h2>
        <div className="flex shrink-0 gap-2">
          <Button
            variant="secondary"
            size="icon"
            onClick={props.onBackToSessions}
            aria-label="Back to sessions"
            title="Back to sessions"
          >
            <CornerUpLeft className="h-4 w-4" />
          </Button>
          {props.canCreateGroups ? (
            <Button size="icon" onClick={props.onCreateGroup} aria-label="New group" title="New group">
              <Plus className="h-4 w-4" />
            </Button>
          ) : null}
        </div>
      </div>

      <div className="relative mb-3 shrink-0">
        <Input
          className="pr-9"
          value={groupSearch}
          onChange={(event) => setGroupSearch(event.target.value)}
          placeholder="Search groups..."
        />
        {groupSearch ? (
          <Button
            className="absolute right-1 top-1 h-8 w-8 p-0"
            variant="ghost"
            size="icon"
            onClick={() => setGroupSearch('')}
            aria-label="Clear group search"
            title="Clear group search"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        ) : null}
      </div>

      <div className="min-h-0 min-w-0 flex-1 overflow-auto">
        {props.canCreateGroups ? (
          <div className="mb-1 grid min-w-0 gap-1">
            <button
              type="button"
              className={cn(
                'group flex w-full min-w-0 items-center gap-2 overflow-hidden rounded-md border border-transparent p-2 text-left hover:bg-accent',
                props.selectedView === 'super_admins' && 'border-primary bg-primary/15',
              )}
              onClick={props.onSelectSuperAdmins}
            >
              <span className="block min-w-0 flex-1 overflow-hidden">
                <strong className="block w-full truncate text-sm font-medium text-foreground">
                  Manage super admins{currentUserIsSuperAdmin ? ' (you are one)' : ''}
                </strong>
                <span className="block w-full truncate text-xs text-muted-foreground">
                  {props.superAdminUsers.length} users
                </span>
              </span>
            </button>
          </div>
        ) : null}

        <div className={cn('mb-1', props.canCreateGroups && 'mt-4 border-t border-border pt-3')}>
          <h3 className="px-2 text-sm font-medium text-muted-foreground">Groups</h3>
        </div>

        {activeGroups.length ? (
          <div className="grid min-w-0 gap-1">
            {activeGroups.map((group) => (
              <GroupSidebarButton
                key={group.id}
                currentUser={props.currentUser}
                group={group}
                selected={props.selectedView === 'group' && group.id === props.selectedGroupId}
                onSelect={props.onSelectGroup}
              />
            ))}
          </div>
        ) : searchingGroups && !hasMatchingGroups ? (
          <p className="px-2 py-3 text-sm text-muted-foreground">No matching groups.</p>
        ) : !searchingGroups ? (
          <p className="px-2 py-3 text-sm text-muted-foreground">No access groups available.</p>
        ) : null}

        {archivedGroups.length ? (
          <details
            className="mt-4 border-t border-border pt-3"
            open={archivedOpen}
            onToggle={handleArchivedGroupsToggle}
          >
            <summary className="flex cursor-pointer items-center gap-1 text-sm font-medium text-muted-foreground">
              <ChevronDown className={cn('h-4 w-4 -rotate-90 transition-transform', archivedOpen && 'rotate-0')} />
              Archived groups · {archivedGroups.length}
            </summary>
            <div className="mt-2 grid min-w-0 gap-1 opacity-80">
              {archivedGroups.map((group) => (
                <GroupSidebarButton
                  key={group.id}
                  archived
                  currentUser={props.currentUser}
                  group={group}
                  selected={props.selectedView === 'group' && group.id === props.selectedGroupId}
                  onSelect={props.onSelectGroup}
                />
              ))}
            </div>
          </details>
        ) : null}
      </div>

      <ThemeToggle preference={props.themePreference} onChange={props.onThemeChange} />
      <ApiStatusFooter
        authRequired={props.authRequired}
        canViewGroups={props.canViewGroups}
        canViewAutomations={props.canViewAutomations}
        canViewSetup={props.canViewSetup}
        health={props.health}
        navPage={props.navPage}
        token={props.token}
        onOpenGroups={props.onOpenGroups}
        onOpenAutomations={props.onOpenAutomations}
        onOpenSessions={props.onOpenSessions}
        onOpenSetup={props.onOpenSetup}
        onSignOut={props.onSignOut}
      />
    </div>
  );
}

function GroupSidebarButton(props: {
  archived?: boolean;
  currentUser: AuthUser | null;
  group: Group;
  selected: boolean;
  onSelect: (groupId: string) => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        'group flex w-full min-w-0 items-center gap-2 overflow-hidden rounded-md border border-transparent p-2 text-left hover:bg-accent',
        props.selected && 'border-primary bg-primary/15',
      )}
      onClick={() => props.onSelect(props.group.id)}
    >
      <span className="block min-w-0 flex-1 overflow-hidden">
        <strong className="block w-full truncate text-sm font-medium text-foreground">{props.group.name}</strong>
        <span className="block w-full truncate text-xs text-muted-foreground">
          {props.archived ? 'Archived · ' : ''}
          {groupAccessLabel(props.group, props.currentUser)}
        </span>
      </span>
    </button>
  );
}

export function GroupsPanel(props: {
  canCreateGroups: boolean;
  currentUser: AuthUser | null;
  groupMembers: GroupMember[];
  groups: Group[];
  groupForm: AccessGroupFormState;
  groupFormError: string;
  memberSearch: AccessGroupMemberSearchState;
  selectedGroupId: string;
  selectedView: 'group' | 'super_admins';
  superAdminSearch: AccessGroupUserSearchState;
  superAdminUsers: AuthUser[];
  showOpenSidebar: boolean;
  onAddMember: () => void;
  onArchiveGroup: (groupId: string, archived: boolean) => void;
  onCreateGroup: () => void;
  onGroupFormAutomationCreateRequiredRoleChange: (value: AutomationCreateRequiredRole) => void;
  onGroupFormNameChange: (value: string) => void;
  onGroupFormVisibilityChange: (value: SessionVisibility) => void;
  onGroupFormWritePolicyChange: (value: SessionWritePolicy) => void;
  onMemberRoleChange: (value: GroupRole) => void;
  onMemberSearchQueryChange: (value: string) => void;
  onMemberUserIdChange: (value: string) => void;
  onOpenSidebar: () => void;
  onPromoteSuperAdmin: () => void;
  onRemoveMember: (userId: string) => void;
  onRemoveSuperAdmin: (userId: string) => void;
  onSaveGroup: () => void;
  onSelectGroup: (groupId: string) => void;
  onSelectMemberUser: (userId: string) => void;
  onSelectSuperAdminUser: (userId: string) => void;
  onSelectSuperAdmins: () => void;
  onSuperAdminSearchQueryChange: (value: string) => void;
  onSuperAdminUserIdChange: (value: string) => void;
  onUpdateMemberRole: (userId: string, role: GroupRole) => void;
}) {
  const selectedGroup = props.groups.find((group) => group.id === props.selectedGroupId) ?? null;
  const selectedMemberUser = props.memberSearch.options.find((user) => user.id === props.memberSearch.userId);
  const selectedSuperAdminUser = props.superAdminSearch.options.find(
    (user) => user.id === props.superAdminSearch.userId,
  );

  return (
    <section className="h-full overflow-auto px-3 py-6 md:px-8 xl:px-20">
      <div className="mx-auto max-w-4xl">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-start gap-2">
            {props.showOpenSidebar ? (
              <Button
                className="mt-1 h-8 w-8 shrink-0 p-0 md:hidden"
                variant="ghost"
                size="icon"
                onClick={props.onOpenSidebar}
                aria-label="Open access groups"
                title="Open access groups"
              >
                <PanelLeftOpen className="h-4 w-4" />
              </Button>
            ) : null}
            <div>
              <p className="text-sm font-medium text-muted-foreground">Access control</p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight">Access groups</h1>
              <p className="mt-1 text-sm text-muted-foreground">Manage access groups and user roles.</p>
            </div>
          </div>
        </div>
        <div className="grid content-start gap-4">
          {props.selectedView === 'super_admins' && props.canCreateGroups ? (
            <SuperAdminsPanel
              currentUser={props.currentUser}
              search={props.superAdminSearch}
              selectedUser={selectedSuperAdminUser}
              superAdminUsers={props.superAdminUsers}
              onPromoteSuperAdmin={props.onPromoteSuperAdmin}
              onRemoveSuperAdmin={props.onRemoveSuperAdmin}
              onSearchQueryChange={props.onSuperAdminSearchQueryChange}
              onSelectUser={props.onSelectSuperAdminUser}
              onUserIdChange={props.onSuperAdminUserIdChange}
            />
          ) : selectedGroup ? (
            selectedGroup.canManage ? (
              <ManagedGroupPanel
                group={selectedGroup}
                currentUser={props.currentUser}
                groupForm={props.groupForm}
                groupFormError={props.groupFormError}
                groupMembers={props.groupMembers}
                memberSearch={props.memberSearch}
                selectedMemberUser={selectedMemberUser}
                onAddMember={props.onAddMember}
                onArchiveGroup={props.onArchiveGroup}
                onGroupFormAutomationCreateRequiredRoleChange={props.onGroupFormAutomationCreateRequiredRoleChange}
                onGroupFormNameChange={props.onGroupFormNameChange}
                onGroupFormVisibilityChange={props.onGroupFormVisibilityChange}
                onGroupFormWritePolicyChange={props.onGroupFormWritePolicyChange}
                onMemberRoleChange={props.onMemberRoleChange}
                onMemberSearchQueryChange={props.onMemberSearchQueryChange}
                onMemberUserIdChange={props.onMemberUserIdChange}
                onRemoveMember={props.onRemoveMember}
                onSaveGroup={props.onSaveGroup}
                onSelectMemberUser={props.onSelectMemberUser}
                onUpdateMemberRole={props.onUpdateMemberRole}
              />
            ) : (
              <ReadOnlyGroupPanel currentUser={props.currentUser} group={selectedGroup} />
            )
          ) : (
            <Card className="p-5 text-sm text-muted-foreground">Select an access group to view your access.</Card>
          )}
        </div>
      </div>
    </section>
  );
}

function SuperAdminsPanel(props: {
  currentUser: AuthUser | null;
  search: AccessGroupUserSearchState;
  selectedUser: AuthUser | undefined;
  superAdminUsers: AuthUser[];
  onPromoteSuperAdmin: () => void;
  onRemoveSuperAdmin: (userId: string) => void;
  onSearchQueryChange: (value: string) => void;
  onSelectUser: (userId: string) => void;
  onUserIdChange: (value: string) => void;
}) {
  return (
    <Card className="p-4">
      <h2 className="text-lg font-semibold">Super admins</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Super admins can manage all access groups, users, and access defaults.
      </p>
      <div className="mt-4 grid gap-2">
        {props.superAdminUsers.map((user) => {
          const self = user.id === props.currentUser?.id;
          return (
            <div
              key={user.id}
              className="grid gap-2 rounded-md border border-border p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
            >
              <div className="min-w-0">
                <strong className="block truncate text-sm">{user.displayName || user.username}</strong>
                <p className="truncate text-xs text-muted-foreground">
                  {user.username} · {user.id}
                </p>
              </div>
              <Button variant="secondary" size="sm" onClick={() => props.onRemoveSuperAdmin(user.id)} disabled={self}>
                {self ? 'Current user' : 'Remove'}
              </Button>
            </div>
          );
        })}
        {!props.superAdminUsers.length ? <p className="text-sm text-muted-foreground">No super admins found.</p> : null}
      </div>
      <div className="mt-4 grid gap-3 rounded-md border border-border bg-muted/30 p-3">
        <label className="grid gap-1 text-sm">
          <span className="text-xs font-medium text-muted-foreground">Find user</span>
          <Input
            value={props.search.query}
            onChange={(event) => props.onSearchQueryChange(event.target.value)}
            placeholder="Search by username, display name, or exact user ID"
          />
        </label>
        {props.search.query.trim().length < 2 ? (
          <p className="text-xs text-muted-foreground">Type at least 2 characters to search users.</p>
        ) : props.search.loading ? (
          <p className="text-xs text-muted-foreground">Searching users...</p>
        ) : props.search.options.length ? (
          <UserOptions users={props.search.options} showRoles onSelectUser={props.onSelectUser} />
        ) : (
          <p className="text-xs text-muted-foreground">No matching users.</p>
        )}
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
          <label className="grid gap-1 text-sm">
            <span className="text-xs font-medium text-muted-foreground">User ID</span>
            <Input
              value={props.search.userId}
              onChange={(event) => props.onUserIdChange(event.target.value)}
              placeholder="Select a user or paste user ID"
            />
            {props.selectedUser ? <SelectedUserSummary user={props.selectedUser} /> : null}
          </label>
          <Button
            className="sm:mt-5"
            onClick={props.onPromoteSuperAdmin}
            disabled={!props.search.userId.trim() || props.selectedUser?.role === 'super_admin'}
          >
            Promote
          </Button>
        </div>
      </div>
    </Card>
  );
}

function ManagedGroupPanel(props: {
  currentUser: AuthUser | null;
  group: Group;
  groupForm: AccessGroupFormState;
  groupFormError: string;
  groupMembers: GroupMember[];
  memberSearch: AccessGroupMemberSearchState;
  selectedMemberUser: AuthUser | undefined;
  onAddMember: () => void;
  onArchiveGroup: (groupId: string, archived: boolean) => void;
  onGroupFormAutomationCreateRequiredRoleChange: (value: AutomationCreateRequiredRole) => void;
  onGroupFormNameChange: (value: string) => void;
  onGroupFormVisibilityChange: (value: SessionVisibility) => void;
  onGroupFormWritePolicyChange: (value: SessionWritePolicy) => void;
  onMemberRoleChange: (value: GroupRole) => void;
  onMemberSearchQueryChange: (value: string) => void;
  onMemberUserIdChange: (value: string) => void;
  onRemoveMember: (userId: string) => void;
  onSaveGroup: () => void;
  onSelectMemberUser: (userId: string) => void;
  onUpdateMemberRole: (userId: string, role: GroupRole) => void;
}) {
  return (
    <>
      <Card className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Access group settings</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Defaults apply when new sessions are created in this access group.
            </p>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            {props.group.archivedAt ? <Badge>Archived</Badge> : null}
            <Badge>{groupAccessLabel(props.group, props.currentUser)}</Badge>
          </div>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <label className="grid gap-1 text-sm sm:col-span-3">
            <span className="text-xs font-medium text-muted-foreground">Name</span>
            <Input
              value={props.groupForm.name}
              onChange={(event) => props.onGroupFormNameChange(event.target.value)}
              aria-invalid={Boolean(props.groupFormError)}
            />
            {props.groupFormError ? (
              <span className="text-xs text-destructive" role="alert">
                {props.groupFormError}
              </span>
            ) : null}
          </label>
          <label className="grid gap-1 text-sm">
            <span className="text-xs font-medium text-muted-foreground">Default visibility</span>
            <SelectWithCaret
              value={props.groupForm.visibility}
              onChange={(event) => props.onGroupFormVisibilityChange(event.target.value as SessionVisibility)}
            >
              <option value="organization">Organization</option>
              <option value="group">Group only</option>
            </SelectWithCaret>
          </label>
          <label className="grid gap-1 text-sm sm:col-span-2">
            <span className="text-xs font-medium text-muted-foreground">Default write policy</span>
            <SelectWithCaret
              value={props.groupForm.writePolicy}
              onChange={(event) => props.onGroupFormWritePolicyChange(event.target.value as SessionWritePolicy)}
            >
              <option value="group_members">Group members</option>
              <option value="creator_only">Creator only</option>
            </SelectWithCaret>
          </label>
          <label className="grid gap-1 text-sm sm:col-span-3">
            <span className="text-xs font-medium text-muted-foreground">Automation creation</span>
            <SelectWithCaret
              value={props.groupForm.automationCreateRequiredRole}
              onChange={(event) =>
                props.onGroupFormAutomationCreateRequiredRoleChange(event.target.value as AutomationCreateRequiredRole)
              }
            >
              <option value="member">Members and admins</option>
              <option value="admin">Admins only</option>
            </SelectWithCaret>
            <span className="text-xs text-muted-foreground">
              Controls who can create new scheduled automations in this group.
            </span>
          </label>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button onClick={props.onSaveGroup} disabled={!props.groupForm.name.trim() || Boolean(props.groupFormError)}>
            <Save className="h-4 w-4" /> Save group
          </Button>
          <Button
            className={cn(
              !props.group.archivedAt &&
                'border-destructive/30 bg-transparent text-destructive hover:bg-destructive/10',
            )}
            variant="secondary"
            onClick={() => props.onArchiveGroup(props.group.id, !props.group.archivedAt)}
          >
            <Archive className="h-4 w-4" /> {props.group.archivedAt ? 'Unarchive group' : 'Archive group'}
          </Button>
        </div>
      </Card>

      <Card className="p-4">
        <h2 className="text-lg font-semibold">Members</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Viewers can read group-only sessions. Members can create and write group-member sessions. Admins manage this
          access group.
        </p>
        <div className="mt-4 grid gap-2">
          {props.groupMembers.map((member) => (
            <div
              key={member.userId}
              className="grid gap-2 rounded-md border border-border p-3 sm:grid-cols-[minmax(0,1fr)_10rem_auto] sm:items-center"
            >
              <div className="min-w-0">
                <strong className="block truncate text-sm">
                  {member.user?.displayName || member.user?.username || member.userId}
                </strong>
                <p className="truncate text-xs text-muted-foreground">
                  {member.user?.username ? member.userId : 'User ID'}
                </p>
              </div>
              <SelectWithCaret
                className="h-9"
                value={member.role}
                onChange={(event) => props.onUpdateMemberRole(member.userId, event.target.value as GroupRole)}
              >
                <option value="viewer">Viewer</option>
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </SelectWithCaret>
              <Button variant="secondary" size="sm" onClick={() => props.onRemoveMember(member.userId)}>
                Remove
              </Button>
            </div>
          ))}
          {!props.groupMembers.length ? <p className="text-sm text-muted-foreground">No members yet.</p> : null}
        </div>
        <div className="mt-4 grid gap-3 rounded-md border border-border bg-muted/30 p-3">
          <label className="grid gap-1 text-sm">
            <span className="text-xs font-medium text-muted-foreground">Find user</span>
            <Input
              value={props.memberSearch.query}
              onChange={(event) => props.onMemberSearchQueryChange(event.target.value)}
              placeholder="Search by username, display name, or exact user ID"
            />
          </label>
          {props.memberSearch.query.trim().length < 2 ? (
            <p className="text-xs text-muted-foreground">Type at least 2 characters to search users.</p>
          ) : props.memberSearch.loading ? (
            <p className="text-xs text-muted-foreground">Searching users...</p>
          ) : props.memberSearch.options.length ? (
            <UserOptions users={props.memberSearch.options} onSelectUser={props.onSelectMemberUser} />
          ) : (
            <p className="text-xs text-muted-foreground">No matching users.</p>
          )}
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_10rem_auto] sm:items-start">
            <label className="grid gap-1 text-sm">
              <span className="text-xs font-medium text-muted-foreground">User ID</span>
              <Input
                value={props.memberSearch.userId}
                onChange={(event) => props.onMemberUserIdChange(event.target.value)}
                placeholder="Select a user or paste user ID"
              />
              {props.selectedMemberUser ? <SelectedUserSummary user={props.selectedMemberUser} /> : null}
            </label>
            <label className="grid gap-1 text-sm">
              <span className="text-xs font-medium text-muted-foreground">Role</span>
              <SelectWithCaret
                value={props.memberSearch.role}
                onChange={(event) => props.onMemberRoleChange(event.target.value as GroupRole)}
              >
                <option value="viewer">Viewer</option>
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </SelectWithCaret>
            </label>
            <Button className="sm:mt-5" onClick={props.onAddMember} disabled={!props.memberSearch.userId.trim()}>
              Add member
            </Button>
          </div>
        </div>
      </Card>
    </>
  );
}

function ReadOnlyGroupPanel(props: { currentUser: AuthUser | null; group: Group }) {
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{props.group.name}</h2>
          <p className="mt-1 text-sm text-muted-foreground">Your access in this access group.</p>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          {props.group.archivedAt ? <Badge>Archived</Badge> : null}
          <Badge>{groupAccessLabel(props.group, props.currentUser)}</Badge>
        </div>
      </div>
      <div className="mt-4 grid gap-2 text-sm text-muted-foreground sm:grid-cols-2">
        <div className="rounded-md border border-border p-3">
          <strong className="block text-foreground">Default visibility</strong>
          <span>{sessionVisibilityLabel(props.group.defaultVisibility)}</span>
        </div>
        <div className="rounded-md border border-border p-3">
          <strong className="block text-foreground">Default writes</strong>
          <span>{sessionWritePolicyLabel(props.group.defaultWritePolicy)}</span>
        </div>
        <div className="rounded-md border border-border p-3 sm:col-span-2">
          <strong className="block text-foreground">Automation creation</strong>
          <span>{automationCreateRequiredRoleLabel(props.group.automationCreateRequiredRole)}</span>
        </div>
      </div>
    </Card>
  );
}

export function SessionAccessPanel(props: {
  canManageAccess: boolean;
  groups: Group[];
  session: Session;
  onUpdateAccess: (input: { ownerGroupId: string }) => Promise<boolean>;
}) {
  const [ownerGroupId, setOwnerGroupId] = useState(props.session.ownerGroupId);
  const [saving, setSaving] = useState(false);
  const ownerGroup = props.groups.find((group) => group.id === props.session.ownerGroupId);
  const ownerGroupName = ownerGroup
    ? groupDisplayName(ownerGroup)
    : (props.session.ownerGroupName ?? 'Unknown access group');
  const editableGroups = props.groups.filter(
    (group) => group.id === props.session.ownerGroupId || (group.canManage && !group.archivedAt),
  );

  useEffect(() => {
    setOwnerGroupId(props.session.ownerGroupId);
  }, [props.session.id, props.session.ownerGroupId]);

  async function handleOwnerGroupChange(nextOwnerGroupId: string) {
    if (!props.canManageAccess || saving || nextOwnerGroupId === props.session.ownerGroupId) {
      setOwnerGroupId(nextOwnerGroupId);
      return;
    }

    setOwnerGroupId(nextOwnerGroupId);
    setSaving(true);
    try {
      const saved = await props.onUpdateAccess({ ownerGroupId: nextOwnerGroupId });
      if (!saved) setOwnerGroupId(props.session.ownerGroupId);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-2 text-xs text-muted-foreground">
      <div className="grid gap-2">
        <label className="grid gap-1">
          <span className="font-medium text-foreground">Access group</span>
          {props.canManageAccess ? (
            <SelectWithCaret
              className="h-8 min-w-0 pl-2 text-sm text-foreground"
              value={ownerGroupId}
              onChange={(event) => handleOwnerGroupChange(event.target.value)}
              disabled={saving}
            >
              {editableGroups.map((group) => (
                <option key={group.id} value={group.id} disabled={!group.canManage || Boolean(group.archivedAt)}>
                  {groupDisplayName(group)}
                </option>
              ))}
            </SelectWithCaret>
          ) : (
            <span className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground">
              {ownerGroupName}
            </span>
          )}
        </label>
        {saving ? <p className="text-xs text-muted-foreground">Saving...</p> : null}
      </div>
    </div>
  );
}

function groupDisplayName(group: Group): string {
  return group.archivedAt ? `${group.name} (archived)` : group.name;
}

function UserOptions(props: { showRoles?: boolean; users: AuthUser[]; onSelectUser: (userId: string) => void }) {
  return (
    <div className="grid max-h-40 gap-1 overflow-auto rounded-md border border-border bg-background p-1">
      {props.users.map((user) => (
        <button
          key={user.id}
          type="button"
          className="rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
          onClick={() => props.onSelectUser(user.id)}
        >
          {props.showRoles ? (
            <span className="flex items-center justify-between gap-2">
              <strong className="min-w-0 truncate">{user.displayName || user.username}</strong>
              <Badge>{authRoleLabel(user.role)}</Badge>
            </span>
          ) : (
            <strong className="block truncate">{user.displayName || user.username}</strong>
          )}
          <span className="block truncate text-xs text-muted-foreground">
            {user.username} · {user.id}
          </span>
        </button>
      ))}
    </div>
  );
}

function SelectedUserSummary(props: { user: AuthUser }) {
  return (
    <p className="mt-1 truncate text-xs text-muted-foreground">
      Selected user: {props.user.displayName || props.user.username}
    </p>
  );
}

function SelectWithCaret(props: SelectHTMLAttributes<HTMLSelectElement>) {
  const { className, children, ...selectProps } = props;

  return (
    <span className="relative block min-w-0">
      <select
        {...selectProps}
        className={cn(
          'h-10 w-full appearance-none rounded-md border border-input bg-background pl-3 pr-11 text-sm text-foreground disabled:opacity-70',
          className,
        )}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
    </span>
  );
}

function groupRoleLabel(role: GroupRole): string {
  if (role === 'admin') return 'Admin';
  if (role === 'member') return 'Member';
  return 'Viewer';
}

function groupAccessLabel(group: Group, user: AuthUser | null): string {
  const membership = group.membershipRole ? groupRoleLabel(group.membershipRole) : 'None';
  if (user?.role === 'super_admin') return `${membership} (+ super admin)`;
  if (group.membershipRole) return membership;
  return 'No membership';
}

function sessionVisibilityLabel(visibility: SessionVisibility): string {
  return visibility === 'organization' ? 'Organization' : 'Group only';
}

function sessionWritePolicyLabel(policy: SessionWritePolicy): string {
  return policy === 'group_members' ? 'Group members' : 'Creator only';
}

function automationCreateRequiredRoleLabel(role: AutomationCreateRequiredRole): string {
  return role === 'admin' ? 'Admins only' : 'Members and admins';
}

function authRoleLabel(role: AuthUser['role']): string {
  return role === 'super_admin' ? 'Super admin' : 'User';
}
