import { useEffect, useMemo, useRef, useState } from 'react';

import {
  archiveAgentProfile,
  getAgentProfileDefaultConfiguration,
  listAgentProfiles,
  restoreAgentProfile,
  type AgentProfile,
  type AgentProfileDefaultConfiguration,
  type ReasoningLevel,
} from './api.js';

export function useAgentProfilesWorkspace(input: {
  token: string;
  canCallApi: boolean;
  canManage: boolean;
  applicationDefaultModel: string;
  onError: (error: unknown) => void;
}) {
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [defaultConfiguration, setDefaultConfiguration] = useState<AgentProfileDefaultConfiguration | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [newSessionProfileId, setNewSessionProfileId] = useState('');
  const [newSessionModel, setNewSessionModel] = useState('');
  const [newSessionReasoningLevel, setNewSessionReasoningLevel] = useState<ReasoningLevel | ''>('');
  const newSessionOverridesRef = useRef({ model: false, reasoningLevel: false });
  const defaultConfigurationGenerationRef = useRef(0);
  const onErrorRef = useRef(input.onError);
  onErrorRef.current = input.onError;

  const selectableProfiles = useMemo(
    () =>
      profiles.filter(
        (profile) => !profile.archivedAt && profile.enabled && profile.supportedInvocations.includes('agent'),
      ),
    [profiles],
  );

  useEffect(() => {
    if (!input.canCallApi) {
      defaultConfigurationGenerationRef.current += 1;
      setProfiles([]);
      setDefaultConfiguration(null);
      setLoaded(false);
      return;
    }
    let active = true;
    setLoading(true);
    void Promise.all([
      listAgentProfiles({ token: input.token }),
      getAgentProfileDefaultConfiguration({ token: input.token }),
    ])
      .then(([nextProfiles, configuration]) => {
        if (!active) return;
        setProfiles(nextProfiles);
        applyDefaultConfiguration(configuration);
        setLoaded(true);
      })
      .catch((error) => {
        if (active) onErrorRef.current(error);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [input.canCallApi, input.token]);

  useEffect(() => {
    if (!loaded) return;
    const selected = selectableProfiles.find((profile) => profile.id === newSessionProfileId);
    const profile =
      selected ??
      selectableProfiles.find((candidate) => candidate.id === defaultConfiguration?.effectiveProfileId) ??
      selectableProfiles.find((candidate) => candidate.id === 'builtin:general') ??
      selectableProfiles[0];
    if (!selected) setNewSessionProfileId(profile?.id ?? '');
    if (!newSessionOverridesRef.current.model)
      setNewSessionModel(profile?.defaultModel ?? input.applicationDefaultModel);
    if (!newSessionOverridesRef.current.reasoningLevel)
      setNewSessionReasoningLevel(profile?.defaultReasoningLevel ?? '');
  }, [defaultConfiguration, input.applicationDefaultModel, loaded, newSessionProfileId, selectableProfiles]);

  function applyDefaultConfiguration(configuration: AgentProfileDefaultConfiguration) {
    defaultConfigurationGenerationRef.current += 1;
    setDefaultConfiguration(configuration);
  }

  async function refreshDefaultConfiguration() {
    const generation = ++defaultConfigurationGenerationRef.current;
    const configuration = await getAgentProfileDefaultConfiguration({ token: input.token });
    if (defaultConfigurationGenerationRef.current === generation) setDefaultConfiguration(configuration);
  }

  function merge(profile: AgentProfile) {
    setProfiles((current) => {
      const existing = current.find((candidate) => candidate.id === profile.id);
      if (
        existing?.updatedAt &&
        profile.updatedAt &&
        new Date(existing.updatedAt).getTime() > new Date(profile.updatedAt).getTime()
      )
        return current;
      return [profile, ...current.filter((candidate) => candidate.id !== profile.id)];
    });
    void refreshDefaultConfiguration().catch(onErrorRef.current);
  }

  async function setArchived(profileId: string, archived: boolean) {
    if (!input.canManage) return;
    try {
      merge(
        await (archived ? archiveAgentProfile : restoreAgentProfile)({
          profileId,
          token: input.token,
        }),
      );
    } catch (error) {
      onErrorRef.current(error);
    }
  }

  function selectForNewSession(profileId: string, resetOverrides = false) {
    if (resetOverrides) newSessionOverridesRef.current = { model: false, reasoningLevel: false };
    const profile = profiles.find((candidate) => candidate.id === profileId);
    setNewSessionProfileId(profileId);
    if (!newSessionOverridesRef.current.model)
      setNewSessionModel(profile?.defaultModel ?? input.applicationDefaultModel);
    if (!newSessionOverridesRef.current.reasoningLevel)
      setNewSessionReasoningLevel(profile?.defaultReasoningLevel ?? '');
  }

  function resetNewSessionSelection(profileId?: string) {
    newSessionOverridesRef.current = { model: false, reasoningLevel: false };
    const fallback =
      (profileId && selectableProfiles.find((profile) => profile.id === profileId)) ||
      selectableProfiles.find((profile) => profile.id === defaultConfiguration?.effectiveProfileId) ||
      selectableProfiles.find((profile) => profile.id === 'builtin:general') ||
      selectableProfiles[0];
    selectForNewSession(fallback?.id ?? '', true);
  }

  return {
    model: {
      profiles,
      selectableProfiles,
      defaultConfiguration,
      loading,
      loaded,
      newSession: {
        profileId: newSessionProfileId,
        model: newSessionModel,
        reasoningLevel: newSessionReasoningLevel,
        modelIsExplicit: newSessionOverridesRef.current.model,
        reasoningLevelIsExplicit: newSessionOverridesRef.current.reasoningLevel,
      },
    },
    actions: {
      applyDefaultConfiguration,
      merge,
      setArchived,
      selectForNewSession,
      resetNewSessionSelection,
      setNewSessionModel: (model: string) => {
        newSessionOverridesRef.current.model = true;
        setNewSessionModel(model);
      },
      setNewSessionReasoningLevel: (reasoningLevel: ReasoningLevel | '') => {
        newSessionOverridesRef.current.reasoningLevel = true;
        setNewSessionReasoningLevel(reasoningLevel);
      },
    },
  };
}
