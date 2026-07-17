import { useEffect, useRef, useState } from 'react';
import { ApiError, listSkillInvocationCandidates, type Skill } from './api.js';
import { errorMessage } from './app-state.js';

export function useSkillInvocationCandidates(input: { enabled: boolean; ownerGroupId: string; token: string }) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const requestRef = useRef(0);

  useEffect(() => {
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    if (!input.enabled || !input.ownerGroupId) {
      setSkills([]);
      setLoading(false);
      setError('');
      setAvailable(null);
      return;
    }

    let active = true;
    setSkills([]);
    setLoading(true);
    setError('');
    void listSkillInvocationCandidates({ ownerGroupId: input.ownerGroupId, token: input.token })
      .then((next) => {
        if (active && requestRef.current === requestId) {
          setSkills(next);
          setAvailable(true);
        }
      })
      .catch((cause: unknown) => {
        if (!active || requestRef.current !== requestId) return;
        setSkills([]);
        if (cause instanceof ApiError && cause.status === 404) setAvailable(false);
        else setError(errorMessage(cause));
      })
      .finally(() => {
        if (active && requestRef.current === requestId) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [input.enabled, input.ownerGroupId, input.token]);

  return { skills, available, loading, error, setError };
}
