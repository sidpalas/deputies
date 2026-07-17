import { useEffect, useId, useRef, useState } from 'react';
import { ApiError } from '../../api.js';
import { OptionPicker, type OptionPickerOption } from './option-picker.js';

export type RevisionSummary = {
  id: string;
  revisionNumber: number;
  createdAt: string;
};

export function useRevisionViewer<T extends RevisionSummary>(input: {
  resourceId: string;
  currentRevisionId: string | undefined;
  selectedRevisionId: string;
  token: string;
  enabled: boolean;
  loadRevisions: (resourceId: string, token: string) => Promise<T[]>;
  onSelectRevision: (revisionId: string) => void;
  onError: (error: unknown) => void;
  suppressForbidden?: boolean;
}) {
  const [revisions, setRevisions] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const onErrorRef = useRef(input.onError);
  onErrorRef.current = input.onError;

  useEffect(() => {
    if (!input.resourceId || !input.currentRevisionId || !input.enabled) {
      setRevisions([]);
      setLoading(false);
      setLoaded(false);
      setError('');
      return;
    }
    let active = true;
    setLoading(true);
    setLoaded(false);
    setError('');
    void input
      .loadRevisions(input.resourceId, input.token)
      .then((next) => {
        if (active) setRevisions(next);
      })
      .catch((loadError: unknown) => {
        if (!active) return;
        setRevisions([]);
        setError('Revision history is unavailable.');
        if (!(input.suppressForbidden && loadError instanceof ApiError && loadError.status === 403)) {
          onErrorRef.current(loadError);
        }
      })
      .finally(() => {
        if (!active) return;
        setLoading(false);
        setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [
    input.resourceId,
    input.currentRevisionId,
    input.enabled,
    input.token,
    input.loadRevisions,
    input.suppressForbidden,
  ]);

  const viewedRevision =
    input.selectedRevisionId && input.selectedRevisionId !== input.currentRevisionId
      ? (revisions.find((revision) => revision.id === input.selectedRevisionId) ?? null)
      : null;

  return {
    loading,
    revisions,
    viewedRevision,
    error,
    requestedRevisionMissing: Boolean(
      input.selectedRevisionId &&
      input.selectedRevisionId !== input.currentRevisionId &&
      loaded &&
      !error &&
      !viewedRevision,
    ),
    selectRevision: input.onSelectRevision,
  };
}

export function RevisionSelector(props: {
  currentRevisionId: string;
  currentRevisionNumber: number;
  selectedRevisionId: string;
  revisions: RevisionSummary[];
  loading: boolean;
  error?: string;
  disabled?: boolean;
  onSelectRevision: (revisionId: string) => void;
}) {
  const selectorId = useId();
  const options: OptionPickerOption[] = props.revisions
    .slice()
    .sort((left, right) => right.revisionNumber - left.revisionNumber)
    .map((revision) => {
      const current = revision.id === props.currentRevisionId;
      return {
        value: revision.id,
        label: `Revision ${revision.revisionNumber}`,
        description: `${formatRevisionDate(revision.createdAt)} · ${current ? 'Current' : 'Historical'}`,
      };
    });

  return (
    <div className="min-w-0">
      <OptionPicker
        id={selectorId}
        className="w-fit"
        triggerClassName="h-8 w-auto min-w-24 border-transparent bg-muted/50 py-0 pl-2.5 pr-8 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        menuClassName="left-auto right-0 w-[min(16rem,calc(100vw-4rem))] min-w-0 sm:w-auto sm:min-w-72"
        label="Revision"
        value={props.selectedRevisionId || props.currentRevisionId}
        options={options}
        emptyLabel={props.loading ? 'Loading...' : `Revision ${props.currentRevisionNumber}`}
        loading={props.loading}
        {...(props.error ? { error: props.error } : {})}
        disabled={Boolean(props.disabled)}
        onChange={(revisionId) => props.onSelectRevision(revisionId === props.currentRevisionId ? '' : revisionId)}
      />
      {props.error ? <p className="mt-1 max-w-56 text-right text-xs text-destructive">{props.error}</p> : null}
    </div>
  );
}

function formatRevisionDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, { dateStyle: 'medium' });
}
