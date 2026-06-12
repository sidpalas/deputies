import type { NormalizedEvent } from '../events/types.js';
import { defaultGroupId, StoreConflictError } from './types.js';
import type {
  AppStore,
  ArtifactRecord,
  AutomationInvocationRecord,
  AutomationRecord,
  AuthAccountRecord,
  AuthSessionRecord,
  AuthUserRecord,
  CallbackDeliveryRecord,
  CreateAutomationInvocationRecord,
  CreateAutomationRecord,
  CreateArtifactRecord,
  CreateCallbackDeliveryRecord,
  CreateExternalResourceRecord,
  CreateSandboxRecord,
  CreateWebhookSourceRecord,
  ExternalResourceRecord,
  ExternalThreadRecord,
  GroupMemberRecord,
  GroupMemberWithUserRecord,
  GroupRecord,
  IntegrationDeliveryRecord,
  EventRecord,
  EventDeltaCompactionInput,
  CreateMessageRecord,
  CreateSessionRecord,
  ClaimedMessage,
  ClaimedMessageBatch,
  ListAutomationInvocationsOptions,
  MessageRecord,
  RecoveredRun,
  RunRecord,
  SandboxRecord,
  SandboxSecrets,
  SessionRecord,
  SessionVisibilityFilter,
  SessionWithSandboxRecord,
  UpdateAutomationRecord,
  UpsertAuthUserForAccountRecord,
  WebhookSourceRecord,
} from './types.js';

const staleCallbackSendingMs = 15 * 60_000;
const defaultGroupCreatedAt = new Date(0);

export class MemoryStore implements AppStore {
  private readonly authUsers = new Map<string, AuthUserRecord>();
  private readonly authAccounts = new Map<string, AuthAccountRecord>();
  private readonly authSessions = new Map<string, AuthSessionRecord>();
  private readonly groups = new Map<string, GroupRecord>([
    [
      defaultGroupId,
      {
        id: defaultGroupId,
        name: 'Default',
        defaultVisibility: 'organization',
        defaultWritePolicy: 'group_members',
        automationCreateRequiredRole: 'member',
        createdAt: defaultGroupCreatedAt,
        updatedAt: defaultGroupCreatedAt,
      },
    ],
  ]);
  private readonly groupMembers = new Map<string, GroupMemberRecord>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly messages = new Map<string, MessageRecord[]>();
  private readonly runs = new Map<string, RunRecord>();
  private readonly events = new Map<string, EventRecord[]>();
  private nextEventId = 1;
  private readonly sandboxes = new Map<string, SandboxRecord>();
  private readonly sandboxSecrets = new Map<string, SandboxSecrets>();
  private readonly artifacts = new Map<string, ArtifactRecord>();
  private readonly externalResources = new Map<string, ExternalResourceRecord>();
  private readonly callbacks = new Map<string, CallbackDeliveryRecord>();
  private readonly automations = new Map<string, AutomationRecord>();
  private readonly automationInvocations = new Map<string, AutomationInvocationRecord>();
  private readonly webhookSources = new Map<string, WebhookSourceRecord>();
  private readonly externalThreads = new Map<string, ExternalThreadRecord>();
  private readonly integrationDeliveries = new Map<string, IntegrationDeliveryRecord>();

  async upsertAuthUserForAccount(record: UpsertAuthUserForAccountRecord): Promise<AuthUserRecord> {
    const accountKey = authAccountKey(record.provider, record.providerAccountId);
    const existingAccount = this.authAccounts.get(accountKey);
    const existingUser = existingAccount ? this.authUsers.get(existingAccount.userId) : undefined;
    const user: AuthUserRecord = {
      id: existingUser?.id ?? record.userId,
      username: record.username,
      role: existingUser?.role === 'super_admin' ? 'super_admin' : record.role,
      createdAt: existingUser?.createdAt ?? record.now,
      updatedAt: record.now,
      ...(record.displayName ? { displayName: record.displayName } : {}),
      ...(record.avatarUrl ? { avatarUrl: record.avatarUrl } : {}),
    };
    const account: AuthAccountRecord = {
      id: existingAccount?.id ?? record.accountId,
      userId: user.id,
      provider: record.provider,
      providerAccountId: record.providerAccountId,
      username: record.username,
      profile: record.profile,
      createdAt: existingAccount?.createdAt ?? record.now,
      updatedAt: record.now,
    };

    this.authUsers.set(user.id, user);
    this.authAccounts.set(accountKey, account);
    return user;
  }

  async createAuthSession(record: AuthSessionRecord): Promise<AuthSessionRecord> {
    this.authSessions.set(record.id, record);
    return record;
  }

  async getAuthUserBySession(input: { sessionId: string; now: Date }): Promise<AuthUserRecord | null> {
    const session = this.authSessions.get(input.sessionId);
    if (!session || session.expiresAt <= input.now) return null;
    return this.authUsers.get(session.userId) ?? null;
  }

  async deleteAuthSession(sessionId: string): Promise<void> {
    this.authSessions.delete(sessionId);
  }

  async listAuthUsers(input: { query?: string } = {}): Promise<AuthUserRecord[]> {
    const query = input.query?.trim().toLowerCase();
    return [...this.authUsers.values()]
      .filter((user) => {
        if (!query) return true;
        return (
          user.username.toLowerCase().includes(query) ||
          user.displayName?.toLowerCase().includes(query) ||
          user.id.toLowerCase() === query
        );
      })
      .sort((a, b) => a.username.localeCompare(b.username));
  }

  async updateAuthUserRole(input: { userId: string; role: AuthUserRecord['role']; updatedAt: Date }) {
    const user = this.authUsers.get(input.userId);
    if (!user) return null;
    const updated = { ...user, role: input.role, updatedAt: input.updatedAt };
    this.authUsers.set(input.userId, updated);
    return updated;
  }

  async createGroup(record: GroupRecord): Promise<GroupRecord> {
    if (this.groups.has(record.id)) throw new Error(`Group already exists: ${record.id}`);
    const group = { ...record, name: record.name.trim() };
    this.assertUniqueGroupName(group.name);
    this.groups.set(group.id, group);
    return group;
  }

  async getGroup(id: string): Promise<GroupRecord | null> {
    return this.groups.get(id) ?? null;
  }

  async listGroups(): Promise<GroupRecord[]> {
    return [...this.groups.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async updateGroup(record: GroupRecord): Promise<GroupRecord> {
    if (!this.groups.has(record.id)) throw new Error(`Group does not exist: ${record.id}`);
    const group = { ...record, name: record.name.trim() };
    this.assertUniqueGroupName(group.name, group.id);
    this.groups.set(group.id, group);
    return group;
  }

  private assertUniqueGroupName(name: string, currentGroupId?: string): void {
    const key = normalizedGroupName(name);
    const duplicate = [...this.groups.values()].some(
      (group) => group.id !== currentGroupId && normalizedGroupName(group.name) === key,
    );
    if (duplicate) throw new StoreConflictError('group_name_exists', 'Group name already exists');
  }

  async upsertGroupMember(record: GroupMemberRecord): Promise<GroupMemberRecord> {
    if (!this.groups.has(record.groupId)) throw new Error(`Group does not exist: ${record.groupId}`);
    if (!this.authUsers.has(record.userId)) throw new Error(`Auth user does not exist: ${record.userId}`);
    const key = groupMemberKey(record.groupId, record.userId);
    const existing = this.groupMembers.get(key);
    const member = existing ? { ...record, createdAt: existing.createdAt } : record;
    this.groupMembers.set(key, member);
    return member;
  }

  async deleteGroupMember(input: { groupId: string; userId: string }): Promise<void> {
    this.groupMembers.delete(groupMemberKey(input.groupId, input.userId));
  }

  async getGroupMember(input: { groupId: string; userId: string }): Promise<GroupMemberRecord | null> {
    return this.groupMembers.get(groupMemberKey(input.groupId, input.userId)) ?? null;
  }

  async listGroupMembers(groupId: string): Promise<GroupMemberWithUserRecord[]> {
    return [...this.groupMembers.values()]
      .filter((member) => member.groupId === groupId)
      .map((member) => {
        const user = this.authUsers.get(member.userId);
        if (!user) throw new Error(`Auth user does not exist: ${member.userId}`);
        return { ...member, user };
      })
      .sort((a, b) => a.user.username.localeCompare(b.user.username));
  }

  async listUserGroupMemberships(userId: string): Promise<GroupMemberRecord[]> {
    return [...this.groupMembers.values()].filter((member) => member.userId === userId);
  }

  async createSession(record: CreateSessionRecord): Promise<SessionRecord> {
    if (this.sessions.has(record.id)) {
      throw new Error(`Session already exists: ${record.id}`);
    }

    this.sessions.set(record.id, record);
    return record;
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    return this.sessions.get(id) ?? null;
  }

  async listSessions(): Promise<SessionRecord[]> {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }

  async listSessionsWithLatestSandbox(
    provider: string,
    visibleTo?: SessionVisibilityFilter,
  ): Promise<SessionWithSandboxRecord[]> {
    const sessions = (await this.listSessions()).filter(
      (session) =>
        !visibleTo || session.visibility === 'organization' || visibleTo.groupIds.includes(session.ownerGroupId),
    );
    return Promise.all(
      sessions.map(async (session) => ({
        session,
        sandbox: await this.getLatestSandbox(session.id, provider),
      })),
    );
  }

  async updateSession(record: SessionRecord): Promise<SessionRecord> {
    if (!this.sessions.has(record.id)) {
      throw new Error(`Session does not exist: ${record.id}`);
    }

    this.sessions.set(record.id, record);
    return record;
  }

  async updateSessionWithEvent(
    record: SessionRecord,
    event: NormalizedEvent,
  ): Promise<{ session: SessionRecord; event: EventRecord }> {
    const session = await this.updateSession(record);
    return { session, event: await this.appendEventWithNextSequence(event) };
  }

  async archiveSession(input: { sessionId: string; archivedAt: Date }): Promise<{
    session: SessionRecord;
    cancelledMessages: MessageRecord[];
  }> {
    const existing = this.sessions.get(input.sessionId);
    if (!existing) throw new Error(`Session does not exist: ${input.sessionId}`);

    const sessionMessages = this.messages.get(input.sessionId) ?? [];
    const cancelledMessages: MessageRecord[] = [];
    for (const message of sessionMessages) {
      if (message.status !== 'pending') continue;
      const cancelled: MessageRecord = { ...message, status: 'cancelled' };
      sessionMessages[sessionMessages.indexOf(message)] = cancelled;
      cancelledMessages.push(cancelled);
    }

    const session = { ...existing, status: 'archived' as const, updatedAt: input.archivedAt };
    this.sessions.set(input.sessionId, session);
    return { session, cancelledMessages };
  }

  async updateSessionForRun(input: {
    record: SessionRecord;
    runId: string;
    leaseOwner: string;
    now: Date;
  }): Promise<SessionRecord | null> {
    const run = this.runs.get(input.runId);
    if (
      !run ||
      run.sessionId !== input.record.id ||
      (run.status !== 'running' && run.status !== 'cancelling') ||
      run.leaseOwner !== input.leaseOwner ||
      !run.leaseExpiresAt ||
      run.leaseExpiresAt <= input.now
    ) {
      return null;
    }
    return this.updateSession(input.record);
  }

  async pauseSessionQueue(input: { sessionId: string; pausedAt: Date }): Promise<SessionRecord> {
    const existing = this.sessions.get(input.sessionId);
    if (!existing) throw new Error(`Session does not exist: ${input.sessionId}`);
    const updated = { ...existing, queuePausedAt: input.pausedAt, updatedAt: input.pausedAt };
    this.sessions.set(input.sessionId, updated);
    return updated;
  }

  async resumeSessionQueue(input: { sessionId: string }): Promise<SessionRecord> {
    const existing = this.sessions.get(input.sessionId);
    if (!existing) throw new Error(`Session does not exist: ${input.sessionId}`);
    const { queuePausedAt: _queuePausedAt, ...updated } = { ...existing, updatedAt: new Date() };
    this.sessions.set(input.sessionId, updated);
    return updated;
  }

  async createAutomation(record: CreateAutomationRecord): Promise<AutomationRecord> {
    if (this.automations.has(record.id)) throw new Error(`Automation already exists: ${record.id}`);
    this.automations.set(record.id, record);
    return record;
  }

  async getAutomation(id: string): Promise<AutomationRecord | null> {
    return this.automations.get(id) ?? null;
  }

  async listAutomations(): Promise<AutomationRecord[]> {
    return [...this.automations.values()].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }

  async updateAutomation(input: UpdateAutomationRecord): Promise<AutomationRecord> {
    const existing = this.automations.get(input.id);
    if (!existing) throw new Error(`Automation does not exist: ${input.id}`);
    const updated: AutomationRecord = {
      ...existing,
      updatedAt: input.updatedAt,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
      ...(input.scheduleCron !== undefined ? { scheduleCron: input.scheduleCron } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.ownerGroupId !== undefined ? { ownerGroupId: input.ownerGroupId } : {}),
      ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
      ...(input.writePolicy !== undefined ? { writePolicy: input.writePolicy } : {}),
    };
    if (input.context !== undefined) {
      if (input.context) updated.context = input.context;
      else delete updated.context;
    }
    if (input.nextInvocationAt !== undefined && input.nextInvocationAt !== null)
      updated.nextInvocationAt = input.nextInvocationAt;
    else if (input.nextInvocationAt === null) delete updated.nextInvocationAt;
    this.automations.set(input.id, updated);
    return updated;
  }

  async archiveAutomation(input: { automationId: string; archivedAt: Date }): Promise<AutomationRecord | null> {
    const automation = this.automations.get(input.automationId);
    if (!automation) return null;
    const { schedulerLockOwner: _lockOwner, schedulerLockedUntil: _lockedUntil, ...withoutLock } = automation;
    const archived = {
      ...withoutLock,
      enabled: false,
      archivedAt: automation.archivedAt ?? input.archivedAt,
      updatedAt: input.archivedAt,
    };
    this.automations.set(input.automationId, archived);
    return archived;
  }

  async unarchiveAutomation(input: { automationId: string; updatedAt: Date }): Promise<AutomationRecord | null> {
    const automation = this.automations.get(input.automationId);
    if (!automation) return null;
    const {
      archivedAt: _archivedAt,
      schedulerLockOwner: _lockOwner,
      schedulerLockedUntil: _lockedUntil,
      ...withoutArchiveAndLock
    } = automation;
    const unarchived = {
      ...withoutArchiveAndLock,
      enabled: false,
      updatedAt: input.updatedAt,
    };
    this.automations.set(input.automationId, unarchived);
    return unarchived;
  }

  async claimAutomation(input: {
    automationId: string;
    now: Date;
    lockOwner: string;
    lockedUntil: Date;
  }): Promise<AutomationRecord | null> {
    const automation = this.automations.get(input.automationId);
    if (!automation) return null;
    if (automation.archivedAt) return null;
    if (automation.schedulerLockedUntil && automation.schedulerLockedUntil > input.now) return null;
    const locked: AutomationRecord = {
      ...automation,
      schedulerLockOwner: input.lockOwner,
      schedulerLockedUntil: input.lockedUntil,
    };
    this.automations.set(automation.id, locked);
    return locked;
  }

  async releaseAutomationClaim(input: { automationId: string; lockOwner: string }): Promise<AutomationRecord | null> {
    const automation = this.automations.get(input.automationId);
    if (!automation || automation.schedulerLockOwner !== input.lockOwner) return null;
    const { schedulerLockOwner: _lockOwner, schedulerLockedUntil: _lockedUntil, ...withoutLock } = automation;
    const updated = { ...withoutLock };
    this.automations.set(input.automationId, updated);
    return updated;
  }

  async claimNextDueScheduledAutomation(input: {
    now: Date;
    lockOwner: string;
    lockedUntil: Date;
  }): Promise<AutomationRecord | null> {
    const automation = [...this.automations.values()]
      .filter((candidate) => candidate.kind === 'scheduled')
      .filter((candidate) => candidate.enabled)
      .filter((candidate) => !candidate.archivedAt)
      .filter((candidate) => candidate.nextInvocationAt && candidate.nextInvocationAt <= input.now)
      .filter((candidate) => !candidate.schedulerLockedUntil || candidate.schedulerLockedUntil <= input.now)
      .sort(
        (a, b) =>
          (a.nextInvocationAt?.getTime() ?? 0) - (b.nextInvocationAt?.getTime() ?? 0) ||
          a.createdAt.getTime() - b.createdAt.getTime(),
      )[0];
    if (!automation) return null;

    const locked: AutomationRecord = {
      ...automation,
      schedulerLockOwner: input.lockOwner,
      schedulerLockedUntil: input.lockedUntil,
    };
    this.automations.set(automation.id, locked);
    return locked;
  }

  async completeScheduledAutomationClaim(input: {
    automationId: string;
    lockOwner: string;
    claimedScheduleCron: string;
    nextInvocationAt: Date;
  }): Promise<AutomationRecord | null> {
    const automation = this.automations.get(input.automationId);
    if (
      !automation ||
      automation.schedulerLockOwner !== input.lockOwner ||
      automation.scheduleCron !== input.claimedScheduleCron
    ) {
      return null;
    }
    const { schedulerLockOwner: _lockOwner, schedulerLockedUntil: _lockedUntil, ...withoutLock } = automation;
    const updated: AutomationRecord = {
      ...withoutLock,
      nextInvocationAt: input.nextInvocationAt,
    };
    this.automations.set(input.automationId, updated);
    return updated;
  }

  async createAutomationInvocation(record: CreateAutomationInvocationRecord): Promise<AutomationInvocationRecord> {
    if (this.automationInvocations.has(record.id)) {
      throw new Error(`Automation invocation already exists: ${record.id}`);
    }
    const duplicateScheduled = [...this.automationInvocations.values()].some(
      (candidate) =>
        candidate.automationId === record.automationId &&
        candidate.trigger === 'scheduled' &&
        record.trigger === 'scheduled' &&
        candidate.scheduledAt?.getTime() === record.scheduledAt?.getTime(),
    );
    if (duplicateScheduled) throw new Error(`Scheduled automation invocation already exists: ${record.automationId}`);
    this.automationInvocations.set(record.id, record);
    return record;
  }

  async updateAutomationInvocation(record: AutomationInvocationRecord): Promise<AutomationInvocationRecord> {
    if (!this.automationInvocations.has(record.id)) {
      throw new Error(`Automation invocation does not exist: ${record.id}`);
    }
    this.automationInvocations.set(record.id, record);
    return record;
  }

  async getAutomationInvocationBySchedule(input: {
    automationId: string;
    scheduledAt: Date;
  }): Promise<AutomationInvocationRecord | null> {
    return (
      [...this.automationInvocations.values()].find(
        (invocation) =>
          invocation.automationId === input.automationId &&
          invocation.trigger === 'scheduled' &&
          invocation.scheduledAt?.getTime() === input.scheduledAt.getTime(),
      ) ?? null
    );
  }

  async getBlockingAutomationSession(automationId: string): Promise<SessionRecord | null> {
    const invocation = [...this.automationInvocations.values()]
      .filter((candidate) => candidate.automationId === automationId)
      .filter((candidate) => candidate.status === 'created' && candidate.sessionId)
      .sort(compareAutomationInvocationsNewestFirst)
      .find((candidate) => {
        const session = this.sessions.get(candidate.sessionId!);
        return session?.status === 'queued' || session?.status === 'active';
      });
    return invocation?.sessionId ? (this.sessions.get(invocation.sessionId) ?? null) : null;
  }

  async listAutomationInvocations(
    automationId: string,
    options: ListAutomationInvocationsOptions = {},
  ): Promise<AutomationInvocationRecord[]> {
    const invocations = [...this.automationInvocations.values()]
      .filter((invocation) => invocation.automationId === automationId)
      .filter((invocation) => !options.before || isBeforeAutomationInvocationCursor(invocation, options.before))
      .sort(compareAutomationInvocationsNewestFirst);
    return options.limit === undefined ? invocations : invocations.slice(0, options.limit);
  }

  async nextMessageSequence(sessionId: string): Promise<number> {
    return (this.messages.get(sessionId)?.length ?? 0) + 1;
  }

  async createMessage(record: CreateMessageRecord): Promise<MessageRecord> {
    const sessionMessages = this.messages.get(record.sessionId) ?? [];
    sessionMessages.push(record);
    this.messages.set(record.sessionId, sessionMessages);

    if (record.status === 'pending') {
      const session = this.sessions.get(record.sessionId);
      if (!session) throw new Error(`Session does not exist: ${record.sessionId}`);
      this.sessions.set(record.sessionId, {
        ...session,
        status: session.status === 'archived' ? 'archived' : session.status === 'active' ? 'active' : 'queued',
        updatedAt: record.createdAt,
      });
    }

    return record;
  }

  async getMessages(sessionId: string): Promise<MessageRecord[]> {
    return [...(this.messages.get(sessionId) ?? [])];
  }

  async updatePendingMessage(input: {
    sessionId: string;
    messageId: string;
    prompt: string;
  }): Promise<MessageRecord | null> {
    const sessionMessages = this.messages.get(input.sessionId) ?? [];
    const message = sessionMessages.find(
      (candidate) => candidate.id === input.messageId && candidate.status === 'pending',
    );
    if (!message) return null;
    const updated = { ...message, prompt: input.prompt };
    sessionMessages[sessionMessages.indexOf(message)] = updated;
    return updated;
  }

  async cancelPendingMessage(input: {
    sessionId: string;
    messageId: string;
    cancelledAt: Date;
  }): Promise<MessageRecord | null> {
    const sessionMessages = this.messages.get(input.sessionId) ?? [];
    const message = sessionMessages.find(
      (candidate) => candidate.id === input.messageId && candidate.status === 'pending',
    );
    if (!message) return null;
    const updated: MessageRecord = { ...message, status: 'cancelled' };
    sessionMessages[sessionMessages.indexOf(message)] = updated;
    this.refreshQueuedSessionStatus(input.sessionId, input.cancelledAt);
    return updated;
  }

  async claimNextPendingMessage(input: {
    runId: string;
    runnerType: string;
    leaseOwner: string;
    leaseExpiresAt: Date;
    now: Date;
  }): Promise<ClaimedMessage | null> {
    const batch = await this.claimNextPendingMessageBatch(input);
    return batch ? { message: batch.messages[0]!, run: batch.run } : null;
  }

  async claimNextPendingMessageBatch(input: {
    runId: string;
    runnerType: string;
    leaseOwner: string;
    leaseExpiresAt: Date;
    now: Date;
  }): Promise<ClaimedMessageBatch | null> {
    for (const [sessionId, sessionMessages] of this.messages) {
      const currentSession = this.sessions.get(sessionId);
      if (currentSession?.queuePausedAt || currentSession?.status === 'archived') continue;
      if (this.hasActiveRun(sessionId, input.now)) continue;

      const pendingMessages = sessionMessages
        .filter((candidate) => candidate.status === 'pending')
        .sort((a, b) => a.sequence - b.sequence);
      if (!pendingMessages.length) continue;

      const processingMessages = pendingMessages.map((message) => ({ ...message, status: 'processing' as const }));
      for (const message of processingMessages) {
        const existing = sessionMessages.find((candidate) => candidate.id === message.id)!;
        sessionMessages[sessionMessages.indexOf(existing)] = message;
      }

      const session = this.sessions.get(sessionId);
      if (!session) throw new Error(`Session does not exist: ${sessionId}`);
      this.sessions.set(sessionId, { ...session, status: 'active', updatedAt: input.now });

      const run: RunRecord = {
        id: input.runId,
        sessionId,
        messageId: processingMessages[0]!.id,
        status: 'running',
        runnerType: input.runnerType,
        leaseOwner: input.leaseOwner,
        leaseExpiresAt: input.leaseExpiresAt,
        heartbeatAt: input.now,
        attempt: 1,
        startedAt: input.now,
        metadata: {
          messageIds: processingMessages.map((message) => message.id),
          sequences: processingMessages.map((message) => message.sequence),
        },
      };
      this.runs.set(run.id, run);
      return { messages: processingMessages, run };
    }

    return null;
  }

  async completeRun(input: { runId: string; leaseOwner: string; completedAt: Date }): Promise<ClaimedMessage | null> {
    const batch = await this.completeRunBatch(input);
    return batch ? { message: batch.messages[0]!, run: batch.run } : null;
  }

  async completeRunBatch(input: {
    runId: string;
    leaseOwner: string;
    completedAt: Date;
  }): Promise<ClaimedMessageBatch | null> {
    return this.finishRun(input.runId, input.leaseOwner, input.completedAt, 'completed');
  }

  async renewRunLease(input: {
    runId: string;
    leaseOwner: string;
    leaseExpiresAt: Date;
    heartbeatAt: Date;
  }): Promise<RunRecord | null> {
    const run = this.runs.get(input.runId);
    if (
      !run ||
      (run.status !== 'running' && run.status !== 'cancelling') ||
      run.leaseOwner !== input.leaseOwner ||
      !run.leaseExpiresAt ||
      run.leaseExpiresAt <= input.heartbeatAt
    ) {
      return null;
    }

    const renewed: RunRecord = {
      ...run,
      leaseExpiresAt: input.leaseExpiresAt,
      heartbeatAt: input.heartbeatAt,
    };
    this.runs.set(input.runId, renewed);
    return renewed;
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    return this.runs.get(runId) ?? null;
  }

  async recoverStaleRuns(input: { now: Date; limit: number }): Promise<RecoveredRun[]> {
    const recovered: RecoveredRun[] = [];
    let selected = 0;

    for (const run of this.runs.values()) {
      if (selected >= input.limit) break;
      if (run.status !== 'running' && run.status !== 'starting' && run.status !== 'cancelling') continue;
      if (!run.leaseExpiresAt || run.leaseExpiresAt > input.now) continue;
      selected += 1;

      const sessionMessages = this.messages.get(run.sessionId) ?? [];
      const pendingMessages: MessageRecord[] = [];
      for (const messageId of getRunMessageIds(run)) {
        const message = sessionMessages.find(
          (candidate) =>
            candidate.id === messageId && (candidate.status === 'processing' || candidate.status === 'cancelling'),
        );
        if (!message) continue;
        const pendingMessage: MessageRecord = { ...message, status: 'pending' };
        sessionMessages[sessionMessages.indexOf(message)] = pendingMessage;
        pendingMessages.push(pendingMessage);
      }

      const { leaseExpiresAt: _leaseExpiresAt, leaseOwner: _leaseOwner, ...runWithoutLease } = run;
      const staleRun: RunRecord = {
        ...runWithoutLease,
        status: 'stale',
        failedAt: input.now,
        heartbeatAt: input.now,
        error: 'Run lease expired',
      };
      this.runs.set(run.id, staleRun);

      const session = this.sessions.get(run.sessionId);
      if (session) {
        this.sessions.set(run.sessionId, {
          ...session,
          status:
            session.status === 'archived'
              ? 'archived'
              : sessionMessages.some((message) => message.status === 'pending')
                ? 'queued'
                : 'idle',
          updatedAt: input.now,
        });
      }

      if (!pendingMessages.length) continue;

      recovered.push({ message: pendingMessages[0]!, messages: pendingMessages, run: staleRun });
    }

    return recovered;
  }

  async failRun(input: {
    runId: string;
    leaseOwner: string;
    failedAt: Date;
    error: string;
  }): Promise<ClaimedMessage | null> {
    const batch = await this.failRunBatch(input);
    return batch ? { message: batch.messages[0]!, run: batch.run } : null;
  }

  async failRunBatch(input: {
    runId: string;
    leaseOwner: string;
    failedAt: Date;
    error: string;
  }): Promise<ClaimedMessageBatch | null> {
    const claimed = await this.finishRun(input.runId, input.leaseOwner, input.failedAt, 'failed');
    if (!claimed) return null;
    this.runs.set(input.runId, { ...claimed.run, error: input.error });
    return { ...claimed, run: this.runs.get(input.runId)! };
  }

  async requestRunCancellation(input: {
    sessionId: string;
    requestedAt: Date;
    error: string;
  }): Promise<ClaimedMessageBatch | null> {
    const run = [...this.runs.values()].find(
      (candidate) =>
        candidate.sessionId === input.sessionId &&
        (candidate.status === 'running' || candidate.status === 'starting' || candidate.status === 'cancelling'),
    );
    if (!run) return null;

    const sessionMessages = this.messages.get(run.sessionId) ?? [];
    const messages = getRunMessageIds(run).map((messageId) => {
      const message = sessionMessages.find((candidate) => candidate.id === messageId);
      if (!message) throw new Error(`Message does not exist: ${messageId}`);
      const cancellingMessage: MessageRecord = {
        ...message,
        status: message.status === 'cancelled' ? 'cancelled' : 'cancelling',
      };
      sessionMessages[sessionMessages.indexOf(message)] = cancellingMessage;
      return cancellingMessage;
    });
    const cancellingRun: RunRecord = {
      ...run,
      status: 'cancelling',
      heartbeatAt: input.requestedAt,
      error: input.error,
    };
    this.runs.set(run.id, cancellingRun);
    return { messages, run: cancellingRun };
  }

  async finalizeRunCancellation(input: {
    runId: string;
    leaseOwner: string;
    cancelledAt: Date;
    error: string;
  }): Promise<ClaimedMessageBatch | null> {
    const claimed = this.finishRun(input.runId, input.leaseOwner, input.cancelledAt, 'cancelled');
    if (!claimed) return null;
    const cancelledRun: RunRecord = { ...claimed.run, error: input.error };
    this.runs.set(input.runId, cancelledRun);
    return { ...claimed, run: cancelledRun };
  }

  async getActiveSandbox(sessionId: string, provider: string): Promise<SandboxRecord | null> {
    return (await this.listActiveSandboxes(sessionId, provider))[0] ?? null;
  }

  async getLatestSandbox(sessionId: string, provider: string): Promise<SandboxRecord | null> {
    return (
      Array.from(this.sandboxes.values())
        .filter((sandbox) => sandbox.sessionId === sessionId && sandbox.provider === provider)
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0] ?? null
    );
  }

  async listActiveSandboxes(sessionId: string, provider: string): Promise<SandboxRecord[]> {
    return Array.from(this.sandboxes.values())
      .filter((sandbox) => sandbox.sessionId === sessionId && sandbox.provider === provider)
      .filter(isActiveSandbox)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }

  async listIdleSandboxes(input: { provider: string; idleBefore: Date; limit: number }): Promise<SandboxRecord[]> {
    return Array.from(this.sandboxes.values())
      .filter((sandbox) => sandbox.provider === input.provider)
      .filter(isActiveSandbox)
      .filter((sandbox) => sandbox.updatedAt <= input.idleBefore)
      .filter((sandbox) => !sandbox.keepaliveUntil || sandbox.keepaliveUntil <= new Date())
      .filter((sandbox) => !isSessionBusy(this.sessions.get(sandbox.sessionId)?.status))
      .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
      .slice(0, input.limit);
  }

  async listStoppableSandboxes(input: { provider: string; idleBefore: Date; limit: number }): Promise<SandboxRecord[]> {
    return Array.from(this.sandboxes.values())
      .filter((sandbox) => sandbox.provider === input.provider)
      .filter((sandbox) => !sandbox.destroyedAt && sandbox.status === 'ready')
      .filter((sandbox) => sandbox.updatedAt <= input.idleBefore)
      .filter((sandbox) => !sandbox.keepaliveUntil || sandbox.keepaliveUntil <= new Date())
      .filter((sandbox) => !isSessionBusy(this.sessions.get(sandbox.sessionId)?.status))
      .filter(
        (sandbox) => !(this.messages.get(sandbox.sessionId) ?? []).some((message) => message.status === 'pending'),
      )
      .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
      .slice(0, input.limit);
  }

  async createSandbox(record: CreateSandboxRecord): Promise<SandboxRecord> {
    if (this.sandboxes.has(record.id)) throw new Error(`Sandbox already exists: ${record.id}`);
    this.sandboxes.set(record.id, record);
    return record;
  }

  async createSandboxWithSecrets(record: CreateSandboxRecord, secrets: SandboxSecrets): Promise<SandboxRecord> {
    const created = await this.createSandbox(record);
    try {
      await this.setSandboxSecrets(created.id, secrets);
      return created;
    } catch (error) {
      this.sandboxes.delete(created.id);
      this.sandboxSecrets.delete(created.id);
      throw error;
    }
  }

  async updateSandbox(record: SandboxRecord): Promise<SandboxRecord> {
    if (!this.sandboxes.has(record.id)) throw new Error(`Sandbox does not exist: ${record.id}`);
    this.sandboxes.set(record.id, record);
    return record;
  }

  async getSandboxSecrets(sandboxId: string): Promise<SandboxSecrets> {
    return { ...(this.sandboxSecrets.get(sandboxId) ?? {}) };
  }

  async setSandboxSecrets(sandboxId: string, secrets: SandboxSecrets): Promise<void> {
    if (!this.sandboxes.has(sandboxId)) throw new Error(`Sandbox does not exist: ${sandboxId}`);
    this.sandboxSecrets.set(sandboxId, { ...secrets });
  }

  async createArtifact(record: CreateArtifactRecord): Promise<ArtifactRecord> {
    if (this.artifacts.has(record.id)) throw new Error(`Artifact already exists: ${record.id}`);
    this.artifacts.set(record.id, record);
    return record;
  }

  async getArtifacts(sessionId: string): Promise<ArtifactRecord[]> {
    return Array.from(this.artifacts.values()).filter((artifact) => artifact.sessionId === sessionId);
  }

  async createExternalResource(record: CreateExternalResourceRecord): Promise<ExternalResourceRecord> {
    if (this.externalResources.has(record.id)) throw new Error(`External resource already exists: ${record.id}`);
    this.externalResources.set(record.id, record);
    return record;
  }

  async getExternalResources(sessionId: string): Promise<ExternalResourceRecord[]> {
    return Array.from(this.externalResources.values()).filter((resource) => resource.sessionId === sessionId);
  }

  async createCallbackDelivery(record: CreateCallbackDeliveryRecord): Promise<CallbackDeliveryRecord> {
    const delivery: CallbackDeliveryRecord = {
      ...record,
      status: 'pending',
      attempts: 0,
      maxAttempts: record.maxAttempts ?? 5,
    };
    this.callbacks.set(delivery.id, delivery);
    return delivery;
  }

  async listCallbackDeliveries(input: { sessionId: string; messageId?: string }): Promise<CallbackDeliveryRecord[]> {
    return Array.from(this.callbacks.values())
      .filter((delivery) => delivery.sessionId === input.sessionId)
      .filter((delivery) => !input.messageId || delivery.messageId === input.messageId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async claimDueCallbackDeliveries(input: { now: Date; limit: number }): Promise<CallbackDeliveryRecord[]> {
    const staleSendingBefore = new Date(input.now.getTime() - staleCallbackSendingMs);
    const due = Array.from(this.callbacks.values())
      .filter((delivery) => delivery.status === 'pending' || isStaleSendingCallback(delivery, staleSendingBefore))
      .filter((delivery) => !delivery.nextAttemptAt || delivery.nextAttemptAt <= input.now)
      .filter((delivery) => delivery.attempts < delivery.maxAttempts)
      .sort(
        (a, b) =>
          (a.nextAttemptAt?.getTime() ?? a.createdAt.getTime()) - (b.nextAttemptAt?.getTime() ?? b.createdAt.getTime()),
      )
      .slice(0, input.limit);
    const claimed = due.map((delivery) => {
      const updated: CallbackDeliveryRecord = {
        ...delivery,
        status: 'sending',
        attempts: delivery.attempts + 1,
        lastAttemptAt: input.now,
        updatedAt: input.now,
      };
      this.callbacks.set(delivery.id, updated);
      return updated;
    });
    return claimed;
  }

  async markCallbackDeliverySent(input: { id: string; deliveredAt: Date }): Promise<CallbackDeliveryRecord> {
    const existing = this.requireCallback(input.id);
    const { nextAttemptAt: _nextAttemptAt, lastError: _lastError, ...withoutRetryState } = existing;
    const updated: CallbackDeliveryRecord = {
      ...withoutRetryState,
      status: 'sent',
      deliveredAt: input.deliveredAt,
      updatedAt: input.deliveredAt,
    };
    this.callbacks.set(input.id, updated);
    return updated;
  }

  async markCallbackDeliveryFailed(input: {
    id: string;
    failedAt: Date;
    error: string;
    terminal: boolean;
    nextAttemptAt?: Date;
  }): Promise<CallbackDeliveryRecord> {
    const existing = this.requireCallback(input.id);
    const { nextAttemptAt: _nextAttemptAt, ...withoutNextAttempt } = existing;
    const updated: CallbackDeliveryRecord = {
      ...withoutNextAttempt,
      status: input.terminal ? 'failed' : 'pending',
      lastError: input.error,
      updatedAt: input.failedAt,
    };
    if (input.nextAttemptAt) updated.nextAttemptAt = input.nextAttemptAt;
    this.callbacks.set(input.id, updated);
    return updated;
  }

  async requestCallbackReplay(input: {
    sessionId: string;
    deliveryId: string;
    requestedAt: Date;
  }): Promise<CallbackDeliveryRecord | null> {
    const existing = this.callbacks.get(input.deliveryId);
    if (!existing || existing.sessionId !== input.sessionId || existing.status !== 'failed') return null;
    const { deliveredAt: _deliveredAt, nextAttemptAt: _nextAttemptAt, ...withoutTerminalFields } = existing;
    const updated: CallbackDeliveryRecord = {
      ...withoutTerminalFields,
      status: 'pending',
      maxAttempts: Math.max(existing.maxAttempts, existing.attempts + 1),
      updatedAt: input.requestedAt,
      nextAttemptAt: input.requestedAt,
    };
    this.callbacks.set(input.deliveryId, updated);
    return updated;
  }

  async nextEventSequence(sessionId: string): Promise<number> {
    const maxSequence = Math.max(0, ...(this.events.get(sessionId) ?? []).map((event) => event.sequence));
    return maxSequence + 1;
  }

  async appendEvent(event: NormalizedEvent & { sequence: number }): Promise<EventRecord> {
    const record = { ...event, id: this.nextEventId++ };
    const sessionEvents = this.events.get(event.sessionId) ?? [];
    sessionEvents.push(record);
    this.events.set(event.sessionId, sessionEvents);
    return record;
  }

  async appendEventWithNextSequence(event: NormalizedEvent): Promise<EventRecord> {
    return this.appendEvent({ ...event, sequence: await this.nextEventSequence(event.sessionId) });
  }

  async appendEventWithNextSequenceForRun(
    event: Omit<NormalizedEvent, 'runId'> & { runId: string },
    guard: { runId: string; leaseOwner: string; now: Date },
  ): Promise<EventRecord | null> {
    const run = this.runs.get(guard.runId);
    if (
      !run ||
      event.runId !== guard.runId ||
      (run.status !== 'running' && run.status !== 'cancelling') ||
      run.leaseOwner !== guard.leaseOwner ||
      !run.leaseExpiresAt ||
      run.leaseExpiresAt <= guard.now
    ) {
      return null;
    }
    return this.appendEventWithNextSequence(event as NormalizedEvent);
  }

  async getEvents(sessionId: string, afterSequence = 0, limit?: number): Promise<EventRecord[]> {
    const events = (this.events.get(sessionId) ?? []).filter((event) => event.sequence > afterSequence);
    return limit === undefined ? events : events.slice(0, limit);
  }

  async listEvents(afterId = 0, limit?: number): Promise<EventRecord[]> {
    const events = [...this.events.values()]
      .flat()
      .filter((event) => event.id > afterId)
      .sort((left, right) => left.id - right.id);
    return limit === undefined ? events : events.slice(0, limit);
  }

  async compactFinalizedAgentTextDeltas(input: EventDeltaCompactionInput): Promise<number> {
    let remaining = input.limit;
    let compacted = 0;
    const finalizedBeforeMs = input.finalizedBefore.getTime();

    for (const [sessionId, events] of this.events) {
      if (remaining <= 0) break;

      const finalizedMessageSequences = new Map<string, number>();
      for (const event of events) {
        if (
          event.type !== 'agent_response_final' ||
          !event.messageId ||
          event.createdAt.getTime() >= finalizedBeforeMs ||
          typeof event.payload.text !== 'string'
        ) {
          continue;
        }
        finalizedMessageSequences.set(
          event.messageId,
          Math.max(finalizedMessageSequences.get(event.messageId) ?? 0, event.sequence),
        );
      }
      if (!finalizedMessageSequences.size) continue;

      const kept: EventRecord[] = [];
      for (const event of events) {
        const finalSequence = event.messageId ? finalizedMessageSequences.get(event.messageId) : undefined;
        if (
          remaining > 0 &&
          event.type === 'agent_text_delta' &&
          event.createdAt.getTime() < finalizedBeforeMs &&
          finalSequence !== undefined &&
          event.sequence < finalSequence
        ) {
          remaining -= 1;
          compacted += 1;
          continue;
        }
        kept.push(event);
      }
      this.events.set(sessionId, kept);
    }

    return compacted;
  }

  async createWebhookSource(record: CreateWebhookSourceRecord): Promise<WebhookSourceRecord> {
    this.webhookSources.set(record.key, record);
    return record;
  }

  async getWebhookSource(key: string): Promise<WebhookSourceRecord | null> {
    return this.webhookSources.get(key) ?? null;
  }

  async getExternalThread(source: string, externalId: string): Promise<ExternalThreadRecord | null> {
    return this.externalThreads.get(externalThreadKey(source, externalId)) ?? null;
  }

  async createExternalThread(input: {
    id: string;
    source: string;
    externalId: string;
    sessionId: string;
    metadata: Record<string, unknown>;
    now: Date;
  }): Promise<ExternalThreadRecord> {
    const key = externalThreadKey(input.source, input.externalId);
    const existing = this.externalThreads.get(key);
    if (existing) return existing;

    const record: ExternalThreadRecord = {
      id: input.id,
      source: input.source,
      externalId: input.externalId,
      sessionId: input.sessionId,
      metadata: input.metadata,
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.externalThreads.set(key, record);
    return record;
  }

  async createIntegrationDelivery(input: {
    id: string;
    source: string;
    dedupeKey: string;
    receivedAt: Date;
    staleReceivedBefore: Date;
    metadata: Record<string, unknown>;
  }): Promise<IntegrationDeliveryRecord | null> {
    const key = deliveryKey(input.source, input.dedupeKey);
    const existing = this.integrationDeliveries.get(key);
    if (existing?.status === 'processed') return null;
    if (existing?.status === 'received') return null;

    const record: IntegrationDeliveryRecord = {
      id: input.id,
      source: input.source,
      dedupeKey: input.dedupeKey,
      status: 'received',
      receivedAt: input.receivedAt,
      metadata: input.metadata,
    };
    this.integrationDeliveries.set(key, record);
    return record;
  }

  async markIntegrationDeliveryProcessed(input: {
    id: string;
    source: string;
    dedupeKey: string;
    processedAt: Date;
  }): Promise<boolean> {
    const key = deliveryKey(input.source, input.dedupeKey);
    const existing = this.integrationDeliveries.get(key);
    if (!existing || existing.id !== input.id || existing.status !== 'received') return false;
    this.integrationDeliveries.set(key, { ...existing, status: 'processed', processedAt: input.processedAt });
    return true;
  }

  async markIntegrationDeliveryFailed(input: {
    id: string;
    source: string;
    dedupeKey: string;
    failedAt: Date;
    error: string;
  }): Promise<boolean> {
    const key = deliveryKey(input.source, input.dedupeKey);
    const existing = this.integrationDeliveries.get(key);
    if (!existing || existing.id !== input.id || existing.status !== 'received') return false;
    this.integrationDeliveries.set(key, {
      ...existing,
      status: 'failed',
      processedAt: input.failedAt,
      error: input.error,
    });
    return true;
  }

  private hasActiveRun(sessionId: string, now: Date): boolean {
    for (const run of this.runs.values()) {
      if (run.sessionId !== sessionId) continue;
      if (run.status !== 'running' && run.status !== 'starting' && run.status !== 'cancelling') continue;
      if (run.leaseExpiresAt && run.leaseExpiresAt <= now) continue;
      return true;
    }
    return false;
  }

  private finishRun(
    runId: string,
    leaseOwner: string,
    finishedAt: Date,
    status: 'completed' | 'failed' | 'cancelled',
  ): ClaimedMessageBatch | null {
    const run = this.runs.get(runId);
    if (!run) return null;
    if ((run.status !== 'running' && run.status !== 'cancelling') || run.leaseOwner !== leaseOwner) return null;
    if (!run.leaseExpiresAt || run.leaseExpiresAt <= finishedAt) return null;

    const sessionMessages = this.messages.get(run.sessionId) ?? [];
    const messageIds = getRunMessageIds(run);
    const terminalMessages: MessageRecord[] = [];

    for (const messageId of messageIds) {
      const message = sessionMessages.find((candidate) => candidate.id === messageId);
      if (!message) throw new Error(`Message does not exist: ${messageId}`);
      const terminalMessage: MessageRecord = { ...message, status };
      sessionMessages[sessionMessages.indexOf(message)] = terminalMessage;
      terminalMessages.push(terminalMessage);
    }

    const { leaseExpiresAt: _leaseExpiresAt, leaseOwner: _leaseOwner, ...runWithoutLease } = run;
    const terminalRun: RunRecord = { ...runWithoutLease, status, heartbeatAt: finishedAt };
    if (status === 'completed') terminalRun.completedAt = finishedAt;
    if (status === 'failed' || status === 'cancelled') terminalRun.failedAt = finishedAt;
    this.runs.set(runId, terminalRun);

    const session = this.sessions.get(run.sessionId);
    if (!session) throw new Error(`Session does not exist: ${run.sessionId}`);
    const hasPendingMessages = sessionMessages.some((message) => message.status === 'pending');
    this.sessions.set(run.sessionId, {
      ...session,
      status:
        session.status === 'archived'
          ? 'archived'
          : status === 'failed'
            ? 'failed'
            : hasPendingMessages
              ? 'queued'
              : 'idle',
      updatedAt: finishedAt,
    });

    return { messages: terminalMessages, run: terminalRun };
  }

  private refreshQueuedSessionStatus(sessionId: string, updatedAt: Date): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.status === 'archived' || session.status === 'active') return;
    const hasPendingMessages = (this.messages.get(sessionId) ?? []).some((message) => message.status === 'pending');
    this.sessions.set(sessionId, { ...session, status: hasPendingMessages ? 'queued' : 'idle', updatedAt });
  }

  private requireCallback(id: string): CallbackDeliveryRecord {
    const existing = this.callbacks.get(id);
    if (!existing) throw new Error(`Callback delivery does not exist: ${id}`);
    return existing;
  }
}

function authAccountKey(provider: string, providerAccountId: string): string {
  return `${provider}:${providerAccountId}`;
}

function groupMemberKey(groupId: string, userId: string): string {
  return `${groupId}:${userId}`;
}

function normalizedGroupName(name: string): string {
  return name.trim().toLowerCase();
}

function isStaleSendingCallback(delivery: CallbackDeliveryRecord, staleSendingBefore: Date): boolean {
  const lastAttemptAt = delivery.lastAttemptAt;
  return delivery.status === 'sending' && lastAttemptAt !== undefined && lastAttemptAt <= staleSendingBefore;
}

function isActiveSandbox(sandbox: SandboxRecord): boolean {
  return (
    !sandbox.destroyedAt &&
    (sandbox.status === 'ready' || sandbox.status === 'stopped' || sandbox.status === 'unhealthy')
  );
}

function compareAutomationInvocationsNewestFirst(a: AutomationInvocationRecord, b: AutomationInvocationRecord): number {
  const time = b.createdAt.getTime() - a.createdAt.getTime();
  if (time !== 0) return time;
  return b.id.localeCompare(a.id);
}

function isBeforeAutomationInvocationCursor(
  invocation: AutomationInvocationRecord,
  cursor: { createdAt: Date; id: string },
): boolean {
  const time = invocation.createdAt.getTime() - cursor.createdAt.getTime();
  if (time !== 0) return time < 0;
  return invocation.id < cursor.id;
}

function isSessionBusy(status: string | undefined): boolean {
  return status === 'active' || status === 'queued';
}

function getRunMessageIds(run: RunRecord): string[] {
  const messageIds = run.metadata.messageIds;
  if (Array.isArray(messageIds) && messageIds.every((id) => typeof id === 'string')) return messageIds;
  return [run.messageId];
}

function externalThreadKey(source: string, externalId: string): string {
  return `${source}:${externalId}`;
}

function deliveryKey(source: string, dedupeKey: string): string {
  return `${source}:${dedupeKey}`;
}
