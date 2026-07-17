import { useEffect, useRef, useState } from 'react';
import { ApiError, listSessionSkills, type Skill } from './api.js';
import { errorMessage } from './app-state.js';

export function useSessionSkillCatalog(input: { enabled: boolean; sessionId: string; token: string }) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef(input);
  const activeSessionIdRef = useRef(input.sessionId);
  const refreshTimerRef = useRef<number | null>(null);
  const refreshInFlightRef = useRef(false);
  const refreshQueuedRef = useRef<{ sessionId: string; token: string; clearError: boolean } | null>(null);
  const refreshRequestRef = useRef(0);
  inputRef.current = input;
  activeSessionIdRef.current = input.sessionId;

  useEffect(() => {
    clearScheduledRefresh();
    if (!input.enabled || !input.sessionId) {
      refreshRequestRef.current += 1;
      refreshQueuedRef.current = null;
      setSkills([]);
      setLoading(false);
    } else {
      setSkills([]);
      setLoading(true);
      void refresh(input.sessionId, input.token, true);
    }
    return () => {
      clearScheduledRefresh();
      refreshRequestRef.current += 1;
      refreshQueuedRef.current = null;
    };
  }, [input.enabled, input.sessionId, input.token]);

  function clearScheduledRefresh() {
    if (refreshTimerRef.current === null) return;
    window.clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = null;
  }

  function invalidate() {
    const currentInput = inputRef.current;
    if (!currentInput.enabled || !currentInput.sessionId) return;
    refreshRequestRef.current += 1;
    clearScheduledRefresh();
    const { sessionId, token } = currentInput;
    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = null;
      if (activeSessionIdRef.current === sessionId) void refresh(sessionId, token);
    }, 100);
  }

  async function refresh(sessionId: string, token: string, clearError = false) {
    const requestId = refreshRequestRef.current + 1;
    refreshRequestRef.current = requestId;
    if (refreshInFlightRef.current) {
      const queued = refreshQueuedRef.current;
      refreshQueuedRef.current = {
        sessionId,
        token,
        clearError: clearError || queued?.clearError === true,
      };
      return;
    }

    refreshInFlightRef.current = true;
    if (activeSessionIdRef.current === sessionId) {
      setLoading(true);
      if (clearError) setError('');
    }
    try {
      const next = await listSessionSkills({ sessionId, token });
      if (refreshRequestRef.current === requestId && activeSessionIdRef.current === sessionId) setSkills(next);
    } catch (cause) {
      if (refreshRequestRef.current !== requestId || activeSessionIdRef.current !== sessionId) return;
      setSkills([]);
      if (!(cause instanceof ApiError && cause.status === 404)) setError(errorMessage(cause));
    } finally {
      refreshInFlightRef.current = false;
      const queued = refreshQueuedRef.current;
      refreshQueuedRef.current = null;
      if (queued && activeSessionIdRef.current === queued.sessionId) {
        void refresh(queued.sessionId, queued.token, queued.clearError);
      } else if (refreshRequestRef.current === requestId && activeSessionIdRef.current === sessionId) {
        setLoading(false);
      }
    }
  }

  return { skills, loading, error, setError, invalidate };
}
