import { apiBaseUrl, request, streamEventResponse, type RequestOptions } from './api-request.js';

export { ApiError, apiConnectionDelayedEvent, apiConnectionOkEvent, getApiBaseUrl } from './api-request.js';

export type ApiAuthMode = 'none' | 'bearer' | 'session';
export type AuthProvider = 'static' | 'github';

export type Health = {
  status: 'ok' | 'degraded';
  runMode: string;
  apiAuthMode: ApiAuthMode;
  authProvider?: AuthProvider;
  sandboxProvider?: string;
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
  status: string;
  displayStatus?: string;
  displayStatusTooltip?: string;
  ownerGroupId: string;
  ownerGroupName?: string;
  visibility: SessionVisibility;
  writePolicy: SessionWritePolicy;
  createdByUserId?: string;
  createdAt: string;
  updatedAt: string;
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

export type Automation = {
  id: string;
  kind: 'scheduled';
  name: string;
  prompt: string;
  scheduleCron: string;
  scheduleTimezone: 'UTC';
  enabled: boolean;
  ownerGroupId: string;
  ownerGroupName?: string;
  ownerGroupArchivedAt?: string;
  visibility: SessionVisibility;
  writePolicy: SessionWritePolicy;
  createdByUserId?: string;
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
  reason?: string;
  error?: string;
};

export type AutomationInvocationPage = {
  invocations: AutomationInvocation[];
  nextCursor?: string;
};

export type GroupRole = 'viewer' | 'member' | 'admin';
export type AutomationCreateRequiredRole = 'member' | 'admin';
export type SessionVisibility = 'group' | 'organization';
export type SessionWritePolicy = 'group_members' | 'creator_only';

export type Group = {
  id: string;
  name: string;
  defaultVisibility: SessionVisibility;
  defaultWritePolicy: SessionWritePolicy;
  automationCreateRequiredRole: AutomationCreateRequiredRole;
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
  membershipRole?: GroupRole | null;
  canCreateSessions: boolean;
  canCreateAutomations: boolean;
  canManage: boolean;
};

export type GroupMember = {
  groupId: string;
  userId: string;
  role: GroupRole;
  createdAt: string;
  updatedAt: string;
  user?: AuthUser;
};

export type Message = {
  id: string;
  sessionId: string;
  sequence: number;
  status: string;
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

export type RepositoryOption = {
  fullName: string;
  owner: string;
  name: string;
  defaultBranch?: string;
};

export type BranchOption = { name: string };

export type ModelChoices = {
  models: string[];
  modelChoices: ModelChoice[];
  defaultModel: string | null;
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
  role: 'user' | 'super_admin';
  displayName?: string;
  avatarUrl?: string;
  memberships?: GroupMember[];
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

export async function listSessions(token: string): Promise<Session[]> {
  const body = await request<{ sessions: Session[] }>('/sessions', { token });
  return body.sessions;
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
  ownerGroupId?: string;
  enabled?: boolean;
  repository?: string | RepositoryInput;
  model?: string;
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
  ownerGroupId?: string;
  repository?: string | RepositoryInput;
  model?: string;
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

function automationRequestBody(input: {
  name?: string;
  prompt?: string;
  scheduleCron?: string;
  ownerGroupId?: string;
  enabled?: boolean;
  repository?: string | RepositoryInput;
  model?: string;
  branch?: string;
}): Record<string, unknown> {
  return {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
    ...(input.scheduleCron !== undefined ? { scheduleCron: input.scheduleCron } : {}),
    ...(input.ownerGroupId ? { ownerGroupId: input.ownerGroupId } : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    ...(input.repository !== undefined ? { repository: input.repository } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.branch !== undefined ? { branch: input.branch } : {}),
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

export async function listGroups(token: string): Promise<Group[]> {
  const body = await request<{ groups: Group[] }>('/groups', { token });
  return body.groups;
}

export async function createGroup(input: {
  name: string;
  defaultVisibility: SessionVisibility;
  defaultWritePolicy: SessionWritePolicy;
  automationCreateRequiredRole: AutomationCreateRequiredRole;
  token: string;
}): Promise<Group> {
  const body = await request<{ group: Group }>('/groups', {
    method: 'POST',
    token: input.token,
    body: {
      name: input.name,
      defaultVisibility: input.defaultVisibility,
      defaultWritePolicy: input.defaultWritePolicy,
      automationCreateRequiredRole: input.automationCreateRequiredRole,
    },
  });
  return body.group;
}

export async function updateGroup(input: {
  groupId: string;
  name: string;
  defaultVisibility: SessionVisibility;
  defaultWritePolicy: SessionWritePolicy;
  automationCreateRequiredRole: AutomationCreateRequiredRole;
  archived?: boolean;
  token: string;
}): Promise<Group> {
  const body = await request<{ group: Group }>(`/groups/${input.groupId}`, {
    method: 'PATCH',
    token: input.token,
    body: {
      name: input.name,
      defaultVisibility: input.defaultVisibility,
      defaultWritePolicy: input.defaultWritePolicy,
      automationCreateRequiredRole: input.automationCreateRequiredRole,
      ...(input.archived === undefined ? {} : { archived: input.archived }),
    },
  });
  return body.group;
}

export async function archiveGroup(input: { groupId: string; archived: boolean; token: string }): Promise<Group> {
  const body = await request<{ group: Group }>(`/groups/${input.groupId}`, {
    method: 'PATCH',
    token: input.token,
    body: { archived: input.archived },
  });
  return body.group;
}

export async function listGroupMembers(input: { groupId: string; token: string }): Promise<GroupMember[]> {
  const body = await request<{ members: GroupMember[] }>(`/groups/${input.groupId}/members`, { token: input.token });
  return body.members;
}

export async function upsertGroupMember(input: {
  groupId: string;
  userId: string;
  role: GroupRole;
  token: string;
}): Promise<GroupMember> {
  const body = await request<{ member: GroupMember }>(`/groups/${input.groupId}/members`, {
    method: 'POST',
    token: input.token,
    body: { userId: input.userId, role: input.role },
  });
  return body.member;
}

export async function removeGroupMember(input: { groupId: string; userId: string; token: string }): Promise<void> {
  await request<{ ok: true }>(`/groups/${input.groupId}/members/${input.userId}`, {
    method: 'DELETE',
    token: input.token,
  });
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
  token: string;
  ownerGroupId?: string;
  visibility?: SessionVisibility;
  writePolicy?: SessionWritePolicy;
}): Promise<Session> {
  const body = await request<{ session: Session }>('/sessions', {
    method: 'POST',
    token: input.token,
    body: {
      ...(input.title ? { title: input.title } : {}),
      ...(input.ownerGroupId ? { ownerGroupId: input.ownerGroupId } : {}),
      ...(input.visibility ? { visibility: input.visibility } : {}),
      ...(input.writePolicy ? { writePolicy: input.writePolicy } : {}),
    },
  });
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

export async function updateSessionAccess(input: {
  sessionId: string;
  ownerGroupId: string;
  visibility?: SessionVisibility;
  writePolicy?: SessionWritePolicy;
  token: string;
}): Promise<Session> {
  const body = await request<{ session: Session }>(`/sessions/${input.sessionId}/access`, {
    method: 'PATCH',
    token: input.token,
    body: {
      ownerGroupId: input.ownerGroupId,
      ...(input.visibility ? { visibility: input.visibility } : {}),
      ...(input.writePolicy ? { writePolicy: input.writePolicy } : {}),
    },
  });
  return body.session;
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
  repository?: string | RepositoryInput;
  model?: string;
  branch?: string;
}): Promise<Message> {
  const requestBody: { prompt: string; repository?: string | RepositoryInput; model?: string; branch?: string } = {
    prompt: input.prompt,
  };
  if (input.repository) requestBody.repository = input.repository;
  if (input.model) requestBody.model = input.model;
  if (input.branch) requestBody.branch = input.branch;
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
}): Promise<Message> {
  const body = await request<{ message: Message }>(`/sessions/${input.sessionId}/messages/${input.messageId}`, {
    method: 'PATCH',
    token: input.token,
    body: { prompt: input.prompt },
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
  const body = await request<{ events: AgentEvent[] }>(
    `/sessions/${sessionId}/events${after ? `?after=${after}` : ''}`,
    { token, ...options },
  );
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
  onEvent: (event: AgentEvent) => void;
}): Promise<void> {
  await streamEventResponse(`/sessions/${input.sessionId}/events/stream?after=${input.after}`, input);
}

export async function streamGlobalEvents(input: {
  after: number;
  token: string;
  signal: AbortSignal;
  onEvent: (event: AgentEvent) => void;
}): Promise<void> {
  const replay = input.after > 0 ? 'true' : 'false';
  await streamEventResponse(`/events/stream?after=${input.after}&include=all&replay=${replay}`, input);
}
