import type { RunnerInput } from '../runner/types.js';
import type { SandboxHandle } from '../sandbox/types.js';
import {
  prepareRepositoryShellSetups,
  parseRepositoryContext,
  sameRepositoryIdentity,
  type GitHubRepository,
  type GitHubRepositoryAccess,
  type RepositoryAccessProvider,
  type RepositoryShellSetup,
} from './setup.js';
import {
  parseRepositoryWasCloned,
  runRepositorySetupScript,
  setupScriptFailureNote,
  setupScriptResultLine,
  type RepositorySetupScriptPolicy,
  type SetupScriptResult,
} from './setup-script.js';
import type { RepositoryShell } from './shell.js';

const repositorySetupTimeoutMs = 120_000;

export type PreparedRepository = {
  repository: GitHubRepository & { provider: 'github' };
  access: GitHubRepositoryAccess;
  workspacePath: string;
  primary?: boolean;
  environment?: { id: string; name: string };
  setupScriptResult?: SetupScriptResult | null;
};

export type RepositoryPreparationPlan = RepositoryShellSetup & {
  repository: GitHubRepository & { provider: 'github' };
};

export type RepositoryPreparationResult = PreparedRepository & {
  branch?: string;
  repositoryWasCloned: boolean;
  setupScriptResult: SetupScriptResult | null;
  setupFailureNote: string | null;
  setupScriptLine: string | null;
};

export type RepositoryCheckoutResult = {
  repositoryWasCloned: boolean;
};

export async function planRepositoryPreparation(input: {
  context: Record<string, unknown>;
  sandbox: SandboxHandle;
  github?: RepositoryAccessProvider;
}): Promise<RepositoryPreparationPlan | null> {
  const setups = await prepareRepositoryShellSetups(input);
  const active = parseRepositoryContext(input.context);
  const setup = active ? setups.find((candidate) => sameRepositoryIdentity(candidate.access, active)) : undefined;
  if (!setup) return null;
  return {
    ...setup,
    repository: { provider: 'github' as const, owner: setup.access.owner, repo: setup.access.repo },
  };
}

export async function planActiveFirstRepositoryPreparations(input: {
  context: Record<string, unknown>;
  sandbox: SandboxHandle;
  github?: RepositoryAccessProvider;
}): Promise<RepositoryPreparationPlan[]> {
  const setups = await prepareRepositoryShellSetups(input);
  const plans = setups.map((setup) => ({
    ...setup,
    repository: { provider: 'github' as const, owner: setup.access.owner, repo: setup.access.repo },
  }));
  const active = parseRepositoryContext(input.context);
  if (!active) return plans;
  return plans.sort(
    (left, right) =>
      Number(sameRepositoryIdentity(right.repository, active)) -
      Number(sameRepositoryIdentity(left.repository, active)),
  );
}

export async function executeRepositoryPreparation(input: {
  plan: RepositoryPreparationPlan;
  workspaceRoot: string;
  shell: RepositoryShell;
  setupShell?: RepositoryShell;
  emit: RunnerInput['emit'];
  eventBase: Pick<RunnerInput, 'sessionId' | 'runId' | 'messageId'>;
  setupScript?: RepositorySetupScriptPolicy;
  signal?: AbortSignal;
}): Promise<RepositoryPreparationResult> {
  const checkout = await checkoutRepositoryPreparation(input);
  return completeRepositoryPreparation({
    ...input,
    repositoryWasCloned: checkout.repositoryWasCloned,
    setupShell: input.setupShell ?? input.shell,
  });
}

export async function executeRepositoryPreparations(input: {
  plans: RepositoryPreparationPlan[];
  workspaceRoot: string;
  shell: RepositoryShell;
  setupShell?: RepositoryShell;
  emit: RunnerInput['emit'];
  eventBase: Pick<RunnerInput, 'sessionId' | 'runId' | 'messageId'>;
  setupScript?: RepositorySetupScriptPolicy;
  signal?: AbortSignal;
}): Promise<RepositoryPreparationResult[]> {
  const results = [];
  for (const plan of input.plans) {
    results.push(
      await executeRepositoryPreparation({
        ...input,
        plan,
        setupShell: input.setupShell ?? input.shell,
      }),
    );
  }
  return results;
}

export async function checkoutRepositoryPreparation(input: {
  plan: RepositoryPreparationPlan;
  workspaceRoot: string;
  shell: RepositoryShell;
  signal?: AbortSignal;
}): Promise<RepositoryCheckoutResult> {
  const result = await input.shell(input.plan.command, {
    cwd: input.workspaceRoot,
    env: input.plan.env,
    timeoutMs: repositorySetupTimeoutMs,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (input.signal?.aborted) throw new Error('Operation aborted');
  if (result.exitCode !== 0) {
    throw new Error(`Repository setup failed with exit code ${result.exitCode}: ${result.stderr || result.stdout}`);
  }

  return { repositoryWasCloned: parseRepositoryWasCloned(result.stdout) };
}

export async function completeRepositoryPreparation(input: {
  plan: RepositoryPreparationPlan;
  repositoryWasCloned: boolean;
  emit: RunnerInput['emit'];
  eventBase: Pick<RunnerInput, 'sessionId' | 'runId' | 'messageId'>;
  setupShell: RepositoryShell;
  setupScript?: RepositorySetupScriptPolicy;
  signal?: AbortSignal;
}): Promise<RepositoryPreparationResult> {
  await emitRepositoryReady(input);

  const setupScriptResult = input.setupScript
    ? await runRepositorySetupScript({
        ...input.setupScript,
        workspacePath: input.plan.workspacePath,
        repositoryWasCloned: input.repositoryWasCloned,
        shell: input.setupShell,
        emit: input.emit,
        eventBase: input.eventBase,
        ...(input.signal ? { signal: input.signal } : {}),
      })
    : null;

  return {
    ...preparedRepositoryFromPlan(input.plan),
    ...(input.plan.branch ? { branch: input.plan.branch } : {}),
    repositoryWasCloned: input.repositoryWasCloned,
    setupScriptResult,
    setupFailureNote: setupScriptResult ? setupScriptFailureNote(setupScriptResult) : null,
    setupScriptLine: setupScriptResult ? setupScriptResultLine(setupScriptResult) : null,
  };
}

export function preparedRepositoryFromPlan(plan: RepositoryPreparationPlan): PreparedRepository {
  return {
    repository: plan.repository,
    access: plan.access,
    workspacePath: plan.workspacePath,
    primary: plan.primary,
    ...(plan.environment ? { environment: plan.environment } : {}),
  };
}

export function repositoryPreparationSummary(result: RepositoryPreparationResult): string {
  return [
    `Repository prepared: ${result.repository.owner}/${result.repository.repo}`,
    ...(result.branch ? [`Branch: ${result.branch}`] : []),
    `Workspace path: ${result.workspacePath}`,
    ...(result.setupScriptLine ? [result.setupScriptLine] : []),
    'Use absolute paths under this workspace for read/write/edit/bash if this run did not start in the repository cwd.',
  ].join('\n');
}

async function emitRepositoryReady(input: {
  plan: RepositoryPreparationPlan;
  emit: RunnerInput['emit'];
  eventBase: Pick<RunnerInput, 'sessionId' | 'runId' | 'messageId'>;
}): Promise<void> {
  await input.emit({
    ...input.eventBase,
    type: 'repository_ready',
    payload: {
      provider: input.plan.access.provider,
      owner: input.plan.access.owner,
      repo: input.plan.access.repo,
      ...(input.plan.branch ? { branch: input.plan.branch } : {}),
      workspacePath: input.plan.workspacePath,
      ...(input.plan.environment
        ? { environmentId: input.plan.environment.id, environmentName: input.plan.environment.name }
        : {}),
      primary: input.plan.primary,
      expiresAt: input.plan.access.expiresAt.toISOString(),
    },
    createdAt: new Date(),
  });
}
