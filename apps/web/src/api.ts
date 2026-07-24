import { apiBaseUrl, request, streamEventResponse, type RequestOptions } from './api-request.js';

export { ApiError, apiConnectionDelayedEvent, apiConnectionOkEvent, getApiBaseUrl } from './api-request.js';

export type ApiAuthMode = 'none' | 'bearer' | 'session';
export type AuthProvider = 'static' | 'github';
export type ReasoningLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type Health = {
  status: 'ok' | 'degraded';
  runMode: string;
  apiAuthMode: ApiAuthMode;
  authProvider?: AuthProvider;
  sandboxProvider?: string;
  privateSessionsEnabled?: boolean;
  hideSetupPage?: boolean;
  notices?: AppNotice[];
};

export type AppNotice = {
  severity: 'warning' | 'error';
  code: string;
  message: string;
  action?: string;
};

export type Session = {
  id: string;
  visibility?: 'tenant' | 'private';
  ownerUserId?: string;
  status: string;
  displayStatus?: string;
  displayStatusTooltip?: string;
  parentSessionId?: string;
  spawnDepth: number;
  directChildCount?: number;
  createdByUserId?: string;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  tags: string[];
  starred?: boolean;
  title?: string;
  queuePausedAt?: string;
  context?: Record<string, unknown>;
  sandbox?: {
    id: string;
    provider: string;
    providerSandboxId: string;
    status: string;
    updatedAt: string;
    destroyedAt?: string;
  };
};

export type SessionPage = {
  sessions: Session[];
  nextCursor: string | null;
};

export type NotepadActor =
  | { kind: 'human'; userId: string }
  | { kind: 'agent'; sessionId: string; runId: string }
  | { kind: 'system' };
export type SessionNotepad = {
  sessionId: string;
  revision: number;
  content: string;
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
};
export type SessionNotepadMetadata = Omit<SessionNotepad, 'content'>;
export type ExplicitNotepad = {
  id: string;
  title: string;
  revision: number;
  content: string;
  sizeBytes: number;
  createdByUserId?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
};
export type ExplicitNotepadMetadata = Omit<ExplicitNotepad, 'content'>;
export type ExplicitNotepadSearchResult = ExplicitNotepadMetadata & { snippet: string };
export type ExplicitNotepadPage = {
  items: ExplicitNotepadMetadata[];
  hasMore: boolean;
  nextCursor: string | null;
};
export type NotepadRevision = {
  notepadKind: 'session' | 'explicit';
  notepadId: string;
  revision: number;
  sizeBytes: number;
  actor: NotepadActor | { kind: NotepadActor['kind'] };
  mutationKind: 'replace' | 'patch' | 'append' | 'restore';
  createdAt: string;
};
export type NotepadRevisionWithContent = NotepadRevision & { content: string };
export type NotepadRevisionPage = {
  revisions: NotepadRevision[];
  hasMore: boolean;
  nextCursor: string | null;
};
export type NotepadAssociation = {
  notepadId: string;
  sessionId: string;
  createdByUserId?: string;
  createdAt?: string;
};
export type SessionNotepadAssociation = NotepadAssociation & {
  notepad: ExplicitNotepadMetadata;
};
export type SessionNotepadAssociationPage = {
  items: SessionNotepadAssociation[];
  hasMore: boolean;
  nextCursor: string | null;
};
export type SessionNotepadCapability = {
  sessionId: string;
  kind: 'explicit_search' | 'session_notepad_coordination';
  grantedByUserId: string;
  createdAt: string;
};

export type SessionSearchResult = {
  session: Session;
  snippet: string;
  matchKind: 'title' | 'prompt' | 'response';
  score: number;
};

export type SessionSearchPage = {
  results: SessionSearchResult[];
  nextCursor: string | null;
};

export type SessionTagSummary = {
  tag: string;
  sessionCount: number;
};

export type SessionListFilters = {
  tags?: string[];
  createdBy?: 'me';
  participant?: 'me';
  starred?: 'me';
};

export type Automation = {
  id: string;
  kind: 'scheduled';
  name: string;
  prompt: string;
  scheduleCron: string;
  scheduleTimezone: 'UTC';
  enabled: boolean;
  createdByUserId?: string;
  environmentId?: string;
  environmentRevisionPolicy?: 'follow_latest' | 'pinned';
  environmentRevisionId?: string;
  environmentRevisionNumber?: number;
  context?: Record<string, unknown>;
  nextInvocationAt?: string;
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
  canManage?: boolean;
  lastInvocation?: AutomationInvocation;
};

export type AutomationInvocation = {
  id: string;
  automationId: string;
  trigger: 'scheduled' | 'manual';
  status: 'creating' | 'created' | 'skipped' | 'failed';
  createdAt: string;
  metadata: Record<string, unknown>;
  completedAt?: string;
  scheduledAt?: string;
  sessionId?: string;
  sessionStatus?: Session['status'];
  sessionTitle?: string;
  messageId?: string;
  messageStatus?: Message['status'];
  requestedByUserId?: string;
  environmentId?: string;
  environmentRevisionId?: string;
  reason?: string;
  error?: string;
};

export type AutomationInvocationPage = {
  invocations: AutomationInvocation[];
  nextCursor?: string;
};

export type Message = {
  id: string;
  sessionId: string;
  sequence: number;
  status: string;
  steering: boolean;
  prompt: string;
  createdAt: string;
  authorUserId?: string;
  authorName?: string;
  source?: string;
  context?: Record<string, unknown>;
};

export type RepositoryInput = {
  provider: 'github';
  owner: string;
  repo: string;
};

export type EnvironmentBranchOverrideInput = RepositoryInput & {
  branch?: string;
};

export type RepositoryOption = {
  fullName: string;
  owner: string;
  name: string;
  defaultBranch?: string;
};

export type Snippet = {
  id: string;
  createdByUserId?: string;
  name: string;
  body: string;
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
};
export type SkillSource = 'managed' | 'repo';

export type SkillProvenance = { kind: 'managed'; scope?: 'tenant' | 'personal' } | { kind: 'repo'; repo: string };

export type Skill = {
  id: string;
  scope?: 'tenant' | 'personal';
  name: string;
  description: string;
  body?: string;
  currentRevisionId?: string;
  currentRevisionNumber?: number;
  createdByUserId?: string;
  autoLoad: boolean;
  enabled: boolean;
  source?: SkillSource;
  provenance?: SkillProvenance;
  repo?: string;
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
  canManage?: boolean;
};

export type SkillInvocationRef = {
  id: string;
  name: string;
  revisionId?: string;
};

export type SkillRevision = {
  id: string;
  skillId: string;
  revisionNumber: number;
  name: string;
  description: string;
  body: string;
  actorType: 'system' | 'user';
  actorUserId?: string;
  createdAt: string;
};

export type EnvironmentRepository = {
  id: string;
  provider: 'github';
  owner: string;
  repo: string;
  primary: boolean;
  position: number;
  branch?: string;
};

export type EnvironmentRevision = {
  id: string;
  environmentId: string;
  revisionNumber: number;
  repositories: Omit<EnvironmentRepository, 'id'>[];
  actorType: 'system' | 'user';
  actorUserId?: string;
  createdAt: string;
};

export type Environment = {
  id: string;
  name: string;
  currentRevisionId: string;
  currentRevisionNumber: number;
  repositories: EnvironmentRepository[];
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
  canManage?: boolean;
};

export type EnvironmentRepositoryInput = {
  provider: 'github';
  owner: string;
  repo: string;
  primary?: boolean;
  branch?: string;
};

export type BranchOption = { name: string };

export type ModelChoices = {
  models: string[];
  modelChoices: ModelChoice[];
  defaultModel: string | null;
  defaultReasoningLevel: ReasoningLevel | null;
};

export type ModelChoice = {
  value: string;
  label: string;
  available: boolean;
  unavailableCode?: string;
  unavailableReason?: string;
  action?: string;
};

export type SetupStatusState = 'configured' | 'limited' | 'missing' | 'warning' | 'error';

export type SetupStatusItem = {
  id: string;
  label: string;
  state: SetupStatusState;
  summary: string;
  guidance?: string | undefined;
  guidanceItems?: string[] | undefined;
  details?: string[] | undefined;
  docsPath: string;
};

export type SetupStatus = {
  checkedAt: string;
  items: SetupStatusItem[];
};

export type AgentEvent = {
  id?: number;
  sessionId: string;
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
  runId?: string;
  messageId?: string;
};

type AgentEventPage = {
  events: AgentEvent[];
  cursor?: number;
  hasMore?: boolean;
};

const sessionEventPageLimit = 1000;

export type Artifact = {
  id: string;
  sessionId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
  title?: string;
  url?: string;
  storageKey?: string;
  runId?: string;
  messageId?: string;
};

export type ArtifactPreview = {
  text: string;
  contentType: string;
  truncated: boolean;
  sizeBytes: number;
};

export type ArtifactPreviewResponse = {
  artifact: Artifact;
  preview: ArtifactPreview;
};

export type SandboxService = {
  port: number;
  url: string;
  status?: 'available' | 'unavailable' | 'unknown';
  label?: string;
  path?: string;
  shutdownAt?: string;
  keepaliveUntil?: string;
  maxKeepaliveUntil?: string;
};

export type SandboxKeepalive = {
  id: string;
  provider: string;
  providerSandboxId: string;
  status: string;
  providerSync: 'not_supported' | 'ok' | 'failed';
  shutdownAt?: string;
  keepaliveUntil?: string;
  maxKeepaliveUntil?: string;
};

export type WorkspaceToolId = 'ide' | 'diff';

export type WorkspaceToolOpenResponse = {
  tool: { id: WorkspaceToolId; label: string };
  service: SandboxService;
  session: Session;
};

export type ExternalResource = {
  id: string;
  sessionId: string;
  type: string;
  url: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  title?: string;
  runId?: string;
  messageId?: string;
};

export type CallbackDelivery = {
  id: string;
  sessionId: string;
  targetType: string;
  target: Record<string, unknown>;
  status: string;
  eventType: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
  runId?: string;
  messageId?: string;
  lastError?: string;
  nextAttemptAt?: string;
  lastAttemptAt?: string;
  deliveredAt?: string;
};

export type AuthUser = {
  id: string;
  username: string;
  role: 'viewer' | 'member' | 'admin';
  displayName?: string;
  avatarUrl?: string;
};

export async function getHealth(): Promise<Health> {
  return request<Health>('/health');
}

export async function getCurrentUser(): Promise<AuthUser | null> {
  const body = await request<{ user: AuthUser | null }>('/auth/me');
  return body.user;
}

export async function login(input: { username: string; password: string }): Promise<AuthUser> {
  const body = await request<{ user: AuthUser }>('/auth/login', {
    method: 'POST',
    body: { username: input.username, password: input.password },
  });
  return body.user;
}

export function githubLoginUrl(): string {
  return `${apiBaseUrl}/auth/oauth/github/start`;
}

export async function logout(): Promise<void> {
  await request<{ ok: true }>('/auth/logout', { method: 'POST', body: {} });
}

export async function listSessions(
  token: string,
  options: {
    cursor?: string;
    limit?: number;
    archived?: boolean;
    parentSessionId?: string;
  } & SessionListFilters = {},
): Promise<SessionPage> {
  const query = new URLSearchParams();
  if (options.cursor) query.set('cursor', options.cursor);
  if (options.limit !== undefined) query.set('limit', String(options.limit));
  if (options.archived !== undefined) query.set('archived', String(options.archived));
  if (options.parentSessionId) query.set('parentSessionId', options.parentSessionId);
  appendSessionFilterParams(query, options);
  const suffix = query.toString() ? `?${query.toString()}` : '';
  const body = await request<{ sessions: Session[]; nextCursor?: string | null }>(`/sessions${suffix}`, { token });
  return { sessions: body.sessions, nextCursor: body.nextCursor ?? null };
}

export async function searchSessions(
  token: string,
  options: { query: string; cursor?: string; limit?: number } & SessionListFilters,
): Promise<SessionSearchPage> {
  const query = new URLSearchParams({ q: options.query });
  if (options.cursor) query.set('cursor', options.cursor);
  if (options.limit !== undefined) query.set('limit', String(options.limit));
  appendSessionFilterParams(query, options);
  const body = await request<{ results: SessionSearchResult[]; nextCursor?: string | null }>(
    `/sessions/search?${query.toString()}`,
    { token },
  );
  return { results: body.results, nextCursor: body.nextCursor ?? null };
}

export async function listAutomations(token: string): Promise<Automation[]> {
  const body = await request<{ automations: Automation[] }>('/automations', { token });
  return body.automations;
}

export async function createAutomation(input: {
  name: string;
  prompt: string;
  scheduleCron: string;
  token: string;
  enabled?: boolean;
  environmentId?: string;
  environmentRevisionPolicy?: 'follow_latest' | 'pinned';
  environmentRevisionId?: string;
  environmentBranchOverrides?: EnvironmentBranchOverrideInput[];
  repository?: string | RepositoryInput;
  model?: string;
  reasoningLevel?: ReasoningLevel | '';
  branch?: string;
}): Promise<Automation> {
  const body = await request<{ automation: Automation }>('/automations', {
    method: 'POST',
    token: input.token,
    body: automationRequestBody(input),
  });
  return body.automation;
}

export async function updateAutomation(input: {
  automationId: string;
  token: string;
  name?: string;
  prompt?: string;
  scheduleCron?: string;
  enabled?: boolean;
  environmentId?: string;
  environmentRevisionPolicy?: 'follow_latest' | 'pinned';
  environmentRevisionId?: string;
  environmentBranchOverrides?: EnvironmentBranchOverrideInput[];
  repository?: string | RepositoryInput;
  model?: string;
  reasoningLevel?: ReasoningLevel | '';
  branch?: string;
}): Promise<Automation> {
  const body = await request<{ automation: Automation }>(`/automations/${input.automationId}`, {
    method: 'PATCH',
    token: input.token,
    body: automationRequestBody(input),
  });
  return body.automation;
}

export async function archiveAutomation(input: { automationId: string; token: string }): Promise<Automation> {
  const body = await request<{ automation: Automation }>(`/automations/${input.automationId}/archive`, {
    method: 'POST',
    token: input.token,
    body: {},
  });
  return body.automation;
}

export async function unarchiveAutomation(input: { automationId: string; token: string }): Promise<Automation> {
  const body = await request<{ automation: Automation }>(`/automations/${input.automationId}/unarchive`, {
    method: 'POST',
    token: input.token,
    body: {},
  });
  return body.automation;
}

export async function invokeAutomation(input: {
  automationId: string;
  token: string;
  allowDisabled?: boolean;
  allowOverlap?: boolean;
}): Promise<{ automation: Automation; invocation: AutomationInvocation; session?: Session; message?: Message }> {
  return request<{ automation: Automation; invocation: AutomationInvocation; session?: Session; message?: Message }>(
    `/automations/${input.automationId}/invoke`,
    {
      method: 'POST',
      token: input.token,
      body: {
        ...(input.allowDisabled ? { allowDisabled: true } : {}),
        ...(input.allowOverlap ? { allowOverlap: true } : {}),
      },
    },
  );
}

export async function listAutomationInvocations(input: {
  automationId: string;
  token: string;
  limit?: number;
  cursor?: string;
}): Promise<AutomationInvocationPage> {
  const query = new URLSearchParams();
  if (input.limit !== undefined) query.set('limit', String(input.limit));
  if (input.cursor) query.set('cursor', input.cursor);
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return request<AutomationInvocationPage>(`/automations/${input.automationId}/invocations${suffix}`, {
    token: input.token,
  });
}

export async function listRepositoryOptions(token: string): Promise<RepositoryOption[]> {
  const body = await request<{ repositories: RepositoryOption[] }>('/repositories', { token });
  return body.repositories;
}

export async function listEnvironments(token: string): Promise<Environment[]> {
  const body = await request<{ environments: Environment[] }>('/environments', { token });
  return body.environments;
}

export async function listEnvironmentRevisions(input: {
  environmentId: string;
  token: string;
}): Promise<EnvironmentRevision[]> {
  const body = await request<{ revisions: EnvironmentRevision[] }>(`/environments/${input.environmentId}/revisions`, {
    token: input.token,
  });
  return body.revisions ?? [];
}

export async function createEnvironment(input: {
  name: string;
  repositories: EnvironmentRepositoryInput[];
  token: string;
}): Promise<Environment> {
  const body = await request<{ environment: Environment }>('/environments', {
    method: 'POST',
    token: input.token,
    body: environmentRequestBody(input),
  });
  return body.environment;
}

export async function updateEnvironment(input: {
  environmentId: string;
  name: string;
  repositories: EnvironmentRepositoryInput[];
  token: string;
}): Promise<Environment> {
  const body = await request<{ environment: Environment }>(`/environments/${input.environmentId}`, {
    method: 'PATCH',
    token: input.token,
    body: environmentRequestBody(input),
  });
  return body.environment;
}

export async function archiveEnvironment(input: { environmentId: string; token: string }): Promise<Environment> {
  const body = await request<{ environment: Environment }>(`/environments/${input.environmentId}/archive`, {
    method: 'POST',
    token: input.token,
    body: {},
  });
  return body.environment;
}

export async function unarchiveEnvironment(input: { environmentId: string; token: string }): Promise<Environment> {
  const body = await request<{ environment: Environment }>(`/environments/${input.environmentId}/unarchive`, {
    method: 'POST',
    token: input.token,
    body: {},
  });
  return body.environment;
}

export async function listSkills(input: { token: string; archived?: boolean }): Promise<Skill[]> {
  const query = input.archived === undefined ? '' : `?archived=${String(input.archived)}`;
  const body = await request<{ skills: Skill[] }>(`/skills${query}`, { token: input.token });
  return body.skills;
}

export async function listSnippets(input: { token: string }): Promise<Snippet[]> {
  return (await request<{ snippets: Snippet[] }>('/snippets', { token: input.token })).snippets;
}
export async function createSnippet(input: { token: string; name: string; body: string }): Promise<Snippet> {
  return (
    await request<{ snippet: Snippet }>('/snippets', {
      method: 'POST',
      token: input.token,
      body: { name: input.name, body: input.body },
    })
  ).snippet;
}
export async function updateSnippet(input: {
  token: string;
  snippetId: string;
  name?: string;
  body?: string;
}): Promise<Snippet> {
  return (
    await request<{ snippet: Snippet }>(`/snippets/${input.snippetId}`, {
      method: 'PATCH',
      token: input.token,
      body: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.body !== undefined ? { body: input.body } : {}),
      },
    })
  ).snippet;
}
export async function archiveSnippet(input: { token: string; snippetId: string }): Promise<Snippet> {
  return (
    await request<{ snippet: Snippet }>(`/snippets/${input.snippetId}/archive`, {
      method: 'POST',
      token: input.token,
      body: {},
    })
  ).snippet;
}
export async function restoreSnippet(input: { token: string; snippetId: string }): Promise<Snippet> {
  return (
    await request<{ snippet: Snippet }>(`/snippets/${input.snippetId}/restore`, {
      method: 'POST',
      token: input.token,
      body: {},
    })
  ).snippet;
}

export async function listSessionSkills(input: { sessionId: string; token: string }): Promise<Skill[]> {
  const body = await request<{ skills: Skill[] }>(`/sessions/${input.sessionId}/skills`, { token: input.token });
  return body.skills;
}

export async function listSkillInvocationCandidates(input: { token: string }): Promise<Skill[]> {
  const body = await request<{ skills: Skill[] }>('/skills/invocation-candidates', {
    token: input.token,
  });
  return body.skills;
}

export async function getSkill(input: { skillId: string; token: string }): Promise<Skill> {
  const body = await request<{ skill: Skill }>(`/skills/${input.skillId}`, { token: input.token });
  return body.skill;
}

export async function listSkillRevisions(input: { skillId: string; token: string }): Promise<SkillRevision[]> {
  const body = await request<{ revisions: SkillRevision[] }>(`/skills/${input.skillId}/revisions`, {
    token: input.token,
  });
  return body.revisions ?? [];
}

export async function createSkill(input: {
  token: string;
  scope?: 'tenant' | 'personal';
  name: string;
  description: string;
  body: string;
  autoLoad?: boolean;
}): Promise<Skill> {
  const body = await request<{ skill: Skill }>('/skills', {
    method: 'POST',
    token: input.token,
    body: {
      ...(input.scope ? { scope: input.scope } : {}),
      name: input.name,
      description: input.description,
      body: input.body,
      ...(input.autoLoad !== undefined ? { autoLoad: input.autoLoad } : {}),
    },
  });
  return body.skill;
}

export async function updateSkill(input: {
  skillId: string;
  token: string;
  name?: string;
  description?: string;
  body?: string;
  autoLoad?: boolean;
  enabled?: boolean;
  expectedCurrentRevisionId?: string;
}): Promise<Skill> {
  const body = await request<{ skill: Skill }>(`/skills/${input.skillId}`, {
    method: 'PATCH',
    token: input.token,
    body: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.autoLoad !== undefined ? { autoLoad: input.autoLoad } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.expectedCurrentRevisionId ? { expectedCurrentRevisionId: input.expectedCurrentRevisionId } : {}),
    },
  });
  return body.skill;
}

export async function archiveSkill(input: { skillId: string; token: string }): Promise<Skill> {
  const body = await request<{ skill: Skill }>(`/skills/${input.skillId}/archive`, {
    method: 'POST',
    token: input.token,
    body: {},
  });
  return body.skill;
}

export async function restoreSkill(input: { skillId: string; token: string }): Promise<Skill> {
  const body = await request<{ skill: Skill }>(`/skills/${input.skillId}/restore`, {
    method: 'POST',
    token: input.token,
    body: {},
  });
  return body.skill;
}

function automationRequestBody(input: {
  name?: string;
  prompt?: string;
  scheduleCron?: string;
  enabled?: boolean;
  environmentId?: string;
  environmentRevisionPolicy?: 'follow_latest' | 'pinned';
  environmentRevisionId?: string;
  environmentBranchOverrides?: EnvironmentBranchOverrideInput[];
  repository?: string | RepositoryInput;
  model?: string;
  reasoningLevel?: ReasoningLevel | '';
  branch?: string;
}): Record<string, unknown> {
  const usesEnvironment = Boolean(input.environmentId);
  return {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
    ...(input.scheduleCron !== undefined ? { scheduleCron: input.scheduleCron } : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    ...(input.environmentId !== undefined ? { environmentId: input.environmentId } : {}),
    ...(input.environmentRevisionPolicy !== undefined
      ? { environmentRevisionPolicy: input.environmentRevisionPolicy }
      : {}),
    ...(input.environmentRevisionId !== undefined ? { environmentRevisionId: input.environmentRevisionId } : {}),
    ...(input.environmentBranchOverrides !== undefined
      ? { environmentBranchOverrides: input.environmentBranchOverrides }
      : {}),
    ...(!usesEnvironment && input.repository !== undefined ? { repository: input.repository } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.reasoningLevel !== undefined ? { reasoningLevel: input.reasoningLevel } : {}),
    ...(!usesEnvironment && input.branch !== undefined ? { branch: input.branch } : {}),
  };
}

function environmentRequestBody(input: {
  name: string;
  repositories: EnvironmentRepositoryInput[];
}): Record<string, unknown> {
  return {
    name: input.name,
    repositories: input.repositories,
  };
}

export async function listBranches(input: { repository: string; token: string }): Promise<BranchOption[]> {
  const [owner, repo] = input.repository.split('/');
  if (!owner || !repo) return [];
  const body = await request<{ branches: BranchOption[] }>(
    `/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches`,
    { token: input.token },
  );
  return body.branches;
}

export async function getModelChoices(token: string): Promise<ModelChoices> {
  return request<ModelChoices>('/models', { token });
}

export async function getSetupStatus(token: string): Promise<SetupStatus> {
  return request<SetupStatus>('/setup/status', { token });
}

export async function listUsers(input: { query?: string; token: string }): Promise<AuthUser[]> {
  const query = input.query ? `?query=${encodeURIComponent(input.query)}` : '';
  const body = await request<{ users: AuthUser[] }>(`/users${query}`, { token: input.token });
  return body.users;
}

export async function updateUserRole(input: {
  userId: string;
  role: AuthUser['role'];
  token: string;
}): Promise<AuthUser> {
  const body = await request<{ user: AuthUser }>(`/users/${input.userId}`, {
    method: 'PATCH',
    token: input.token,
    body: { role: input.role },
  });
  return body.user;
}

export async function createSession(input: {
  title?: string;
  visibility?: 'tenant' | 'private';
  token: string;
}): Promise<Session> {
  const body = await request<{ session: Session }>('/sessions', {
    method: 'POST',
    token: input.token,
    body: {
      ...(input.title ? { title: input.title } : {}),
      ...(input.visibility ? { visibility: input.visibility } : {}),
    },
  });
  return body.session;
}

export async function getSession(input: { sessionId: string; token: string }): Promise<Session> {
  const body = await request<{ session: Session }>(`/sessions/${input.sessionId}`, { token: input.token });
  return body.session;
}

export async function updateSession(input: { sessionId: string; title: string; token: string }): Promise<Session> {
  const body = await request<{ session: Session }>(`/sessions/${input.sessionId}`, {
    method: 'PATCH',
    token: input.token,
    body: { title: input.title },
  });
  return body.session;
}

export async function updateSessionTags(input: { sessionId: string; tags: string[]; token: string }): Promise<Session> {
  const body = await request<{ session: Session }>(`/sessions/${input.sessionId}`, {
    method: 'PATCH',
    token: input.token,
    body: { tags: input.tags },
  });
  return body.session;
}

export async function promoteSession(input: { sessionId: string; token: string }): Promise<Session> {
  const body = await request<{ session: Session }>(`/sessions/${input.sessionId}`, {
    method: 'PATCH',
    token: input.token,
    body: { visibility: 'tenant' },
  });
  return body.session;
}

export async function listSessionTags(token: string): Promise<SessionTagSummary[]> {
  const body = await request<{ tags: SessionTagSummary[] }>('/sessions/tags', { token });
  return body.tags;
}

export async function setSessionStarred(input: {
  sessionId: string;
  starred: boolean;
  token: string;
}): Promise<boolean> {
  const body = await request<{ starred: boolean }>(`/sessions/${input.sessionId}/star`, {
    method: input.starred ? 'PUT' : 'DELETE',
    token: input.token,
  });
  return body.starred;
}

export async function getSessionNotepad(input: { sessionId: string; token: string; signal?: AbortSignal }) {
  const body = await request<{ notepad: SessionNotepad }>(`/sessions/${input.sessionId}/notepad`, input);
  return body.notepad;
}
export async function getSessionNotepadMetadata(input: { sessionId: string; token: string; signal?: AbortSignal }) {
  const body = await request<{ notepad: SessionNotepadMetadata }>(
    `/sessions/${input.sessionId}/notepad?metadata=true`,
    input,
  );
  return body.notepad;
}
export async function replaceSessionNotepad(input: {
  sessionId: string;
  content: string;
  expectedRevision: number;
  token: string;
}) {
  const body = await request<{ notepad: SessionNotepad }>(`/sessions/${input.sessionId}/notepad`, {
    method: 'PUT',
    token: input.token,
    body: { content: input.content, expectedRevision: input.expectedRevision },
  });
  return body.notepad;
}
export async function getSessionNotepadHistory(input: { sessionId: string; token: string; cursor?: string }) {
  const query = input.cursor === undefined ? '' : `?cursor=${encodeURIComponent(input.cursor)}`;
  return request<NotepadRevisionPage>(`/sessions/${input.sessionId}/notepad/history${query}`, {
    token: input.token,
  });
}
export async function getSessionNotepadRevision(input: { sessionId: string; revision: number; token: string }) {
  const body = await request<{ revision: NotepadRevisionWithContent }>(
    `/sessions/${input.sessionId}/notepad/history/${input.revision}`,
    { token: input.token },
  );
  return body.revision;
}
export async function restoreSessionNotepad(input: {
  sessionId: string;
  revision: number;
  expectedRevision: number;
  token: string;
}) {
  const body = await request<{ notepad: SessionNotepad }>(
    `/sessions/${input.sessionId}/notepad/restore/${input.revision}`,
    { method: 'POST', token: input.token, body: { expectedRevision: input.expectedRevision } },
  );
  return body.notepad;
}
export async function listSessionNotepadAssociations(input: {
  sessionId: string;
  token: string;
  cursor?: string;
  signal?: AbortSignal;
}) {
  const query = input.cursor === undefined ? '' : `?cursor=${encodeURIComponent(input.cursor)}`;
  const body = await request<{ associations: SessionNotepadAssociationPage }>(
    `/sessions/${input.sessionId}/notepad-associations${query}`,
    input,
  );
  return body.associations;
}
export async function createExplicitNotepad(input: {
  title: string;
  content?: string;
  initialWritableSessionId?: string;
  token: string;
}) {
  const body = await request<{ notepad: ExplicitNotepad }>('/notepads', {
    method: 'POST',
    token: input.token,
    body: {
      title: input.title,
      ...(input.content !== undefined ? { content: input.content } : {}),
      ...(input.initialWritableSessionId ? { initialWritableSessionId: input.initialWritableSessionId } : {}),
    },
  });
  return body.notepad;
}
export async function listExplicitNotepads(input: {
  token: string;
  cursor?: string;
  limit?: number;
  archived?: boolean;
}) {
  const query = notepadCollectionQuery(input);
  const body = await request<{ notepads: ExplicitNotepadPage }>(`/notepads${query}`, input);
  return body.notepads;
}
export async function inventoryExplicitNotepads(input: {
  token: string;
  cursor?: string;
  limit?: number;
  archived?: boolean;
}) {
  const query = notepadCollectionQuery(input);
  const body = await request<{ notepads: ExplicitNotepadPage }>(`/notepads/inventory${query}`, input);
  return body.notepads;
}
export async function searchExplicitNotepads(input: {
  token: string;
  query: string;
  limit?: number;
  archived?: boolean;
}) {
  const query = new URLSearchParams({ q: input.query });
  if (input.limit !== undefined) query.set('limit', String(input.limit));
  if (input.archived) query.set('archived', 'true');
  const body = await request<{ results: ExplicitNotepadSearchResult[] }>(`/notepads/search?${query}`, input);
  return body.results;
}
export async function updateExplicitNotepad(input: { id: string; title: string; token: string }) {
  const body = await request<{ notepad: ExplicitNotepad }>(`/notepads/${input.id}`, {
    method: 'PATCH',
    token: input.token,
    body: { title: input.title },
  });
  return body.notepad;
}
export async function archiveExplicitNotepad(input: { id: string; token: string }) {
  const body = await request<{ notepad: ExplicitNotepad }>(`/notepads/${input.id}/archive`, {
    method: 'POST',
    token: input.token,
    body: {},
  });
  return body.notepad;
}
export async function restoreExplicitNotepad(input: { id: string; token: string }) {
  const body = await request<{ notepad: ExplicitNotepad }>(`/notepads/${input.id}/restore`, {
    method: 'POST',
    token: input.token,
    body: {},
  });
  return body.notepad;
}

function notepadCollectionQuery(input: { cursor?: string; limit?: number; archived?: boolean }) {
  const query = new URLSearchParams();
  if (input.cursor !== undefined) query.set('cursor', input.cursor);
  if (input.limit !== undefined) query.set('limit', String(input.limit));
  if (input.archived) query.set('archived', 'true');
  return query.size ? `?${query}` : '';
}
export async function getExplicitNotepad(input: { id: string; token: string; associatedSessionId?: string }) {
  const query = input.associatedSessionId ? `?sessionId=${encodeURIComponent(input.associatedSessionId)}` : '';
  const body = await request<{ notepad: ExplicitNotepad }>(`/notepads/${input.id}${query}`, { token: input.token });
  return body.notepad;
}
export async function replaceExplicitNotepad(input: {
  id: string;
  content: string;
  expectedRevision: number;
  token: string;
  associatedSessionId?: string;
}) {
  const query = input.associatedSessionId ? `?sessionId=${encodeURIComponent(input.associatedSessionId)}` : '';
  const body = await request<{ notepad: ExplicitNotepad }>(`/notepads/${input.id}/content${query}`, {
    method: 'PUT',
    token: input.token,
    body: { content: input.content, expectedRevision: input.expectedRevision },
  });
  return body.notepad;
}
export async function getExplicitNotepadHistory(input: {
  id: string;
  token: string;
  cursor?: string;
  associatedSessionId?: string;
}) {
  const query = new URLSearchParams();
  if (input.cursor !== undefined) query.set('cursor', input.cursor);
  if (input.associatedSessionId) query.set('sessionId', input.associatedSessionId);
  const suffix = query.size ? `?${query}` : '';
  return request<NotepadRevisionPage>(`/notepads/${input.id}/history${suffix}`, { token: input.token });
}
export async function getExplicitNotepadRevision(input: {
  id: string;
  revision: number;
  token: string;
  associatedSessionId?: string;
}) {
  const query = input.associatedSessionId ? `?sessionId=${encodeURIComponent(input.associatedSessionId)}` : '';
  const body = await request<{ revision: NotepadRevisionWithContent }>(
    `/notepads/${input.id}/history/${input.revision}${query}`,
    { token: input.token },
  );
  return body.revision;
}
export async function restoreExplicitNotepadRevision(input: {
  id: string;
  revision: number;
  expectedRevision: number;
  token: string;
  associatedSessionId?: string;
}) {
  const query = input.associatedSessionId ? `?sessionId=${encodeURIComponent(input.associatedSessionId)}` : '';
  const body = await request<{ notepad: ExplicitNotepad }>(
    `/notepads/${input.id}/history/${input.revision}/restore${query}`,
    {
      method: 'POST',
      token: input.token,
      body: { expectedRevision: input.expectedRevision },
    },
  );
  return body.notepad;
}
export async function grantNotepadAssociation(input: { id: string; sessionId: string; token: string }) {
  const body = await request<{ association: NotepadAssociation }>(
    `/notepads/${input.id}/associations/${input.sessionId}`,
    { method: 'PUT', token: input.token },
  );
  return body.association;
}
export async function removeNotepadAssociation(input: { id: string; sessionId: string; token: string }) {
  const body = await request<{ removed: boolean }>(`/notepads/${input.id}/associations/${input.sessionId}`, {
    method: 'DELETE',
    token: input.token,
  });
  return body.removed;
}

export async function archiveSession(input: { sessionId: string; token: string }): Promise<Session> {
  const body = await request<{ session: Session }>(`/sessions/${input.sessionId}/archive`, {
    method: 'POST',
    token: input.token,
    body: {},
  });
  return body.session;
}

export async function unarchiveSession(input: { sessionId: string; token: string }): Promise<Session> {
  const body = await request<{ session: Session }>(`/sessions/${input.sessionId}/unarchive`, {
    method: 'POST',
    token: input.token,
    body: {},
  });
  return body.session;
}

export async function listMessages(sessionId: string, token: string, options: RequestOptions = {}): Promise<Message[]> {
  const body = await request<{ messages: Message[] }>(`/sessions/${sessionId}/messages`, { token, ...options });
  return body.messages;
}

export async function enqueueMessage(input: {
  sessionId: string;
  prompt: string;
  token: string;
  generateTitle?: boolean;
  environmentId?: string;
  environmentBranchOverrides?: EnvironmentBranchOverrideInput[];
  repository?: string | RepositoryInput;
  model?: string;
  reasoningLevel?: ReasoningLevel;
  branch?: string;
  skills?: string[];
  skillRefs?: SkillInvocationRef[];
}): Promise<Message> {
  const requestBody: {
    prompt: string;
    generateTitle?: boolean;
    environmentId?: string;
    environmentBranchOverrides?: EnvironmentBranchOverrideInput[];
    repository?: string | RepositoryInput;
    model?: string;
    reasoningLevel?: ReasoningLevel;
    branch?: string;
    context?: { skills: string[]; skillRefs?: SkillInvocationRef[] };
  } = {
    prompt: input.prompt,
  };
  if (input.generateTitle) requestBody.generateTitle = true;
  if (input.environmentId) requestBody.environmentId = input.environmentId;
  if (input.environmentBranchOverrides) requestBody.environmentBranchOverrides = input.environmentBranchOverrides;
  if (input.repository) requestBody.repository = input.repository;
  if (input.model) requestBody.model = input.model;
  if (input.reasoningLevel) requestBody.reasoningLevel = input.reasoningLevel;
  if (input.branch) requestBody.branch = input.branch;
  if (input.skills?.length) {
    requestBody.context = { skills: input.skills, ...(input.skillRefs ? { skillRefs: input.skillRefs } : {}) };
  }
  const body = await request<{ message: Message }>(`/sessions/${input.sessionId}/messages`, {
    method: 'POST',
    token: input.token,
    body: requestBody,
  });
  return body.message;
}

export async function updateMessage(input: {
  sessionId: string;
  messageId: string;
  prompt: string;
  token: string;
  skills?: string[];
  skillRefs?: SkillInvocationRef[];
}): Promise<Message> {
  const body = await request<{ message: Message }>(`/sessions/${input.sessionId}/messages/${input.messageId}`, {
    method: 'PATCH',
    token: input.token,
    body: {
      prompt: input.prompt,
      ...(input.skills
        ? { context: { skills: input.skills, ...(input.skillRefs ? { skillRefs: input.skillRefs } : {}) } }
        : {}),
    },
  });
  return body.message;
}

export async function updateMessageSteering(input: {
  sessionId: string;
  messageId: string;
  steering: boolean;
  token: string;
}): Promise<Message> {
  const body = await request<{ message: Message }>(`/sessions/${input.sessionId}/messages/${input.messageId}`, {
    method: 'PATCH',
    token: input.token,
    body: { steering: input.steering },
  });
  return body.message;
}

export async function cancelMessage(input: { sessionId: string; messageId: string; token: string }): Promise<Message> {
  const body = await request<{ message: Message }>(`/sessions/${input.sessionId}/messages/${input.messageId}/cancel`, {
    method: 'POST',
    token: input.token,
    body: {},
  });
  return body.message;
}

export async function retryMessage(input: { sessionId: string; messageId: string; token: string }): Promise<Message> {
  const body = await request<{ message: Message }>(`/sessions/${input.sessionId}/messages/${input.messageId}/retry`, {
    method: 'POST',
    token: input.token,
    body: {},
  });
  return body.message;
}

export async function cancelCurrentRun(input: { sessionId: string; token: string }): Promise<Message[]> {
  const body = await request<{ messages: Message[] }>(`/sessions/${input.sessionId}/runs/current/cancel`, {
    method: 'POST',
    token: input.token,
    body: {},
  });
  return body.messages;
}

export async function pauseQueue(input: { sessionId: string; token: string }): Promise<Session> {
  const body = await request<{ session: Session }>(`/sessions/${input.sessionId}/queue/pause`, {
    method: 'POST',
    token: input.token,
    body: {},
  });
  return body.session;
}

export async function resumeQueue(input: { sessionId: string; token: string }): Promise<Session> {
  const body = await request<{ session: Session }>(`/sessions/${input.sessionId}/queue/resume`, {
    method: 'POST',
    token: input.token,
    body: {},
  });
  return body.session;
}

export async function listEvents(
  sessionId: string,
  token: string,
  after?: number,
  options: RequestOptions = {},
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  let cursor = after;

  while (true) {
    const params = new URLSearchParams({ limit: String(sessionEventPageLimit) });
    if (cursor !== undefined) params.set('after', String(cursor));

    const body = await request<AgentEventPage>(`/sessions/${sessionId}/events?${params}`, { token, ...options });
    events.push(...body.events);

    const nextCursor = body.cursor;
    if (!body.hasMore || typeof nextCursor !== 'number' || body.events.length === 0) return events;
    if (nextCursor <= (cursor ?? 0)) return events;
    cursor = nextCursor;
  }
}

export async function listIncrementalEvents(
  sessionId: string,
  token: string,
  after: number,
  options: RequestOptions = {},
): Promise<AgentEvent[]> {
  const params = new URLSearchParams({ limit: String(sessionEventPageLimit), after: String(after) });
  const body = await request<AgentEventPage>(`/sessions/${sessionId}/events?${params}`, { token, ...options });
  return body.events;
}

export async function listArtifacts(
  sessionId: string,
  token: string,
  options: RequestOptions = {},
): Promise<Artifact[]> {
  const body = await request<{ artifacts: Artifact[] }>(`/sessions/${sessionId}/artifacts`, { token, ...options });
  return body.artifacts;
}

export async function getArtifactPreview(input: {
  sessionId: string;
  artifactId: string;
  token: string;
}): Promise<ArtifactPreview> {
  const body = await request<ArtifactPreviewResponse>(
    `/sessions/${input.sessionId}/artifacts/${input.artifactId}/preview`,
    { token: input.token },
  );
  return body.preview;
}

export async function listServices(
  sessionId: string,
  token: string,
  options: RequestOptions = {},
): Promise<SandboxService[]> {
  const body = await request<{ services: SandboxService[] }>(`/sessions/${sessionId}/services`, { token, ...options });
  return body.services;
}

export async function extendSandbox(input: {
  sessionId: string;
  token: string;
  seconds: number;
  port?: number;
}): Promise<SandboxKeepalive> {
  const body = await request<{ sandbox: SandboxKeepalive }>(`/sessions/${input.sessionId}/sandbox/extend`, {
    method: 'POST',
    token: input.token,
    body: { seconds: input.seconds, ...(input.port ? { port: input.port } : {}) },
  });
  return body.sandbox;
}

export async function openWorkspaceTool(input: {
  sessionId: string;
  toolId: WorkspaceToolId;
  token: string;
}): Promise<WorkspaceToolOpenResponse> {
  return request<WorkspaceToolOpenResponse>(`/sessions/${input.sessionId}/workspace-tools/${input.toolId}/open`, {
    method: 'POST',
    token: input.token,
    body: {},
  });
}

export async function listExternalResources(
  sessionId: string,
  token: string,
  options: RequestOptions = {},
): Promise<ExternalResource[]> {
  const body = await request<{ externalResources: ExternalResource[] }>(`/sessions/${sessionId}/external-resources`, {
    token,
    ...options,
  });
  return body.externalResources;
}

export async function listCallbacks(
  sessionId: string,
  token: string,
  options: RequestOptions = {},
): Promise<CallbackDelivery[]> {
  const body = await request<{ callbacks: CallbackDelivery[] }>(`/sessions/${sessionId}/callbacks`, {
    token,
    ...options,
  });
  return body.callbacks;
}

export async function replayCallback(input: {
  sessionId: string;
  callbackId: string;
  token: string;
}): Promise<CallbackDelivery> {
  const body = await request<{ callback: CallbackDelivery }>(
    `/sessions/${input.sessionId}/callbacks/${input.callbackId}/replay`,
    {
      method: 'POST',
      token: input.token,
      body: {},
    },
  );
  return body.callback;
}

export async function streamEvents(input: {
  sessionId: string;
  after: number;
  token: string;
  signal: AbortSignal;
  onOpen?: () => void;
  onEvent: (event: AgentEvent) => void;
}): Promise<void> {
  await streamEventResponse(`/sessions/${input.sessionId}/events/stream?after=${input.after}`, input);
}

function appendSessionFilterParams(query: URLSearchParams, options: SessionListFilters): void {
  if (options.tags?.length) query.set('tags', options.tags.join(','));
  if (options.createdBy) query.set('createdBy', options.createdBy);
  if (options.participant) query.set('participant', options.participant);
  if (options.starred) query.set('starred', options.starred);
}

export async function streamGlobalEvents(input: {
  after: number;
  token: string;
  signal: AbortSignal;
  onOpen?: () => void;
  onEvent: (event: AgentEvent) => void;
}): Promise<void> {
  const replay = input.after > 0 ? 'true' : 'false';
  await streamEventResponse(`/events/stream?after=${input.after}&include=all&replay=${replay}`, input);
}
