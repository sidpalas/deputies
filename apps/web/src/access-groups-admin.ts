import { useEffect, useMemo, useState } from 'react';

import {
  ApiError,
  createGroup,
  listGroupMembers,
  listUsers,
  removeGroupMember,
  updateGroup,
  updateUserRole,
  upsertGroupMember,
  type AuthUser,
  type AutomationCreateRequiredRole,
  type Group,
  type GroupMember,
  type GroupRole,
  type SessionVisibility,
  type SessionWritePolicy,
} from './api.js';
import { groupNameValidationError, upsertAuthUser } from './app-state.js';
import type {
  AccessGroupFormState,
  AccessGroupMemberSearchState,
  AccessGroupUserSearchState,
} from './components/app-panels.js';

type GroupsPanelView = 'group' | 'super_admins' | 'new_group';
type StateUpdate<T> = T | ((current: T) => T);

type AccessGroupsState = {
  groupForm: AccessGroupFormState;
  memberSearch: AccessGroupMemberSearchState;
  superAdminSearch: AccessGroupUserSearchState;
  roleManagementUsers: AuthUser[];
};

type UseAccessGroupsAdminInput = {
  canManageAllGroups: boolean;
  currentUser: AuthUser | null;
  groups: Group[];
  groupsPanelOpen: boolean;
  groupsPanelView: GroupsPanelView;
  selectedGroupId: string;
  token: string;
  handleApiError: (err: unknown) => void;
  refreshGroups: () => Promise<void>;
  setCurrentUser: (user: AuthUser | null) => void;
  setError: (error: string) => void;
  setGroups: (next: StateUpdate<Group[]>) => void;
};

function resolveStateUpdate<T>(next: StateUpdate<T>, current: T): T {
  return typeof next === 'function' ? (next as (current: T) => T)(current) : next;
}

function emptyAccessGroupsState(): AccessGroupsState {
  return {
    groupForm: {
      name: '',
      visibility: 'organization',
      writePolicy: 'group_members',
      automationCreateRequiredRole: 'member',
      serverError: '',
    },
    memberSearch: {
      query: '',
      loading: false,
      userId: '',
      role: 'viewer',
      options: [],
    },
    superAdminSearch: {
      query: '',
      loading: false,
      userId: '',
      options: [],
    },
    roleManagementUsers: [],
  };
}

export function useAccessGroupsAdmin(input: UseAccessGroupsAdminInput) {
  const [groupMembers, setGroupMembers] = useState<GroupMember[]>([]);
  const [accessGroupsState, setAccessGroupsState] = useState<AccessGroupsState>(emptyAccessGroupsState);
  const { groupForm, memberSearch, superAdminSearch, roleManagementUsers } = accessGroupsState;

  const currentSuperAdminUsers = useMemo(() => {
    const superAdmins = roleManagementUsers.filter((user) => user.role === 'super_admin');
    const currentUser = input.currentUser;
    if (currentUser?.role !== 'super_admin' || superAdmins.some((user) => user.id === currentUser.id)) {
      return superAdmins;
    }
    return upsertAuthUser(superAdmins, currentUser);
  }, [input.currentUser, roleManagementUsers]);

  const groupFormValidationError = groupNameValidationError(
    input.groups,
    input.groupsPanelView === 'group' ? input.selectedGroupId : '',
    groupForm.name,
  );
  const groupFormError = groupFormValidationError || groupForm.serverError;

  function updateGroupForm(next: Partial<AccessGroupFormState>) {
    setAccessGroupsState((current) => ({ ...current, groupForm: { ...current.groupForm, ...next } }));
  }

  function updateMemberSearch(next: Partial<AccessGroupMemberSearchState>) {
    setAccessGroupsState((current) => ({ ...current, memberSearch: { ...current.memberSearch, ...next } }));
  }

  function updateSuperAdminSearch(next: Partial<AccessGroupUserSearchState>) {
    setAccessGroupsState((current) => ({
      ...current,
      superAdminSearch: { ...current.superAdminSearch, ...next },
    }));
  }

  function setUserOptions(next: StateUpdate<AuthUser[]>) {
    setAccessGroupsState((current) => ({
      ...current,
      memberSearch: {
        ...current.memberSearch,
        options: resolveStateUpdate(next, current.memberSearch.options),
      },
    }));
  }

  function setSuperAdminUserOptions(next: StateUpdate<AuthUser[]>) {
    setAccessGroupsState((current) => ({
      ...current,
      superAdminSearch: {
        ...current.superAdminSearch,
        options: resolveStateUpdate(next, current.superAdminSearch.options),
      },
    }));
  }

  function setRoleManagementUsers(next: StateUpdate<AuthUser[]>) {
    setAccessGroupsState((current) => ({
      ...current,
      roleManagementUsers: resolveStateUpdate(next, current.roleManagementUsers),
    }));
  }

  function prepareNewGroupForm(name: string) {
    updateGroupForm({
      name,
      visibility: 'organization',
      writePolicy: 'group_members',
      automationCreateRequiredRole: 'member',
      serverError: '',
    });
    setGroupMembers([]);
  }

  function resetAccessGroupsAdmin() {
    setGroupMembers([]);
    setAccessGroupsState(emptyAccessGroupsState());
  }

  function setGroupFormName(name: string) {
    updateGroupForm({ name, serverError: '' });
  }

  function setGroupFormVisibility(visibility: SessionVisibility) {
    updateGroupForm({ visibility });
  }

  function setGroupFormWritePolicy(writePolicy: SessionWritePolicy) {
    updateGroupForm({ writePolicy });
  }

  function setGroupFormAutomationCreateRequiredRole(automationCreateRequiredRole: AutomationCreateRequiredRole) {
    updateGroupForm({ automationCreateRequiredRole });
  }

  function setMemberSearchQuery(query: string) {
    updateMemberSearch({ query });
  }

  function setMemberUserId(userId: string) {
    updateMemberSearch({ userId });
  }

  function setMemberRole(role: GroupRole) {
    updateMemberSearch({ role });
  }

  function selectMemberUser(userId: string) {
    updateMemberSearch({ userId, query: '' });
  }

  function setSuperAdminSearchQuery(query: string) {
    updateSuperAdminSearch({ query });
  }

  function setSuperAdminUserId(userId: string) {
    updateSuperAdminSearch({ userId });
  }

  function selectSuperAdminUser(userId: string) {
    updateSuperAdminSearch({ userId, query: '' });
  }

  async function createAccessGroup(): Promise<Group | null> {
    if (!input.canManageAllGroups) return null;
    const validationError = groupNameValidationError(input.groups, '', groupForm.name);
    if (!groupForm.name.trim() || validationError) {
      updateGroupForm({ serverError: validationError });
      return null;
    }
    input.setError('');
    updateGroupForm({ serverError: '' });
    try {
      const group = await createGroup({
        name: groupForm.name.trim(),
        defaultVisibility: groupForm.visibility,
        defaultWritePolicy: groupForm.writePolicy,
        automationCreateRequiredRole: groupForm.automationCreateRequiredRole,
        token: input.token,
      });
      await input.refreshGroups();
      return group;
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        updateGroupForm({ serverError: 'An access group with this name already exists.' });
        return null;
      }
      input.handleApiError(err);
      return null;
    }
  }

  async function saveSelectedGroup() {
    const group = input.groups.find((candidate) => candidate.id === input.selectedGroupId);
    if (!group?.canManage || !groupForm.name.trim()) return;
    const validationError = groupNameValidationError(input.groups, group.id, groupForm.name);
    if (validationError) {
      updateGroupForm({ serverError: validationError });
      return;
    }
    input.setError('');
    updateGroupForm({ serverError: '' });
    try {
      const updated = await updateGroup({
        groupId: group.id,
        name: groupForm.name.trim(),
        defaultVisibility: groupForm.visibility,
        defaultWritePolicy: groupForm.writePolicy,
        automationCreateRequiredRole: groupForm.automationCreateRequiredRole,
        token: input.token,
      });
      input.setGroups((current) => current.map((candidate) => (candidate.id === updated.id ? updated : candidate)));
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        updateGroupForm({ serverError: 'An access group with this name already exists.' });
        return;
      }
      input.handleApiError(err);
    }
  }

  async function addGroupMember() {
    const group = input.groups.find((candidate) => candidate.id === input.selectedGroupId);
    const userId = memberSearch.userId.trim();
    if (!group?.canManage || !userId) return;
    input.setError('');
    try {
      const member = await upsertGroupMember({
        groupId: group.id,
        userId,
        role: memberSearch.role,
        token: input.token,
      });
      setGroupMembers((current) => [member, ...current.filter((candidate) => candidate.userId !== member.userId)]);
      updateMemberSearch({ userId: '', query: '', options: [] });
      await input.refreshGroups();
    } catch (err) {
      input.handleApiError(err);
    }
  }

  async function updateGroupMemberRole(userId: string, role: GroupRole) {
    const group = input.groups.find((candidate) => candidate.id === input.selectedGroupId);
    if (!group?.canManage) return;
    input.setError('');
    try {
      const member = await upsertGroupMember({ groupId: group.id, userId, role, token: input.token });
      setGroupMembers((current) => current.map((candidate) => (candidate.userId === userId ? member : candidate)));
      await input.refreshGroups();
    } catch (err) {
      input.handleApiError(err);
    }
  }

  async function removeSelectedGroupMember(userId: string) {
    const group = input.groups.find((candidate) => candidate.id === input.selectedGroupId);
    if (!group?.canManage) return;
    input.setError('');
    try {
      await removeGroupMember({ groupId: group.id, userId, token: input.token });
      setGroupMembers((current) => current.filter((candidate) => candidate.userId !== userId));
      await input.refreshGroups();
    } catch (err) {
      input.handleApiError(err);
    }
  }

  async function promoteSuperAdmin() {
    const userId = superAdminSearch.userId.trim();
    if (!input.canManageAllGroups || !userId) return;
    input.setError('');
    try {
      const promoted = await updateUserRole({ userId, role: 'super_admin', token: input.token });
      if (input.currentUser?.id === promoted.id) input.setCurrentUser({ ...input.currentUser, role: promoted.role });
      setRoleManagementUsers((current) => upsertAuthUser(current, promoted));
      setSuperAdminUserOptions((current) =>
        current.map((candidate) => (candidate.id === promoted.id ? { ...candidate, role: promoted.role } : candidate)),
      );
      setUserOptions((current) =>
        current.map((candidate) => (candidate.id === promoted.id ? { ...candidate, role: promoted.role } : candidate)),
      );
      updateSuperAdminSearch({ userId: '', query: '', options: [] });
    } catch (err) {
      input.handleApiError(err);
    }
  }

  async function removeSuperAdmin(userId: string) {
    if (!input.canManageAllGroups || userId === input.currentUser?.id) return;
    input.setError('');
    try {
      const updated = await updateUserRole({ userId, role: 'user', token: input.token });
      setRoleManagementUsers((current) => upsertAuthUser(current, updated));
      setSuperAdminUserOptions((current) =>
        current.map((candidate) => (candidate.id === updated.id ? { ...candidate, role: updated.role } : candidate)),
      );
      setUserOptions((current) =>
        current.map((candidate) => (candidate.id === updated.id ? { ...candidate, role: updated.role } : candidate)),
      );
    } catch (err) {
      input.handleApiError(err);
    }
  }

  useEffect(() => {
    const group =
      input.groupsPanelView === 'group'
        ? input.groups.find((candidate) => candidate.id === input.selectedGroupId)
        : null;
    if (!group) {
      setGroupMembers([]);
      return;
    }
    updateGroupForm({
      name: group.name,
      visibility: group.defaultVisibility,
      writePolicy: group.defaultWritePolicy,
      automationCreateRequiredRole: group.automationCreateRequiredRole,
      serverError: '',
    });
    if (!input.groupsPanelOpen || !group.canManage) return;
    listGroupMembers({ groupId: group.id, token: input.token }).then(setGroupMembers).catch(input.handleApiError);
  }, [input.groupsPanelOpen, input.groups, input.groupsPanelView, input.selectedGroupId, input.token]);

  useEffect(() => {
    if (!input.groupsPanelOpen || !input.canManageAllGroups) {
      setRoleManagementUsers([]);
      return;
    }

    let cancelled = false;
    listUsers({ token: input.token })
      .then((users) => {
        if (!cancelled) setRoleManagementUsers(users);
      })
      .catch(() => {
        if (!cancelled) setRoleManagementUsers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [input.groupsPanelOpen, input.canManageAllGroups, input.token]);

  useEffect(() => {
    const query = memberSearch.query.trim();
    const group = input.groups.find((candidate) => candidate.id === input.selectedGroupId);
    if (input.groupsPanelView !== 'group' || !input.groupsPanelOpen || !group?.canManage) {
      updateMemberSearch({ options: [], loading: false });
      return;
    }
    if (query.length < 2) {
      updateMemberSearch({ loading: false });
      return;
    }

    let cancelled = false;
    updateMemberSearch({ loading: true });
    listUsers({ query, token: input.token })
      .then((users) => {
        if (!cancelled) updateMemberSearch({ options: users });
      })
      .catch(() => {
        if (!cancelled) updateMemberSearch({ options: [] });
      })
      .finally(() => {
        if (!cancelled) updateMemberSearch({ loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [
    input.groupsPanelOpen,
    input.groups,
    input.groupsPanelView,
    memberSearch.query,
    input.selectedGroupId,
    input.token,
  ]);

  useEffect(() => {
    const query = superAdminSearch.query.trim();
    if (!input.groupsPanelOpen || !input.canManageAllGroups) {
      updateSuperAdminSearch({ options: [], loading: false });
      return;
    }
    if (query.length < 2) {
      updateSuperAdminSearch({ loading: false });
      return;
    }

    let cancelled = false;
    updateSuperAdminSearch({ loading: true });
    listUsers({ query, token: input.token })
      .then((users) => {
        if (!cancelled) updateSuperAdminSearch({ options: users });
      })
      .catch(() => {
        if (!cancelled) updateSuperAdminSearch({ options: [] });
      })
      .finally(() => {
        if (!cancelled) updateSuperAdminSearch({ loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [input.groupsPanelOpen, input.canManageAllGroups, superAdminSearch.query, input.token]);

  return {
    currentSuperAdminUsers,
    groupForm,
    groupFormError,
    groupMembers,
    memberSearch,
    superAdminSearch,
    addGroupMember,
    createAccessGroup,
    prepareNewGroupForm,
    promoteSuperAdmin,
    resetAccessGroupsAdmin,
    removeSelectedGroupMember,
    removeSuperAdmin,
    saveSelectedGroup,
    selectMemberUser,
    selectSuperAdminUser,
    setGroupFormAutomationCreateRequiredRole,
    setGroupFormName,
    setGroupFormVisibility,
    setGroupFormWritePolicy,
    setMemberRole,
    setMemberSearchQuery,
    setMemberUserId,
    setSuperAdminSearchQuery,
    setSuperAdminUserId,
    updateGroupMemberRole,
  };
}
