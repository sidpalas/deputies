import { useEffect, useState } from 'react';
import type { BranchOption, Environment } from '../../api.js';
import { cn } from '../../lib/utils.js';
import { BranchPicker } from './option-picker.js';

export type EnvironmentBranchOverrides = Record<string, string>;
export type EnvironmentBranchOverrideRepository = {
  id?: string;
  provider: 'github';
  owner: string;
  repo: string;
  primary?: boolean;
  position?: number;
  branch?: string;
};
export type EnvironmentBranchOverrideTarget = Pick<Environment, 'id' | 'name'> & {
  repositories: EnvironmentBranchOverrideRepository[];
};
type EnvironmentRepository = EnvironmentBranchOverrideRepository;
type BranchOptionsState = Record<
  string,
  {
    branches: BranchOption[];
    loading: boolean;
    error: string;
    loaded: boolean;
  }
>;

export function EnvironmentBranchOverridesEditor(props: {
  environment: EnvironmentBranchOverrideTarget | null;
  value: EnvironmentBranchOverrides;
  compact?: boolean;
  direction?: 'up' | 'down';
  disabled: boolean;
  onLoadBranches: (repository: EnvironmentRepository) => Promise<BranchOption[]>;
  onChange: (value: EnvironmentBranchOverrides) => void;
}) {
  const [branchOptionsByRepository, setBranchOptionsByRepository] = useState<BranchOptionsState>({});

  useEffect(() => {
    setBranchOptionsByRepository({});
  }, [props.environment?.id]);

  if (!props.environment) return null;
  const repositories = props.environment.repositories
    .slice()
    .sort((left, right) => (left.position ?? 0) - (right.position ?? 0));

  function update(repositoryKey: string, branch: string) {
    const next = { ...props.value };
    if (branch.trim()) next[repositoryKey] = branch;
    else delete next[repositoryKey];
    props.onChange(next);
  }

  async function loadBranches(repository: EnvironmentRepository) {
    if (props.disabled) return;
    const key = environmentRepositoryKey(repository);
    const current = branchOptionsByRepository[key];
    if (current?.loading || current?.loaded) return;

    setBranchOptionsByRepository((options) => ({
      ...options,
      [key]: {
        branches: options[key]?.branches ?? [],
        loading: true,
        error: '',
        loaded: false,
      },
    }));
    try {
      const branches = await props.onLoadBranches(repository);
      setBranchOptionsByRepository((options) => ({
        ...options,
        [key]: { branches, loading: false, error: '', loaded: true },
      }));
    } catch {
      setBranchOptionsByRepository((options) => ({
        ...options,
        [key]: {
          branches: options[key]?.branches ?? [],
          loading: false,
          error: 'Could not load branches.',
          loaded: false,
        },
      }));
    }
  }

  return (
    <div className={props.compact ? 'basis-full' : 'grid gap-2'}>
      <div className="rounded-md border border-border bg-background/70 p-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs font-medium text-muted-foreground">
            {repositories.length} repo{repositories.length === 1 ? '' : 's'} in {props.environment.name}
          </p>
          {props.compact ? null : <p className="text-xs text-muted-foreground">Branch overrides</p>}
        </div>
        <div className="mt-2 grid gap-2">
          {repositories.map((repository) => {
            const key = environmentRepositoryKey(repository);
            const branchState = branchOptionsByRepository[key];
            const repositoryLabel = `${repository.owner}/${repository.repo}`;
            return (
              <div
                key={repository.id ?? key}
                className={cn(
                  'grid min-w-0 gap-1 text-xs text-muted-foreground sm:items-center',
                  props.compact
                    ? 'sm:grid-cols-[minmax(10rem,1fr)_minmax(5.5rem,8rem)]'
                    : 'sm:grid-cols-[minmax(12rem,1fr)_minmax(6rem,9rem)]',
                )}
              >
                <span className="min-w-0 truncate" title={repositoryLabel}>
                  {repositoryLabel}
                  {repository.primary ? ' (primary)' : ''}
                </span>
                <div
                  className="min-w-0"
                  onFocus={() => void loadBranches(repository)}
                  onPointerDown={() => void loadBranches(repository)}
                >
                  <BranchPicker
                    className="min-w-0"
                    triggerClassName={props.compact ? 'h-7 px-2 pr-8 text-xs' : 'h-9 text-sm'}
                    menuClassName="min-w-full"
                    {...(props.direction ? { direction: props.direction } : {})}
                    label={`Branch for ${repositoryLabel}`}
                    value={props.value[key] ?? ''}
                    branches={branchState?.branches ?? []}
                    loading={branchState?.loading ?? false}
                    error={branchState?.error ?? ''}
                    onChange={(branch) => update(key, branch)}
                    placeholder={repository.branch ? `Default: ${repository.branch}` : 'Default branch'}
                    disabled={props.disabled}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function environmentRepositoryKey(repository: { provider: 'github'; owner: string; repo: string }): string {
  return `${repository.provider}:${repository.owner}/${repository.repo}`.toLowerCase();
}
