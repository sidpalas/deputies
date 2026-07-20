import type { NormalizedEvent } from '../events/types.js';
import { MemorySkillStore } from './memory-skills.js';
import { defaultGroupId, StoreConflictError } from './types.js';
import type {
  AppStore,
  AgentSessionListOptions,
  ArtifactRecord,
  AutomationInvocationRecord,
  AutomationRecord,
  AuthAccountRecord,
  AuthSessionRecord,
  AuthUserRecord,
  CallbackDeliveryRecord,
  ChildSessionListOptions,
  CreateAutomationInvocationRecord,
  CreateAutomationRecord,
  CreateArtifactRecord,
  CreateCallbackDeliveryRecord,
  CreateEnvironmentRecord,
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
  EnvironmentWithDetailsRecord,
  EnvironmentActivityRecord,
  EnvironmentRevisionRecord,
  CreateMessageRecord,
  CreateSessionRecord,
  CreateSessionWithFirstMessageInput,
  CreateSessionWithFirstMessageResult,
  CreateSkillRecord,
  CreateSnippetRecord,
  ClaimedMessage,
  ClaimedMessageBatch,
  ListAutomationInvocationsOptions,
  MessageRecord,
  RecoveredRun,
  RunRecord,
  SandboxRecord,
  SandboxSecrets,
  SessionContextUpdateInput,
  SessionListOptions,
  SessionMetadataUpdateInput,
  SessionRecord,
  SessionSearchDocInput,
  SessionSearchMatchKind,
  SessionSearchOptions,
  SessionSearchPage,
  SessionTagSummary,
  SessionTitleUpdateInput,
  SessionWithSandboxPage,
  SessionVisibilityFilter,
  SessionMessageSummary,
  SessionTranscriptOptions,
  SessionTranscriptPage,
  SkillRecord,
  SkillRevisionRecord,
  SkillRevisionSelection,
  SkillRunCandidate,
  SkillShareMode,
  SnippetRecord,
  UpdateAutomationRecord,
  UpdateEnvironmentRecord,
  UpdateSkillRecord,
  UpdateSnippetRecord,
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
  private readonly skillStore = new MemorySkillStore({
    userExists: (userId) => this.authUsers.has(userId),
    getGroupState: (groupId) => {
      const group = this.groups.get(groupId);
      return group ? { archived: Boolean(group.archivedAt) } : null;
    },
  });
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
  private readonly environments = new Map<string, EnvironmentWithDetailsRecord>();
  private readonly environmentRevisions = new Map<string, EnvironmentRevisionRecord>();
  private readonly environmentActivity = new Map<string, EnvironmentActivityRecord[]>();
  private readonly webhookSources = new Map<string, WebhookSourceRecord>();
  private readonly externalThreads = new Map<string, ExternalThreadRecord>();
  private readonly integrationDeliveries = new Map<string, IntegrationDeliveryRecord>();
  private readonly sessionSearchDocs = new Map<string, SessionSearchDocInput>();
  private readonly sessionStars = new Map<string, Set<string>>();
  private readonly snippets = new Map<string, SnippetRecord>();
  private searchIndexCursor = 0;

  async createSnippet(record: CreateSnippetRecord): Promise<SnippetRecord> {
    if (!this.authUsers.has(record.ownerUserId)) throw new Error(`User does not exist: ${record.ownerUserId}`);
    this.assertSnippetName(record.ownerUserId, record.name);
    this.snippets.set(record.id, { ...record });
    return { ...record };
  }

  async getSnippetForUser(id: string, ownerUserId: string): Promise<SnippetRecord | null> {
    const value = this.snippets.get(id);
    return value?.ownerUserId === ownerUserId ? { ...value } : null;
  }

  async listSnippetsForUser(ownerUserId: string): Promise<SnippetRecord[]> {
    return [...this.snippets.values()]
      .filter((item) => item.ownerUserId === ownerUserId)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((item) => ({ ...item }));
  }

  async updateSnippet(record: UpdateSnippetRecord): Promise<SnippetRecord | null> {
    const existing = this.snippets.get(record.id);
    if (!existing || existing.ownerUserId !== record.ownerUserId || existing.archivedAt) return null;
    if (record.name !== undefined) this.assertSnippetName(record.ownerUserId, record.name, record.id);
    const updated = { ...existing, ...record };
    this.snippets.set(record.id, updated);
    return { ...updated };
  }

  async archiveSnippet(id: string, ownerUserId: string, archivedAt: Date): Promise<SnippetRecord | null> {
    const existing = this.snippets.get(id);
    if (!existing || existing.ownerUserId !== ownerUserId) return null;
    if (existing.archivedAt) return { ...existing };
    const updated = { ...existing, archivedAt: existing.archivedAt ?? archivedAt, updatedAt: archivedAt };
    this.snippets.set(id, updated);
    return { ...updated };
  }

  async restoreSnippet(id: string, ownerUserId: string, updatedAt: Date): Promise<SnippetRecord | null> {
    const existing = this.snippets.get(id);
    if (!existing || existing.ownerUserId !== ownerUserId) return null;
    if (!existing.archivedAt) return { ...existing };
    this.assertSnippetName(ownerUserId, existing.name, id);
    const { archivedAt: _, ...active } = existing;
    const updated = { ...active, updatedAt };
    this.snippets.set(id, updated);
    return { ...updated };
  }

  private assertSnippetName(ownerUserId: string, name: string, exceptId?: string): void {
    if (
      [...this.snippets.values()].some(
        (item) => item.ownerUserId === ownerUserId && item.name === name && !item.archivedAt && item.id !== exceptId,
      )
    )
      throw new StoreConflictError('snippet_name_exists', 'An active snippet with this name already exists');
  }

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

  async getAuthUser(id: string): Promise<AuthUserRecord | null> {
    return this.authUsers.get(id) ?? null;
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

    const session = withSessionDefaults(record);
    this.sessions.set(record.id, session);
    return session;
  }

  async createSessionWithFirstMessage(
    input: CreateSessionWithFirstMessageInput,
  ): Promise<CreateSessionWithFirstMessageResult> {
    validateParentChildLimit(input, (parentSessionId) => this.sessions.has(parentSessionId));
    const existing = this.sessions.get(input.session.id);
    if (existing) {
      const message = this.messages.get(input.session.id)?.[0];
      if (!message) throw new Error(`First message does not exist for session: ${input.session.id}`);
      return { session: existing, message, events: [], created: false };
    }

    if (input.parentChildLimit) {
      const childCount = [...this.sessions.values()].filter(
        (session) =>
          session.parentSessionId === input.parentChildLimit!.parentSessionId && session.status !== 'archived',
      ).length;
      if (childCount >= input.parentChildLimit.maxNonArchivedChildren) {
        throw new Error(
          `Cannot spawn more than ${input.parentChildLimit.maxNonArchivedChildren} non-archived child sessions`,
        );
      }
    }

    const session = withSessionDefaults(input.session);
    const message: MessageRecord = {
      ...input.message,
      sessionId: session.id,
      sequence: 1,
      status: 'pending',
    };
    this.sessions.set(session.id, session);
    this.messages.set(session.id, [message]);

    const events = [
      await this.appendEvent({ ...input.sessionCreatedEvent, sessionId: session.id, sequence: 1 }),
      await this.appendEvent({
        ...input.messageCreatedEvent,
        sessionId: session.id,
        messageId: message.id,
        sequence: 2,
      }),
    ];
    if (input.parentSpawnedEvent) events.push(await this.appendEventWithNextSequence(input.parentSpawnedEvent));
    return { session, message, events, created: true };
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    return this.sessions.get(id) ?? null;
  }

  async listSessions(): Promise<SessionRecord[]> {
    return [...this.sessions.values()].sort(compareSessionsNewestFirst);
  }

  async listSessionsForAgent(input: AgentSessionListOptions): Promise<SessionRecord[]> {
    return (await this.listSessions())
      .filter((session) => sessionMatchesAgentScope(session, input))
      .filter((session) => !input.status || session.status === input.status)
      .slice(0, input.limit);
  }

  async listChildSessions(input: ChildSessionListOptions): Promise<SessionRecord[]> {
    return (await this.listSessions())
      .filter((session) => session.parentSessionId === input.parentSessionId)
      .filter((session) => sessionIsReadableToAgentGroup(session, input.ownerGroupId))
      .slice(0, input.limit);
  }

  async listSessionsWithLatestSandbox(provider: string, options: SessionListOptions): Promise<SessionWithSandboxPage> {
    const matchingSessions = [...this.sessions.values()]
      .filter((session) => canListSession(session, options.visibleTo))
      .filter((session) => (options.archived ? session.status === 'archived' : session.status !== 'archived'))
      .filter((session) => !options.groupId || session.ownerGroupId === options.groupId)
      .filter((session) => sessionMatchesListFilters(session, options, this.messages, this.sessionStars));
    const sessions = matchingSessions
      .filter((session) => !options.parentSessionId || session.parentSessionId === options.parentSessionId)
      .filter((session) => !options.cursor || isBeforeSessionCursor(session, options.cursor))
      .sort(compareSessionsNewestFirst);
    const page = sessions.slice(0, options.limit);
    const last = page.at(-1);
    return {
      items: await Promise.all(
        page.map(async (session) => ({
          session,
          sandbox: await this.getLatestSandboxForSession(session.id, provider),
          directChildCount: matchingSessions.filter((child) => child.parentSessionId === session.id).length,
        })),
      ),
      nextCursor:
        sessions.length > options.limit && last
          ? { lastActivityAt: last.lastActivityAt, createdAt: last.createdAt, id: last.id }
          : null,
    };
  }

  async searchSessions(provider: string, options: SessionSearchOptions): Promise<SessionSearchPage> {
    const query = options.query.trim().toLowerCase();
    if (!query) return { items: [], nextCursor: null };
    const terms = query.split(/\s+/).filter(Boolean);
    const matches = [...this.sessions.values()]
      .filter((session) => canListSession(session, options.visibleTo))
      .filter((session) => !options.groupId || session.ownerGroupId === options.groupId)
      .filter((session) => sessionMatchesListFilters(session, options, this.messages, this.sessionStars))
      .map((session) => ({
        session,
        match: bestMemorySearchMatch(session, terms, this.memorySearchDocuments(session)),
      }))
      .filter((item): item is { session: SessionRecord; match: MemorySearchMatch } => item.match !== null)
      .sort((a, b) => b.match.score - a.match.score || compareSessionsNewestFirst(a.session, b.session));
    const offset = options.cursor ?? 0;
    const page = matches.slice(offset, offset + options.limit);
    return {
      items: await Promise.all(
        page.map(async ({ session, match }) => ({
          item: { session, sandbox: await this.getLatestSandboxForSession(session.id, provider) },
          snippet: match.snippet,
          matchKind: match.kind,
          score: match.score,
        })),
      ),
      nextCursor: matches.length > offset + options.limit ? offset + options.limit : null,
    };
  }

  async listSessionTags(options: { visibleTo?: SessionVisibilityFilter; limit: number }): Promise<SessionTagSummary[]> {
    const counts = new Map<string, number>();
    for (const session of this.sessions.values()) {
      if (!canListSession(session, options.visibleTo)) continue;
      for (const tag of session.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([tag, sessionCount]) => ({ tag, sessionCount }))
      .sort((left, right) => right.sessionCount - left.sessionCount || compareStringAsc(left.tag, right.tag))
      .slice(0, options.limit);
  }

  async starSession(input: { sessionId: string; userId: string; now: Date }): Promise<void> {
    const starred = this.sessionStars.get(input.userId) ?? new Set<string>();
    starred.add(input.sessionId);
    this.sessionStars.set(input.userId, starred);
  }

  async unstarSession(input: { sessionId: string; userId: string }): Promise<void> {
    this.sessionStars.get(input.userId)?.delete(input.sessionId);
  }

  async listStarredSessionIds(input: { userId: string; sessionIds: string[] }): Promise<Set<string>> {
    const starred = this.sessionStars.get(input.userId) ?? new Set<string>();
    return new Set(input.sessionIds.filter((sessionId) => starred.has(sessionId)));
  }

  async getSearchIndexCursor(): Promise<number> {
    return this.searchIndexCursor;
  }

  async setSearchIndexCursor(lastEventId: number): Promise<void> {
    this.searchIndexCursor = lastEventId;
  }

  async upsertSessionSearchDocs(docs: SessionSearchDocInput[]): Promise<void> {
    for (const doc of docs) this.sessionSearchDocs.set(sessionSearchDocKey(doc), doc);
  }

  async updateSession(record: SessionRecord): Promise<SessionRecord> {
    return this.updateSessionSync(record);
  }

  private updateSessionSync(record: SessionRecord): SessionRecord {
    if (!this.sessions.has(record.id)) {
      throw new Error(`Session does not exist: ${record.id}`);
    }

    this.sessions.set(record.id, record);
    return record;
  }

  async updateSessionContext(input: SessionContextUpdateInput): Promise<SessionRecord> {
    const existing = this.sessions.get(input.id);
    if (!existing) throw new Error(`Session does not exist: ${input.id}`);
    const session: SessionRecord = { ...existing, updatedAt: input.updatedAt };
    if (input.context !== undefined) session.context = input.context;
    else delete session.context;
    this.sessions.set(input.id, session);
    return session;
  }

  async updateSessionWithEvent(
    record: SessionRecord,
    event: NormalizedEvent,
    options?: { preserveTags?: boolean },
  ): Promise<{ session: SessionRecord; event: EventRecord }> {
    const current = this.sessions.get(record.id);
    const newerActivity = current && current.lastActivityAt > record.lastActivityAt;
    const next: SessionRecord = { ...record };
    if (newerActivity) {
      next.status = current.status;
      next.lastActivityAt = current.lastActivityAt;
      if (current.context !== undefined) next.context = current.context;
      else delete next.context;
    }
    if (options?.preserveTags) next.tags = current?.tags ?? record.tags;
    const session = this.updateSessionSync(next);
    return { session, event: this.appendEventWithNextSequenceSync(event) };
  }

  async updateSessionMetadataWithEvent(
    input: SessionMetadataUpdateInput,
  ): Promise<{ session: SessionRecord; event: EventRecord }> {
    const existing = this.sessions.get(input.id);
    if (!existing) throw new Error(`Session does not exist: ${input.id}`);
    if (input.requireNonArchived && existing.status === 'archived') {
      throw new StoreConflictError('session_archived', 'Archived sessions are read-only');
    }

    const session: SessionRecord = { ...existing, updatedAt: input.updatedAt };
    if (input.title !== undefined) session.title = input.title;
    if (input.tags !== undefined) session.tags = input.tags;
    if (input.ownerGroupId !== undefined) session.ownerGroupId = input.ownerGroupId;
    if (input.visibility !== undefined) session.visibility = input.visibility;
    if (input.writePolicy !== undefined) session.writePolicy = input.writePolicy;
    this.sessions.set(input.id, session);

    const event = this.appendEventWithNextSequenceSync({
      sessionId: session.id,
      type: 'session_updated',
      payload: {
        title: session.title ?? null,
        ...(input.tags !== undefined ? { tags: session.tags } : {}),
        ownerGroupId: session.ownerGroupId,
        visibility: session.visibility,
        writePolicy: session.writePolicy,
      },
      createdAt: input.updatedAt,
    });
    return { session, event };
  }

  async updateSessionTitleIfCurrent(
    input: SessionTitleUpdateInput,
  ): Promise<{ session: SessionRecord; event: EventRecord } | null> {
    const run = this.runs.get(input.runId);
    const validActiveRun =
      run?.status === 'running' &&
      run.leaseOwner === input.leaseOwner &&
      Boolean(run.leaseExpiresAt && run.leaseExpiresAt > input.now);
    if (
      !run ||
      run.sessionId !== input.id ||
      (!validActiveRun && run.status !== 'completed' && run.status !== 'failed')
    ) {
      return null;
    }
    const existing = this.sessions.get(input.id);
    if (!existing || existing.status === 'archived' || existing.title !== input.expectedTitle) return null;
    const session = { ...existing, title: input.title, updatedAt: input.updatedAt };
    this.sessions.set(input.id, session);
    const event = this.appendEventWithNextSequenceSync({
      sessionId: session.id,
      type: 'session_updated',
      payload: {
        title: session.title,
        ownerGroupId: session.ownerGroupId,
        visibility: session.visibility,
        writePolicy: session.writePolicy,
      },
      createdAt: input.updatedAt,
    });
    return { session, event };
  }

  async archiveSession(input: { sessionId: string; archivedAt: Date }): Promise<{
    session: SessionRecord;
    cancelledMessages: MessageRecord[];
    events: EventRecord[];
  }> {
    const existing = this.sessions.get(input.sessionId);
    if (!existing) throw new Error(`Session does not exist: ${input.sessionId}`);
    if (existing.status === 'archived') return { session: existing, cancelledMessages: [], events: [] };

    const sessionMessages = this.messages.get(input.sessionId) ?? [];
    const cancelledMessages: MessageRecord[] = [];
    for (const message of sessionMessages) {
      if (message.status !== 'pending') continue;
      const cancelled: MessageRecord = { ...message, status: 'cancelled' };
      sessionMessages[sessionMessages.indexOf(message)] = cancelled;
      cancelledMessages.push(cancelled);
    }

    const session = {
      ...existing,
      status: 'archived' as const,
      updatedAt: input.archivedAt,
      lastActivityAt: input.archivedAt,
    };
    this.sessions.set(input.sessionId, session);
    const events: EventRecord[] = [];
    for (const message of cancelledMessages) {
      events.push(
        this.appendEventWithNextSequenceSync({
          sessionId: session.id,
          messageId: message.id,
          type: 'message_cancelled',
          payload: { sequence: message.sequence, reason: 'session_archived' },
          createdAt: input.archivedAt,
        }),
      );
    }
    events.push(
      this.appendEventWithNextSequenceSync({
        sessionId: session.id,
        type: 'session_archived',
        payload: {},
        createdAt: input.archivedAt,
      }),
    );
    return { session, cancelledMessages, events };
  }

  async unarchiveSession(input: { sessionId: string; unarchivedAt: Date }): Promise<{
    session: SessionRecord;
    events: EventRecord[];
  }> {
    const existing = this.sessions.get(input.sessionId);
    if (!existing) throw new Error(`Session does not exist: ${input.sessionId}`);
    if (existing.status !== 'archived') return { session: existing, events: [] };
    const session: SessionRecord = {
      ...existing,
      status: 'idle',
      updatedAt: input.unarchivedAt,
      lastActivityAt: input.unarchivedAt,
    };
    this.sessions.set(input.sessionId, session);
    const event = this.appendEventWithNextSequenceSync({
      sessionId: session.id,
      type: 'session_unarchived',
      payload: {},
      createdAt: input.unarchivedAt,
    });
    return { session, events: [event] };
  }

  async updateSessionForRun(input: {
    id: string;
    context: Record<string, unknown>;
    updatedAt: Date;
    runId: string;
    leaseOwner: string;
    now: Date;
  }): Promise<SessionRecord | null> {
    const run = this.runs.get(input.runId);
    if (
      !run ||
      run.sessionId !== input.id ||
      (run.status !== 'running' && run.status !== 'cancelling') ||
      run.leaseOwner !== input.leaseOwner ||
      !run.leaseExpiresAt ||
      run.leaseExpiresAt <= input.now
    ) {
      return null;
    }
    const existing = this.sessions.get(input.id);
    if (!existing) throw new Error(`Session does not exist: ${input.id}`);
    const updated = { ...existing, context: input.context, updatedAt: input.updatedAt };
    this.sessions.set(input.id, updated);
    return updated;
  }

  async pauseSessionQueue(input: { sessionId: string; pausedAt: Date }): Promise<SessionRecord> {
    const existing = this.sessions.get(input.sessionId);
    if (!existing) throw new Error(`Session does not exist: ${input.sessionId}`);
    const updated = {
      ...existing,
      queuePausedAt: input.pausedAt,
      updatedAt: input.pausedAt,
      lastActivityAt: input.pausedAt,
    };
    this.sessions.set(input.sessionId, updated);
    return updated;
  }

  async resumeSessionQueue(input: { sessionId: string }): Promise<SessionRecord> {
    const existing = this.sessions.get(input.sessionId);
    if (!existing) throw new Error(`Session does not exist: ${input.sessionId}`);
    const now = new Date();
    const { queuePausedAt: _queuePausedAt, ...updated } = { ...existing, updatedAt: now, lastActivityAt: now };
    this.sessions.set(input.sessionId, updated);
    return updated;
  }

  async createSkill(record: CreateSkillRecord): Promise<SkillRecord> {
    return this.skillStore.createSkill(record);
  }

  async getSkill(id: string): Promise<SkillRecord | null> {
    return this.skillStore.getSkill(id);
  }

  async listSkillRevisions(skillId: string): Promise<SkillRevisionRecord[]> {
    return this.skillStore.listSkillRevisions(skillId);
  }

  async updateSkill(input: UpdateSkillRecord): Promise<SkillRecord> {
    return this.skillStore.updateSkill(input);
  }

  async archiveSkill(input: { skillId: string; archivedAt: Date }): Promise<SkillRecord | null> {
    return this.skillStore.archiveSkill(input);
  }

  async restoreSkill(input: { skillId: string; updatedAt: Date }): Promise<SkillRecord | null> {
    return this.skillStore.restoreSkill(input);
  }

  async promoteSkill(id: string, groupId: string, now: Date): Promise<SkillRecord | null> {
    return this.skillStore.promoteSkill(id, groupId, now);
  }

  async setSkillShares(
    id: string,
    shareMode: SkillShareMode,
    groupIds: string[],
    now: Date,
  ): Promise<SkillRecord | null> {
    return this.skillStore.setSkillShares(id, shareMode, groupIds, now);
  }

  async listSkillsForUser(userId: string): Promise<SkillRecord[]> {
    return this.skillStore.listSkillsForUser(userId);
  }

  async listSkillsForGroups(groupIds: string[]): Promise<SkillRecord[]> {
    return this.skillStore.listSkillsForGroups(groupIds);
  }

  async listSkillsSharedIntoGroups(groupIds: string[]): Promise<SkillRecord[]> {
    return this.skillStore.listSkillsSharedIntoGroups(groupIds);
  }

  async listSkillInvocationCandidates(input: { ownerGroupId: string; userId?: string }): Promise<SkillRunCandidate[]> {
    return this.skillStore.listSkillInvocationCandidates(input);
  }

  async listSkillsForRun(input: {
    ownerGroupId: string;
    createdByUserId?: string;
    invokedNames?: string[];
    invokedRevisions?: SkillRevisionSelection[];
  }): Promise<SkillRunCandidate[]> {
    return this.skillStore.listSkillsForRun(input);
  }

  async createAutomation(record: CreateAutomationRecord): Promise<AutomationRecord> {
    if (this.automations.has(record.id)) throw new Error(`Automation already exists: ${record.id}`);
    this.assertAutomationEnvironmentAvailable(record.environmentId, record.ownerGroupId);
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
    this.assertAutomationEnvironmentAvailable(
      input.environmentId === undefined ? existing.environmentId : (input.environmentId ?? undefined),
      input.ownerGroupId ?? existing.ownerGroupId,
    );
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
    if (input.environmentId !== undefined) {
      if (input.environmentId) updated.environmentId = input.environmentId;
      else delete updated.environmentId;
    }
    if (input.environmentRevisionPolicy !== undefined) {
      if (input.environmentRevisionPolicy) updated.environmentRevisionPolicy = input.environmentRevisionPolicy;
      else delete updated.environmentRevisionPolicy;
    }
    if (input.environmentRevisionId !== undefined) {
      if (input.environmentRevisionId) updated.environmentRevisionId = input.environmentRevisionId;
      else delete updated.environmentRevisionId;
    }
    if (input.nextInvocationAt !== undefined && input.nextInvocationAt !== null)
      updated.nextInvocationAt = input.nextInvocationAt;
    else if (input.nextInvocationAt === null) delete updated.nextInvocationAt;
    this.automations.set(input.id, updated);
    return updated;
  }

  async createEnvironment(record: CreateEnvironmentRecord): Promise<EnvironmentWithDetailsRecord> {
    if (this.environments.has(record.environment.id))
      throw new Error(`Environment already exists: ${record.environment.id}`);
    this.assertEnvironmentNameAvailable(record.environment.name, record.environment.ownerGroupId);
    const created = this.environmentWithDetails(record);
    this.environments.set(created.id, created);
    this.environmentRevisions.set(record.revision.id, cloneEnvironmentRevision(record.revision));
    this.environmentActivity.set(created.id, record.activities.map(cloneEnvironmentActivity));
    return created;
  }

  async getEnvironment(id: string): Promise<EnvironmentWithDetailsRecord | null> {
    return cloneEnvironment(this.environments.get(id)) ?? null;
  }

  async listEnvironments(): Promise<EnvironmentWithDetailsRecord[]> {
    return [...this.environments.values()]
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .map((environment) => cloneEnvironment(environment)!);
  }

  async getEnvironmentRevision(id: string): Promise<EnvironmentRevisionRecord | null> {
    const revision = this.environmentRevisions.get(id);
    return revision ? cloneEnvironmentRevision(revision) : null;
  }

  async listEnvironmentRevisions(environmentId: string): Promise<EnvironmentRevisionRecord[]> {
    return [...this.environmentRevisions.values()]
      .filter((revision) => revision.environmentId === environmentId)
      .sort((left, right) => right.revisionNumber - left.revisionNumber)
      .map(cloneEnvironmentRevision);
  }

  async listEnvironmentActivity(environmentId: string): Promise<EnvironmentActivityRecord[]> {
    return (this.environmentActivity.get(environmentId) ?? [])
      .slice()
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .map(cloneEnvironmentActivity);
  }

  async updateEnvironment(record: UpdateEnvironmentRecord): Promise<EnvironmentWithDetailsRecord> {
    const existing = this.environments.get(record.environment.id);
    if (!existing) throw new Error(`Environment does not exist: ${record.environment.id}`);
    if (existing.updatedAt.getTime() !== record.expectedUpdatedAt.getTime()) {
      throw new StoreConflictError('environment_update_conflict', 'Environment changed while it was being edited');
    }
    if (record.automationAccessAllowedGroupIds) {
      const allowed = new Set(record.automationAccessAllowedGroupIds);
      const conflicts = [...this.automations.values()].filter(
        (automation) =>
          automation.environmentId === record.environment.id &&
          !automation.archivedAt &&
          !allowed.has(automation.ownerGroupId),
      );
      if (conflicts.length) {
        throw new StoreConflictError(
          'environment_automation_conflict',
          'Environment access is used by active automations',
          { automations: conflicts.map(automationConflictDetail) },
        );
      }
    }
    if (
      !existing.archivedAt &&
      !record.environment.archivedAt &&
      (existing.name !== record.environment.name || existing.ownerGroupId !== record.environment.ownerGroupId)
    ) {
      this.assertEnvironmentNameAvailable(
        record.environment.name,
        record.environment.ownerGroupId,
        record.environment.id,
      );
    }
    const updated = this.environmentWithDetails(record);
    this.environments.set(updated.id, updated);
    if (record.revision) this.environmentRevisions.set(record.revision.id, cloneEnvironmentRevision(record.revision));
    this.appendEnvironmentActivity(updated.id, record.activities);
    return cloneEnvironment(updated)!;
  }

  async archiveEnvironment(input: {
    environmentId: string;
    archivedAt: Date;
    activity: EnvironmentActivityRecord;
  }): Promise<EnvironmentWithDetailsRecord | null> {
    const existing = this.environments.get(input.environmentId);
    if (!existing) return null;
    if (existing.archivedAt) return cloneEnvironment(existing)!;
    const conflicts = [...this.automations.values()].filter(
      (automation) => automation.environmentId === input.environmentId && !automation.archivedAt,
    );
    if (conflicts.length) {
      throw new StoreConflictError('environment_automation_conflict', 'Environment is used by active automations', {
        automations: conflicts.map(automationConflictDetail),
      });
    }
    const archived: EnvironmentWithDetailsRecord = {
      ...existing,
      archivedAt: existing.archivedAt ?? input.archivedAt,
      updatedAt: input.archivedAt,
    };
    this.environments.set(input.environmentId, archived);
    this.appendEnvironmentActivity(input.environmentId, [
      { ...input.activity, revisionId: existing.currentRevisionId },
    ]);
    return cloneEnvironment(archived)!;
  }

  async unarchiveEnvironment(input: {
    environmentId: string;
    updatedAt: Date;
    activity: EnvironmentActivityRecord;
  }): Promise<EnvironmentWithDetailsRecord | null> {
    const existing = this.environments.get(input.environmentId);
    if (!existing) return null;
    if (!existing.archivedAt) return cloneEnvironment(existing)!;
    this.assertEnvironmentNameAvailable(existing.name, existing.ownerGroupId, existing.id);
    const { archivedAt: _archivedAt, ...withoutArchive } = existing;
    const unarchived: EnvironmentWithDetailsRecord = {
      ...withoutArchive,
      updatedAt: input.updatedAt,
    };
    this.environments.set(input.environmentId, unarchived);
    this.appendEnvironmentActivity(input.environmentId, [
      { ...input.activity, revisionId: existing.currentRevisionId },
    ]);
    return cloneEnvironment(unarchived)!;
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
    this.assertAutomationEnvironmentAvailable(automation.environmentId, automation.ownerGroupId);
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
        lastActivityAt: record.createdAt,
      });
    }

    return record;
  }

  async getMessages(sessionId: string): Promise<MessageRecord[]> {
    return [...(this.messages.get(sessionId) ?? [])];
  }

  async getMessage(input: { sessionId: string; messageId: string }): Promise<MessageRecord | null> {
    return this.messages.get(input.sessionId)?.find((message) => message.id === input.messageId) ?? null;
  }

  async getSessionMessageSummary(sessionId: string): Promise<SessionMessageSummary> {
    const messages = await this.getMessages(sessionId);
    return { count: messages.length, lastMessage: messages[messages.length - 1] ?? null };
  }

  async getSessionTranscript(input: SessionTranscriptOptions): Promise<SessionTranscriptPage> {
    const candidates = (this.messages.get(input.sessionId) ?? [])
      .filter((message) => input.beforeSequence === undefined || message.sequence < input.beforeSequence)
      .sort((left, right) => right.sequence - left.sequence);
    const page = candidates.slice(0, input.limit);
    const entries = page.map((message) => ({
      message,
      finalResponse: latestFinalResponseForMessage(this.events.get(input.sessionId) ?? [], message.id),
    }));
    return {
      entries,
      hasMore: candidates.length > input.limit,
      ...(candidates.length > input.limit && entries.length
        ? { nextBeforeSequence: entries[entries.length - 1]!.message.sequence }
        : {}),
    };
  }

  async updatePendingMessage(input: {
    sessionId: string;
    messageId: string;
    prompt: string;
    context?: Record<string, unknown>;
  }): Promise<MessageRecord | null> {
    const sessionMessages = this.messages.get(input.sessionId) ?? [];
    const message = sessionMessages.find(
      (candidate) => candidate.id === input.messageId && candidate.status === 'pending',
    );
    if (!message) return null;
    const updated = {
      ...message,
      prompt: input.prompt,
      ...(input.context !== undefined ? { context: structuredClone(input.context) } : {}),
    };
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
      this.sessions.set(sessionId, { ...session, status: 'active', updatedAt: input.now, lastActivityAt: input.now });

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

  async getLatestRunForSession(sessionId: string): Promise<RunRecord | null> {
    return (
      Array.from(this.runs.values())
        .filter((run) => run.sessionId === sessionId)
        .sort((left, right) => right.startedAt.getTime() - left.startedAt.getTime())[0] ?? null
    );
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
          lastActivityAt: input.now,
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
    const claimed = this.finishRun(input.runId, input.leaseOwner, input.failedAt, 'failed');
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
    const session = this.sessions.get(input.sessionId);
    if (session) {
      this.sessions.set(input.sessionId, {
        ...session,
        status: session.status === 'archived' ? 'archived' : 'active',
        updatedAt: input.requestedAt,
        lastActivityAt: input.requestedAt,
      });
    }
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
    return this.latestSandbox((sandbox) => sandbox.sessionId === sessionId && sandbox.provider === provider);
  }

  async getLatestSandboxForSession(sessionId: string, preferredProvider?: string): Promise<SandboxRecord | null> {
    return this.latestSandbox(
      (sandbox) => sandbox.sessionId === sessionId,
      preferredProvider ? (sandbox) => sandbox.provider === preferredProvider : undefined,
    );
  }

  private latestSandbox(
    predicate: (sandbox: SandboxRecord) => boolean,
    prefer?: (sandbox: SandboxRecord) => boolean,
  ): SandboxRecord | null {
    return (
      Array.from(this.sandboxes.values())
        .filter(predicate)
        .sort(
          (a, b) =>
            Number(Boolean(prefer?.(b))) - Number(Boolean(prefer?.(a))) ||
            b.updatedAt.getTime() - a.updatedAt.getTime(),
        )[0] ?? null
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
    return this.nextEventSequenceSync(sessionId);
  }

  private nextEventSequenceSync(sessionId: string): number {
    const maxSequence = Math.max(0, ...(this.events.get(sessionId) ?? []).map((event) => event.sequence));
    return maxSequence + 1;
  }

  async appendEvent(event: NormalizedEvent & { sequence: number }): Promise<EventRecord> {
    return this.appendEventSync(event);
  }

  private appendEventSync(event: NormalizedEvent & { sequence: number }): EventRecord {
    const record = { ...event, id: this.nextEventId++ };
    const sessionEvents = this.events.get(event.sessionId) ?? [];
    sessionEvents.push(record);
    this.events.set(event.sessionId, sessionEvents);
    return record;
  }

  async appendEventWithNextSequence(event: NormalizedEvent): Promise<EventRecord> {
    return this.appendEventWithNextSequenceSync(event);
  }

  private appendEventWithNextSequenceSync(event: NormalizedEvent): EventRecord {
    return this.appendEventSync({ ...event, sequence: this.nextEventSequenceSync(event.sessionId) });
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

  async getLatestEventByType(sessionId: string, type: EventRecord['type']): Promise<EventRecord | null> {
    return (
      (this.events.get(sessionId) ?? [])
        .filter((event) => event.type === type)
        .sort((a, b) => b.sequence - a.sequence)[0] ?? null
    );
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
      lastActivityAt: finishedAt,
    });

    return { messages: terminalMessages, run: terminalRun };
  }

  private refreshQueuedSessionStatus(sessionId: string, updatedAt: Date): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.status === 'archived' || session.status === 'active') return;
    const hasPendingMessages = (this.messages.get(sessionId) ?? []).some((message) => message.status === 'pending');
    this.sessions.set(sessionId, {
      ...session,
      status: hasPendingMessages ? 'queued' : 'idle',
      updatedAt,
      lastActivityAt: updatedAt,
    });
  }

  private memorySearchDocuments(session: SessionRecord): Array<{ kind: SessionSearchMatchKind; content: string }> {
    return [
      { kind: 'title', content: session.title ?? '' },
      ...(this.messages.get(session.id) ?? []).map((message) => ({ kind: 'prompt' as const, content: message.prompt })),
      ...(this.events.get(session.id) ?? []).flatMap((event) => {
        if (event.type !== 'agent_response_final') return [];
        const payload = event.payload as { text?: unknown };
        return typeof payload.text === 'string' ? [{ kind: 'response' as const, content: payload.text }] : [];
      }),
      ...[...this.sessionSearchDocs.values()]
        .filter((doc) => doc.sessionId === session.id)
        .map((doc) => ({ kind: doc.kind, content: doc.content })),
    ];
  }

  private requireCallback(id: string): CallbackDeliveryRecord {
    const existing = this.callbacks.get(id);
    if (!existing) throw new Error(`Callback delivery does not exist: ${id}`);
    return existing;
  }

  private assertEnvironmentNameAvailable(name: string, ownerGroupId: string, exceptEnvironmentId?: string): void {
    const normalized = normalizedGroupName(name);
    const conflict = [...this.environments.values()].find(
      (environment) =>
        environment.id !== exceptEnvironmentId &&
        !environment.archivedAt &&
        environment.ownerGroupId === ownerGroupId &&
        normalizedGroupName(environment.name) === normalized,
    );
    if (conflict) throw new StoreConflictError('environment_name_exists', 'Environment name already exists');
  }

  private assertAutomationEnvironmentAvailable(environmentId: string | undefined, ownerGroupId: string): void {
    if (!environmentId) return;
    const environment = this.environments.get(environmentId);
    if (!environment || environment.archivedAt || !memoryEnvironmentAvailableToGroup(environment, ownerGroupId)) {
      throw new StoreConflictError(
        'automation_environment_unavailable',
        'Environment is no longer available to the automation owner group',
      );
    }
  }

  private environmentWithDetails(
    record: CreateEnvironmentRecord | UpdateEnvironmentRecord,
  ): EnvironmentWithDetailsRecord {
    return {
      ...record.environment,
      repositories: record.repositories
        .map((repository) => ({ ...repository }))
        .sort((left, right) => left.position - right.position),
      sharedGroupIds: [...record.sharedGroupIds].sort(compareStringAsc),
    };
  }

  private appendEnvironmentActivity(environmentId: string, activity: EnvironmentActivityRecord[]): void {
    const existing = this.environmentActivity.get(environmentId) ?? [];
    this.environmentActivity.set(environmentId, [...existing, ...activity.map(cloneEnvironmentActivity)]);
  }
}

function authAccountKey(provider: string, providerAccountId: string): string {
  return `${provider}:${providerAccountId}`;
}

function memoryEnvironmentAvailableToGroup(environment: EnvironmentWithDetailsRecord, groupId: string): boolean {
  return (
    environment.ownerGroupId === groupId ||
    environment.shareMode === 'all_groups' ||
    (environment.shareMode === 'selected_groups' && environment.sharedGroupIds.includes(groupId))
  );
}

function automationConflictDetail(automation: AutomationRecord): {
  id: string;
  name: string;
  ownerGroupId: string;
} {
  return { id: automation.id, name: automation.name, ownerGroupId: automation.ownerGroupId };
}

function groupMemberKey(groupId: string, userId: string): string {
  return `${groupId}:${userId}`;
}

function cloneEnvironment(
  environment: EnvironmentWithDetailsRecord | undefined,
): EnvironmentWithDetailsRecord | undefined {
  if (!environment) return undefined;
  return {
    ...environment,
    repositories: environment.repositories.map((repository) => ({ ...repository })),
    sharedGroupIds: [...environment.sharedGroupIds],
  };
}

function cloneEnvironmentRevision(revision: EnvironmentRevisionRecord): EnvironmentRevisionRecord {
  return { ...revision, repositories: revision.repositories.map((repository) => ({ ...repository })) };
}

function cloneEnvironmentActivity(activity: EnvironmentActivityRecord): EnvironmentActivityRecord {
  return { ...activity, payload: structuredClone(activity.payload) };
}

function normalizedGroupName(name: string): string {
  return name.trim().toLowerCase();
}

function canListSession(session: SessionRecord, visibleTo: SessionVisibilityFilter | undefined): boolean {
  return !visibleTo || session.visibility === 'organization' || visibleTo.groupIds.includes(session.ownerGroupId);
}

function sessionMatchesListFilters(
  session: SessionRecord,
  options: {
    tags?: string[];
    createdByUserId?: string;
    participantUserId?: string;
    starredByUserId?: string;
  },
  messages: Map<string, MessageRecord[]>,
  sessionStars: Map<string, Set<string>>,
): boolean {
  if (options.tags?.length && !options.tags.every((tag) => session.tags.includes(tag))) return false;
  if (options.createdByUserId && session.createdByUserId !== options.createdByUserId) return false;
  if (
    options.participantUserId &&
    !(messages.get(session.id) ?? []).some((message) => message.authorUserId === options.participantUserId)
  ) {
    return false;
  }
  if (options.starredByUserId && !sessionStars.get(options.starredByUserId)?.has(session.id)) return false;
  return true;
}

function compareSessionsNewestFirst(a: SessionRecord, b: SessionRecord): number {
  return (
    b.lastActivityAt.getTime() - a.lastActivityAt.getTime() ||
    b.createdAt.getTime() - a.createdAt.getTime() ||
    compareUuidDesc(a.id, b.id)
  );
}

function compareUuidDesc(a: string, b: string): number {
  return a < b ? 1 : a > b ? -1 : 0;
}

function compareStringAsc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isBeforeSessionCursor(
  session: SessionRecord,
  cursor: { lastActivityAt: Date; createdAt: Date; id: string },
): boolean {
  return compareSessionsNewestFirst(session, { ...session, ...cursor }) > 0;
}

type MemorySearchMatch = {
  kind: SessionSearchMatchKind;
  score: number;
  snippet: string;
};

function bestMemorySearchMatch(
  session: SessionRecord,
  terms: string[],
  documents: Array<{ kind: SessionSearchMatchKind; content: string }>,
): MemorySearchMatch | null {
  let best: MemorySearchMatch | null = null;
  for (const document of documents) {
    const lower = document.content.toLowerCase();
    const score = terms.reduce((total, term) => total + countOccurrences(lower, term), 0);
    if (score === 0) continue;
    const match = { kind: document.kind, score, snippet: memorySearchSnippet(document.content, terms) };
    if (!best || match.score > best.score || (match.score === best.score && document.kind === 'title')) best = match;
  }
  if (best) return best;
  if (session.title?.toLowerCase().includes(terms.join(' '))) {
    return { kind: 'title', score: 1, snippet: memorySearchSnippet(session.title, terms) };
  }
  return null;
}

function countOccurrences(value: string, term: string): number {
  if (!term) return 0;
  let count = 0;
  let index = value.indexOf(term);
  while (index !== -1) {
    count += 1;
    index = value.indexOf(term, index + term.length);
  }
  return count;
}

function memorySearchSnippet(content: string, terms: string[]): string {
  const lower = content.toLowerCase();
  const index = terms.reduce((best, term) => {
    const match = lower.indexOf(term);
    return match === -1 || (best !== -1 && best < match) ? best : match;
  }, -1);
  if (index === -1) return content.slice(0, 160);
  const start = Math.max(0, index - 60);
  const end = Math.min(content.length, index + 120);
  return `${start > 0 ? '...' : ''}${content.slice(start, end)}${end < content.length ? '...' : ''}`;
}

function sessionSearchDocKey(doc: Pick<SessionSearchDocInput, 'sessionId' | 'kind' | 'sourceId'>): string {
  return `${doc.sessionId}:${doc.kind}:${doc.sourceId}`;
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
  return compareUuidDesc(a.id, b.id);
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

function validateParentChildLimit(
  input: CreateSessionWithFirstMessageInput,
  parentExists: (parentSessionId: string) => boolean,
): void {
  if (!input.parentChildLimit) return;
  if (input.session.parentSessionId !== input.parentChildLimit.parentSessionId) {
    throw new Error('Parent child limit must match the session parent');
  }
  if (!parentExists(input.parentChildLimit.parentSessionId)) {
    throw new Error(`Parent session does not exist: ${input.parentChildLimit.parentSessionId}`);
  }
}

function sessionMatchesAgentScope(session: SessionRecord, input: AgentSessionListOptions): boolean {
  if (input.scope === 'children') {
    return (
      session.parentSessionId === input.actingSessionId && sessionIsReadableToAgentGroup(session, input.ownerGroupId)
    );
  }
  if (input.scope === 'group') return session.ownerGroupId === input.ownerGroupId;
  return sessionIsReadableToAgentGroup(session, input.ownerGroupId);
}

function sessionIsReadableToAgentGroup(session: SessionRecord, ownerGroupId: string): boolean {
  return session.visibility === 'organization' || session.ownerGroupId === ownerGroupId;
}

function latestFinalResponseForMessage(events: EventRecord[], messageId: string): EventRecord | null {
  return (
    events
      .filter((event) => event.type === 'agent_response_final' && event.messageId === messageId)
      .sort((left, right) => right.sequence - left.sequence)[0] ?? null
  );
}

function externalThreadKey(source: string, externalId: string): string {
  return `${source}:${externalId}`;
}

function deliveryKey(source: string, dedupeKey: string): string {
  return `${source}:${dedupeKey}`;
}

function withSessionDefaults(record: CreateSessionRecord): SessionRecord {
  return {
    ...record,
    spawnDepth: record.spawnDepth ?? 0,
    lastActivityAt: record.lastActivityAt ?? record.updatedAt,
    tags: [...(record.tags ?? [])],
  };
}
