import { useMemo, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';

import { archiveAutomation, listAutomations, unarchiveAutomation, type Automation } from './api.js';
import { archivedAutomationsOpenStorageKey, selectedAutomationStorageKey } from './app-helpers.js';

type StateUpdate<T> = T | ((current: T) => T);

type UseAutomationsAdminInput = {
  token: string;
  canViewAutomations: boolean;
  selectedAutomationId: string;
  initialAutomationDeepLinkRef: MutableRefObject<boolean>;
  clearResourceSearchParams: () => void;
  handleApiError: (err: unknown) => void;
  setError: (error: string) => void;
  setSelectedAutomationId: (next: StateUpdate<string>) => void;
};

type UseAutomationsAdminResult = {
  automations: Automation[];
  selectedAutomation: Automation | null;
  archivedAutomationsOpen: boolean;
  setArchivedAutomationsOpen: Dispatch<SetStateAction<boolean>>;
  automationsLoading: boolean;
  automationsLoaded: boolean;
  refreshAutomations: () => Promise<void>;
  handleAutomationChanged: (automation: Automation) => void;
  handleArchiveAutomation: (automationId: string) => Promise<void>;
  handleUnarchiveAutomation: (automationId: string) => Promise<void>;
  reset: () => void;
};

export function useAutomationsAdmin(input: UseAutomationsAdminInput): UseAutomationsAdminResult {
  const {
    token,
    canViewAutomations,
    selectedAutomationId,
    initialAutomationDeepLinkRef,
    clearResourceSearchParams,
    handleApiError,
    setError,
    setSelectedAutomationId,
  } = input;
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [archivedAutomationsOpen, setArchivedAutomationsOpen] = useState(
    () => sessionStorage.getItem(archivedAutomationsOpenStorageKey) === 'true',
  );
  const [automationsLoading, setAutomationsLoading] = useState(false);
  const [automationsLoaded, setAutomationsLoaded] = useState(false);

  const selectedAutomation = useMemo(
    () => automations.find((automation) => automation.id === selectedAutomationId) ?? null,
    [automations, selectedAutomationId],
  );

  async function refreshAutomations() {
    if (!canViewAutomations) return;
    setAutomationsLoading(true);
    setError('');
    try {
      const nextAutomations = await listAutomations(token);
      setAutomations(nextAutomations);
      setSelectedAutomationId((current) => {
        if (!current || nextAutomations.some((automation) => automation.id === current)) return current;
        if (initialAutomationDeepLinkRef.current) return current;
        sessionStorage.removeItem(selectedAutomationStorageKey);
        clearResourceSearchParams();
        return '';
      });
    } catch (err) {
      handleApiError(err);
    } finally {
      setAutomationsLoaded(true);
      setAutomationsLoading(false);
    }
  }

  function handleAutomationChanged(automation: Automation) {
    setAutomations((current) => [automation, ...current.filter((candidate) => candidate.id !== automation.id)]);
  }

  async function handleArchiveAutomation(automationId: string) {
    const automation = automations.find((candidate) => candidate.id === automationId);
    if (!automation?.canManage || automation.archivedAt) return;
    setError('');
    try {
      handleAutomationChanged(await archiveAutomation({ automationId, token }));
    } catch (err) {
      handleApiError(err);
    }
  }

  async function handleUnarchiveAutomation(automationId: string) {
    const automation = automations.find((candidate) => candidate.id === automationId);
    if (!automation?.canManage || !automation.archivedAt) return;
    setError('');
    try {
      handleAutomationChanged(await unarchiveAutomation({ automationId, token }));
    } catch (err) {
      handleApiError(err);
    }
  }

  function reset() {
    setAutomations([]);
    setAutomationsLoaded(false);
  }

  return {
    automations,
    selectedAutomation,
    archivedAutomationsOpen,
    setArchivedAutomationsOpen,
    automationsLoading,
    automationsLoaded,
    refreshAutomations,
    handleAutomationChanged,
    handleArchiveAutomation,
    handleUnarchiveAutomation,
    reset,
  };
}
