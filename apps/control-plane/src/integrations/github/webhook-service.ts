import type { MessageService } from '../../messages/service.js';
import type { SessionService } from '../../sessions/service.js';
import type { IntegrationStore, MessageRecord, MessageStore, SessionRecord } from '../../store/types.js';
import {
  archivedIgnoredTranscriptPrompt,
  archivedRecoveryTranscriptPrompt,
  archivedRecoveryWorkPrompt,
  archivedSessionNotice,
  archivedSessionRecoveredNotice,
  includesArchivedSessionRecoveryPhrase,
  isArchivedSessionRecoveryOnly,
  unprocessedArchivedTranscriptMessages,
} from '../archive.js';
import { boundPriorContext, boundPromptText } from '../prompt-bounds.js';
import {
  enqueueIntegrationMessage,
  getOrCreateExternalThreadSession,
  markIntegrationDeliveryFailed,
  markIntegrationDeliveryProcessed,
  receiveIntegrationDelivery,
  type IntegrationIngress,
} from '../shared-utils.js';
import type { GitHubArchivedSessionNotifier } from './archived-session-notifier.js';
import { githubCallbackTarget } from './callback-target.js';
import type { GitHubIssueContextFetcher, GitHubIssueThreadComment } from './issue-context-fetcher.js';
import type { GitHubReactionSender, GitHubReactionTarget } from './reaction-sender.js';
import { isRepositoryAllowed } from './repository-access.js';

export type GitHubWebhookHeaders = {
  deliveryId?: string;
  event?: string;
};

export type GitHubWebhookServiceOptions = {
  allowedUsers?: string[];
  allowedOrganizations?: string[];
  allowedRepositories?: string[];
  triggerPhrases?: string[];
  reactionSender?: Pick<GitHubReactionSender, 'addEyes'>;
  issueContextFetcher?: Pick<GitHubIssueContextFetcher, 'listIssueComments'>;
  archivedSessionNotifier?: Pick<GitHubArchivedSessionNotifier, 'postNotice' | 'postRecoveryAcknowledgement'>;
  webBaseUrl?: string;
};

export type GitHubWebhookResult =
  | { ok: true; type: 'ignored'; reason: string }
  | { ok: true; type: 'duplicate' }
  | { ok: true; type: 'recovered'; session: SessionRecord }
  | { ok: true; type: 'accepted'; session: SessionRecord; message: MessageRecord };

type GitHubRepositoryPayload = {
  name?: unknown;
  full_name?: unknown;
  owner?: { login?: unknown };
};

type GitHubWebhookPayload = {
  action?: unknown;
  repository?: GitHubRepositoryPayload;
  sender?: { login?: unknown; type?: unknown };
  issue?: GitHubIssuePayload;
  pull_request?: GitHubPullRequestPayload;
  comment?: GitHubCommentPayload;
  review?: GitHubReviewPayload;
  changes?: Record<string, unknown>;
};

type GitHubIssuePayload = {
  number?: unknown;
  title?: unknown;
  body?: unknown;
  html_url?: unknown;
  pull_request?: unknown;
  user?: { login?: unknown };
  labels?: Array<{ name?: unknown }>;
};

type GitHubPullRequestPayload = GitHubIssuePayload & {
  head?: { ref?: unknown; sha?: unknown };
  base?: { ref?: unknown };
};

type GitHubCommentPayload = {
  id?: unknown;
  body?: unknown;
  html_url?: unknown;
  user?: { login?: unknown };
  path?: unknown;
  diff_hunk?: unknown;
};

type GitHubReviewPayload = {
  id?: unknown;
  body?: unknown;
  state?: unknown;
  user?: { login?: unknown };
};

type GitHubThreadContext = {
  comments: GitHubIssueThreadComment[];
  unavailableReason?: string;
};

type GitHubPromptOptions = {
  includeFullThreadContext: boolean;
};

type AcceptedGitHubEvent = {
  deliveryId: string;
  event: 'issues' | 'issue_comment' | 'pull_request' | 'pull_request_review_comment' | 'pull_request_review';
  action: string;
  owner: string;
  repo: string;
  number: number;
  itemType: 'Issue' | 'PR';
  actor?: string;
  title?: string;
  body?: string;
  url?: string;
  commentId?: number;
  commentBody?: string;
  commentUrl?: string;
  reviewId?: number;
  reviewBody?: string;
  reviewState?: string;
  path?: string;
  diffHunk?: string;
  labels: string[];
  headRef?: string;
  baseRef?: string;
  headSha?: string;
};

export class GitHubWebhookService {
  constructor(
    private readonly store: IntegrationStore & MessageStore,
    private readonly sessions: SessionService,
    private readonly messages: MessageService,
    private readonly options: GitHubWebhookServiceOptions = {},
  ) {}

  async handle(input: {
    headers: GitHubWebhookHeaders;
    payload: Record<string, unknown>;
  }): Promise<GitHubWebhookResult> {
    const accepted = parseAcceptedEvent(input.headers, input.payload);
    if (!accepted) return { ok: true, type: 'ignored', reason: 'unsupported_event' };

    const received = await receiveIntegrationDelivery(this.store, {
      source: 'github',
      dedupeKey: accepted.deliveryId,
      metadata: {
        event: accepted.event,
        action: accepted.action,
        owner: accepted.owner,
        repo: accepted.repo,
        number: accepted.number,
      },
    });
    if (!received) return { ok: true, type: 'duplicate' };
    const delivery = { id: received.id, source: 'github', dedupeKey: accepted.deliveryId };

    const authorizationFailure = this.authorizationFailure(accepted);
    if (authorizationFailure) {
      await markIntegrationDeliveryFailed(this.store, {
        ...delivery,
        error: authorizationFailure,
      });
      return { ok: true, type: 'ignored', reason: authorizationFailure };
    }

    const triggerFailure = this.triggerFailure(accepted);
    if (triggerFailure) {
      await markIntegrationDeliveryFailed(this.store, {
        ...delivery,
        error: triggerFailure,
      });
      return { ok: true, type: 'ignored', reason: triggerFailure };
    }

    await this.addReceivedReaction(accepted);

    let session = await this.getOrCreateSession(accepted);
    if (session.status === 'archived') {
      if (includesArchivedSessionRecoveryPhrase(githubEventText(accepted))) {
        session = await this.sessions.unarchive(session.id);
        const archivedMessages = unprocessedArchivedTranscriptMessages(
          await this.store.getMessages(session.id),
          'github',
        );
        if (archivedMessages.length) {
          const message = await this.enqueueArchivedRecoveryWork(session, accepted, archivedMessages);
          await markIntegrationDeliveryProcessed(this.store, delivery);
          return { ok: true, type: 'accepted', session, message };
        }
        if (isArchivedSessionRecoveryOnly(currentGitHubMessageText(accepted))) {
          await this.recordRecoveryTranscriptEntries(session.id, accepted);
          await markIntegrationDeliveryProcessed(this.store, delivery);
          await this.postRecoveryAcknowledgement(accepted);
          return { ok: true, type: 'recovered', session };
        }
      } else {
        await this.recordArchivedTranscriptEntries(session.id, accepted);
        await markIntegrationDeliveryProcessed(this.store, delivery);
        await this.postArchivedSessionNotice(accepted);
        return { ok: true, type: 'ignored', reason: 'session_archived' };
      }
    }
    const existingMessageCount = (await this.store.getMessages(session.id)).length;
    const threadContext = await this.fetchThreadContext(session, accepted);
    const promptThreadContext = { ...threadContext, comments: boundPriorContext(threadContext.comments) };

    const message = await enqueueIntegrationMessage(this.messages, session, {
      source: 'github',
      thread: githubIntegrationThread(accepted),
      title: githubSessionTitle(accepted),
      prompt: renderGitHubPrompt(accepted, promptThreadContext, {
        includeFullThreadContext: existingMessageCount === 0,
      }),
      dedupeKey: accepted.deliveryId,
      ...(accepted.actor ? { actor: { type: 'user' as const, externalId: accepted.actor } } : {}),
      repository: { provider: 'github', owner: accepted.owner, repo: accepted.repo },
      sourceContext: {
        github: {
          event: accepted.event,
          action: accepted.action,
          deliveryId: accepted.deliveryId,
          owner: accepted.owner,
          repo: accepted.repo,
          number: accepted.number,
          itemType: accepted.itemType,
          ...(accepted.commentId ? { commentId: accepted.commentId } : {}),
          includedCommentIds: promptThreadContext.comments.map((comment) => comment.id),
        },
      },
      callback: githubCallbackTarget({
        owner: accepted.owner,
        repo: accepted.repo,
        issueNumber: accepted.number,
        ...githubReplyHint(this.options.triggerPhrases),
        ...(existingMessageCount === 0 ? { includeSessionLink: true } : {}),
        ...callbackSessionUrl(session.id, this.options.webBaseUrl),
      }),
    });

    await markIntegrationDeliveryProcessed(this.store, delivery);
    return { ok: true, type: 'accepted', session, message };
  }

  private async getOrCreateSession(event: AcceptedGitHubEvent): Promise<SessionRecord> {
    return getOrCreateExternalThreadSession(this.store, this.sessions, {
      ...githubIntegrationThread(event),
      title: githubSessionTitle(event),
      tags: ['github'],
    });
  }

  private authorizationFailure(event: AcceptedGitHubEvent): string | null {
    if (!isAllowed(event.owner, this.options.allowedOrganizations)) return 'unauthorized_repository_owner';
    if (!isRepositoryAllowed({ owner: event.owner, repo: event.repo }, this.options.allowedRepositories))
      return 'unauthorized_repository';
    if (!event.actor || !isAllowed(event.actor, this.options.allowedUsers)) return 'unauthorized_user';
    return null;
  }

  private triggerFailure(event: AcceptedGitHubEvent): string | null {
    if (!this.options.triggerPhrases?.length) return null;
    if (includesArchivedSessionRecoveryPhrase(githubEventText(event))) return null;
    return eventMatchesTrigger(event, this.options.triggerPhrases) ? null : 'missing_trigger_phrase';
  }

  private async addReceivedReaction(event: AcceptedGitHubEvent): Promise<void> {
    if (!this.options.reactionSender) return;
    const target = reactionTarget(event);
    if (!target) return;
    try {
      await this.options.reactionSender.addEyes(target);
    } catch (error) {
      console.warn(error instanceof Error ? error.message : error);
    }
  }

  private async postArchivedSessionNotice(event: AcceptedGitHubEvent): Promise<void> {
    if (!this.options.archivedSessionNotifier) return;
    try {
      await this.options.archivedSessionNotifier.postNotice({
        owner: event.owner,
        repo: event.repo,
        issueNumber: event.number,
      });
    } catch (error) {
      console.warn(error instanceof Error ? error.message : error);
    }
  }

  private async postRecoveryAcknowledgement(event: AcceptedGitHubEvent): Promise<void> {
    if (!this.options.archivedSessionNotifier) return;
    try {
      await this.options.archivedSessionNotifier.postRecoveryAcknowledgement({
        owner: event.owner,
        repo: event.repo,
        issueNumber: event.number,
      });
    } catch (error) {
      console.warn(error instanceof Error ? error.message : error);
    }
  }

  private async recordArchivedTranscriptEntries(sessionId: string, event: AcceptedGitHubEvent): Promise<void> {
    await this.messages.recordTranscriptEntry({
      sessionId,
      prompt: archivedIgnoredTranscriptPrompt(currentGitHubMessageText(event)),
      source: 'github',
      context: {
        source: 'github',
        transcriptOnly: true,
        repository: { provider: 'github', owner: event.owner, repo: event.repo },
        github: {
          event: event.event,
          action: event.action,
          deliveryId: event.deliveryId,
          owner: event.owner,
          repo: event.repo,
          number: event.number,
          itemType: event.itemType,
          ...(event.commentId ? { commentId: event.commentId } : {}),
        },
      },
    });
    await this.messages.recordTranscriptEntry({
      sessionId,
      prompt: archivedSessionNotice(),
      source: 'github_notice',
      context: {
        source: 'github',
        transcriptOnly: true,
        repository: { provider: 'github', owner: event.owner, repo: event.repo },
        notice: { type: 'archived_session', owner: event.owner, repo: event.repo, issueNumber: event.number },
      },
    });
  }

  private async recordRecoveryTranscriptEntries(sessionId: string, event: AcceptedGitHubEvent): Promise<void> {
    await this.messages.recordTranscriptEntry({
      sessionId,
      prompt: archivedRecoveryTranscriptPrompt(currentGitHubMessageText(event)),
      source: 'github',
      context: {
        source: 'github',
        transcriptOnly: true,
        repository: { provider: 'github', owner: event.owner, repo: event.repo },
        github: {
          event: event.event,
          action: event.action,
          deliveryId: event.deliveryId,
          owner: event.owner,
          repo: event.repo,
          number: event.number,
          itemType: event.itemType,
          ...(event.commentId ? { commentId: event.commentId } : {}),
        },
      },
    });
    await this.messages.recordTranscriptEntry({
      sessionId,
      prompt: archivedSessionRecoveredNotice(),
      source: 'github_notice',
      context: {
        source: 'github',
        transcriptOnly: true,
        repository: { provider: 'github', owner: event.owner, repo: event.repo },
        notice: { type: 'session_recovered', owner: event.owner, repo: event.repo, issueNumber: event.number },
      },
    });
  }

  private async enqueueArchivedRecoveryWork(
    session: SessionRecord,
    event: AcceptedGitHubEvent,
    archivedMessages: MessageRecord[],
  ): Promise<MessageRecord> {
    return enqueueIntegrationMessage(this.messages, session, {
      source: 'github',
      thread: githubIntegrationThread(event),
      title: githubSessionTitle(event),
      prompt: archivedRecoveryWorkPrompt({
        sourceLabel: 'GitHub',
        archivedMessages,
        recoveryText: currentGitHubMessageText(event),
      }),
      dedupeKey: event.deliveryId,
      ...(event.actor ? { actor: { type: 'user' as const, externalId: event.actor } } : {}),
      repository: { provider: 'github', owner: event.owner, repo: event.repo },
      sourceContext: {
        includedArchivedMessageIds: archivedMessages.map((message) => message.id),
        github: {
          event: event.event,
          action: event.action,
          deliveryId: event.deliveryId,
          owner: event.owner,
          repo: event.repo,
          number: event.number,
          itemType: event.itemType,
          ...(event.commentId ? { commentId: event.commentId } : {}),
          includedCommentIds: [],
        },
      },
      callback: githubCallbackTarget({
        owner: event.owner,
        repo: event.repo,
        issueNumber: event.number,
        ...githubReplyHint(this.options.triggerPhrases),
        ...callbackSessionUrl(session.id, this.options.webBaseUrl),
      }),
    });
  }

  private async fetchThreadContext(session: SessionRecord, event: AcceptedGitHubEvent): Promise<GitHubThreadContext> {
    if (!this.options.issueContextFetcher)
      return { comments: [], unavailableReason: 'GitHub issue comment context fetcher is not configured' };
    try {
      const seenCommentIds = await this.processedCommentIds(session.id);
      if (event.commentId) seenCommentIds.add(event.commentId);
      const comments = await this.options.issueContextFetcher.listIssueComments({
        owner: event.owner,
        repo: event.repo,
        issueNumber: event.number,
      });
      return { comments: comments.filter((comment) => !seenCommentIds.has(comment.id) && !isBotComment(comment)) };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown_error';
      console.warn(message);
      return { comments: [], unavailableReason: message };
    }
  }

  private async processedCommentIds(sessionId: string): Promise<Set<number>> {
    const messages = await this.store.getMessages(sessionId);
    return new Set(messages.flatMap(githubCommentIdsFromMessage));
  }
}

function parseAcceptedEvent(headers: GitHubWebhookHeaders, payload: GitHubWebhookPayload): AcceptedGitHubEvent | null {
  if (!headers.deliveryId || !headers.event) return null;
  const repository = parseRepository(payload.repository);
  if (!repository) return null;
  const action = stringValue(payload.action);
  if (!action) return null;
  const actor = stringValue(payload.sender?.login);
  if (payload.sender?.type === 'Bot') return null;

  if (headers.event === 'issues') return parseIssueEvent(headers.deliveryId, action, repository, payload, actor);
  if (headers.event === 'issue_comment')
    return parseIssueCommentEvent(headers.deliveryId, action, repository, payload, actor);
  if (headers.event === 'pull_request')
    return parsePullRequestEvent(headers.deliveryId, action, repository, payload, actor);
  if (headers.event === 'pull_request_review_comment')
    return parsePullRequestReviewCommentEvent(headers.deliveryId, action, repository, payload, actor);
  if (headers.event === 'pull_request_review')
    return parsePullRequestReviewEvent(headers.deliveryId, action, repository, payload, actor);
  return null;
}

function parseIssueEvent(
  deliveryId: string,
  action: string,
  repository: { owner: string; repo: string },
  payload: GitHubWebhookPayload,
  actor: string | undefined,
): AcceptedGitHubEvent | null {
  if (!['opened', 'reopened', 'edited'].includes(action)) return null;
  if (action === 'edited' && !payload.changes?.title && !payload.changes?.body) return null;
  const issue = payload.issue;
  const number = numberValue(issue?.number);
  if (!issue || !number || issue.pull_request) return null;
  return {
    deliveryId,
    event: 'issues',
    action,
    ...repository,
    number,
    itemType: 'Issue',
    labels: labels(issue.labels),
    ...(actor ? { actor } : {}),
    ...textFields(issue),
  };
}

function parseIssueCommentEvent(
  deliveryId: string,
  action: string,
  repository: { owner: string; repo: string },
  payload: GitHubWebhookPayload,
  actor: string | undefined,
): AcceptedGitHubEvent | null {
  if (action !== 'created') return null;
  const issue = payload.issue;
  const comment = payload.comment;
  const number = numberValue(issue?.number);
  const commentId = numberValue(comment?.id);
  if (!issue || !comment || !number || !commentId) return null;
  return {
    deliveryId,
    event: 'issue_comment',
    action,
    ...repository,
    number,
    itemType: issue.pull_request ? 'PR' : 'Issue',
    commentId,
    labels: labels(issue.labels),
    ...(actor ? { actor } : {}),
    ...textFields(issue),
    ...commentFields(comment),
  };
}

function parsePullRequestEvent(
  deliveryId: string,
  action: string,
  repository: { owner: string; repo: string },
  payload: GitHubWebhookPayload,
  actor: string | undefined,
): AcceptedGitHubEvent | null {
  if (!['opened', 'reopened', 'synchronize', 'edited'].includes(action)) return null;
  if (action === 'edited' && !payload.changes?.title && !payload.changes?.body && !payload.changes?.base) return null;
  const pr = payload.pull_request;
  const number = numberValue(pr?.number);
  if (!pr || !number) return null;
  const headRef = stringValue(pr.head?.ref);
  const baseRef = stringValue(pr.base?.ref);
  const headSha = stringValue(pr.head?.sha);
  return {
    deliveryId,
    event: 'pull_request',
    action,
    ...repository,
    number,
    itemType: 'PR',
    labels: labels(pr.labels),
    ...(actor ? { actor } : {}),
    ...textFields(pr),
    ...(headRef ? { headRef } : {}),
    ...(baseRef ? { baseRef } : {}),
    ...(headSha ? { headSha } : {}),
  };
}

function parsePullRequestReviewCommentEvent(
  deliveryId: string,
  action: string,
  repository: { owner: string; repo: string },
  payload: GitHubWebhookPayload,
  actor: string | undefined,
): AcceptedGitHubEvent | null {
  if (action !== 'created') return null;
  const pr = payload.pull_request;
  const comment = payload.comment;
  const number = numberValue(pr?.number);
  const commentId = numberValue(comment?.id);
  if (!pr || !comment || !number || !commentId) return null;
  return {
    deliveryId,
    event: 'pull_request_review_comment',
    action,
    ...repository,
    number,
    itemType: 'PR',
    commentId,
    labels: labels(pr.labels),
    ...(actor ? { actor } : {}),
    ...textFields(pr),
    ...commentFields(comment),
    ...reviewCommentFields(comment),
  };
}

function parsePullRequestReviewEvent(
  deliveryId: string,
  action: string,
  repository: { owner: string; repo: string },
  payload: GitHubWebhookPayload,
  actor: string | undefined,
): AcceptedGitHubEvent | null {
  if (action !== 'submitted') return null;
  const pr = payload.pull_request;
  const review = payload.review;
  const number = numberValue(pr?.number);
  const reviewId = numberValue(review?.id);
  if (!pr || !review || !number || !reviewId) return null;
  const reviewBody = stringValue(review.body);
  const reviewState = stringValue(review.state);
  return {
    deliveryId,
    event: 'pull_request_review',
    action,
    ...repository,
    number,
    itemType: 'PR',
    reviewId,
    labels: labels(pr.labels),
    ...(actor ? { actor } : {}),
    ...textFields(pr),
    ...(reviewBody ? { reviewBody } : {}),
    ...(reviewState ? { reviewState } : {}),
  };
}

function renderGitHubPrompt(
  event: AcceptedGitHubEvent,
  threadContext: GitHubThreadContext,
  options: GitHubPromptOptions,
): string {
  const eventType = `${event.event}.${event.action}`;
  const lines = ['GitHub webhook context:', '---'];
  if (options.includeFullThreadContext) {
    lines.push(
      `Event: ${eventType}`,
      `Repository: ${event.owner}/${event.repo}`,
      `${event.itemType} #${event.number}: ${event.title ?? '(no title)'}`,
      `Actor: ${event.actor ?? 'unknown'}`,
    );
  } else {
    lines.push(`Event: ${eventType}`);
  }
  if (options.includeFullThreadContext) {
    if (event.url) lines.push(`URL: ${event.url}`);
    if (event.headRef || event.baseRef)
      lines.push(`Branch: ${event.headRef ?? 'unknown'} -> ${event.baseRef ?? 'unknown'}`);
    if (event.headSha) lines.push(`Head SHA: ${event.headSha}`);
    if (event.labels.length) lines.push(`Labels: ${event.labels.join(', ')}`);
    if (event.body) lines.push('', 'Description:', boundPromptText(event.body));
  }
  lines.push('---', '');

  if (threadContext.comments.length) {
    lines.push('Prior unprocessed GitHub comments:', '---');
    for (const comment of threadContext.comments) {
      lines.push(
        '',
        `[${comment.author ?? 'github-user'}${comment.createdAt ? ` at ${comment.createdAt}` : ''}]:`,
        comment.body ? boundPromptText(comment.body) : '(empty comment)',
      );
    }
    lines.push('---', '');
  } else if (threadContext.unavailableReason) {
    lines.push('Prior unprocessed GitHub comments:', '---');
    lines.push(`Prior GitHub comments were unavailable: ${threadContext.unavailableReason}.`);
    lines.push('---', '');
  }

  lines.push('Current tagged GitHub message:', '---');
  if (event.commentBody) lines.push(`[${event.actor ?? 'github-user'}]: ${boundPromptText(event.commentBody)}`);
  else if (event.reviewBody) lines.push(`[${event.actor ?? 'github-user'}]: ${boundPromptText(event.reviewBody)}`);
  else if (event.body) lines.push(`[${event.actor ?? 'github-user'}]: ${boundPromptText(event.body)}`);
  else lines.push(`[${event.actor ?? 'github-user'}]: (no body)`);
  if (event.reviewState) lines.push(`Review state: ${event.reviewState}`);
  if (event.path) lines.push(`File: ${event.path}`);
  if (event.diffHunk) lines.push('', 'Diff context:', boundPromptText(event.diffHunk));
  return lines.join('\n');
}

function githubExternalThreadId(event: Pick<AcceptedGitHubEvent, 'owner' | 'repo' | 'number'>): string {
  return `${event.owner}/${event.repo}#${event.number}`;
}

function githubIntegrationThread(
  event: Pick<AcceptedGitHubEvent, 'owner' | 'repo' | 'number' | 'itemType'>,
): IntegrationIngress['thread'] {
  return {
    source: 'github',
    externalId: githubExternalThreadId(event),
    metadata: { owner: event.owner, repo: event.repo, number: event.number, itemType: event.itemType },
  };
}

function callbackSessionUrl(sessionId: string, webBaseUrl: string | undefined): { sessionUrl?: string } {
  if (!webBaseUrl) return {};
  const url = new URL(webBaseUrl);
  url.searchParams.set('session', sessionId);
  return { sessionUrl: url.toString() };
}

function githubReplyHint(triggerPhrases: string[] | undefined): { replyHint?: string } {
  const phrase = triggerPhrases?.[0];
  return phrase ? { replyHint: `Include the phrase \`${phrase}\` to continue here.` } : {};
}

function githubSessionTitle(event: AcceptedGitHubEvent): string {
  return `GitHub ${event.itemType} #${event.number}: ${event.title ?? `${event.owner}/${event.repo}`}`;
}

function parseRepository(repository: GitHubRepositoryPayload | undefined): { owner: string; repo: string } | null {
  const owner = stringValue(repository?.owner?.login);
  const repo = stringValue(repository?.name);
  if (owner && repo) return { owner, repo };
  const fullName = stringValue(repository?.full_name);
  const match = fullName?.match(/^([^/]+)\/([^/]+)$/);
  return match ? { owner: match[1]!, repo: match[2]! } : null;
}

function textFields(item: GitHubIssuePayload): { title?: string; body?: string; url?: string } {
  const title = stringValue(item.title);
  const body = stringValue(item.body);
  const url = stringValue(item.html_url);
  return {
    ...(title ? { title } : {}),
    ...(body ? { body } : {}),
    ...(url ? { url } : {}),
  };
}

function commentFields(comment: GitHubCommentPayload): { commentBody?: string; commentUrl?: string } {
  const commentBody = stringValue(comment.body);
  const commentUrl = stringValue(comment.html_url);
  return {
    ...(commentBody ? { commentBody } : {}),
    ...(commentUrl ? { commentUrl } : {}),
  };
}

function reviewCommentFields(comment: GitHubCommentPayload): { path?: string; diffHunk?: string } {
  const path = stringValue((comment as { path?: unknown }).path);
  const diffHunk = stringValue((comment as { diff_hunk?: unknown }).diff_hunk);
  return {
    ...(path ? { path } : {}),
    ...(diffHunk ? { diffHunk } : {}),
  };
}

function labels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((label) => (typeof label === 'object' && label ? stringValue((label as { name?: unknown }).name) : null))
    .filter((label): label is string => Boolean(label));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function isAllowed(value: string, allowlist: string[] | undefined): boolean {
  if (!allowlist?.length) return true;
  return allowlist.some((allowed) => allowed.toLowerCase() === value.toLowerCase());
}

function eventMatchesTrigger(event: AcceptedGitHubEvent, phrases: string[]): boolean {
  const text = triggerSearchText(event).toLowerCase();
  if (!text) return false;
  return phrases.some((phrase) => triggerPhraseMatches(text, phrase));
}

function triggerPhraseMatches(text: string, phrase: string): boolean {
  const normalized = phrase.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.startsWith('@') || normalized.startsWith('/') || normalized.endsWith(':'))
    return phraseBoundaryMatches(text, normalized);
  if (normalized.includes('/'))
    return phraseBoundaryMatches(text, `@${normalized}`) || phraseBoundaryMatches(text, normalized);
  return (
    text.includes(`@${normalized}`) ||
    text.includes(`/${normalized}`) ||
    text.includes(`${normalized}:`) ||
    phraseBoundaryMatches(text, normalized)
  );
}

function phraseBoundaryMatches(text: string, phrase: string): boolean {
  return new RegExp(`(^|[^a-z0-9_-])${escapeRegExp(phrase)}($|[^a-z0-9_-])`, 'i').test(text);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function githubEventText(event: AcceptedGitHubEvent): string {
  return [event.title, event.body, event.commentBody, event.reviewBody]
    .filter((value): value is string => Boolean(value))
    .join('\n');
}

function triggerSearchText(event: AcceptedGitHubEvent): string {
  if (event.commentBody || event.reviewBody)
    return [event.commentBody, event.reviewBody].filter((value): value is string => Boolean(value)).join('\n');
  return [event.title, event.body].filter((value): value is string => Boolean(value)).join('\n');
}

function currentGitHubMessageText(event: AcceptedGitHubEvent): string {
  return event.commentBody ?? event.reviewBody ?? event.body ?? '(no body)';
}

function githubCommentIdsFromMessage(message: MessageRecord): number[] {
  const github = message.context?.github;
  if (!github || typeof github !== 'object' || Array.isArray(github)) return [];
  const record = github as Record<string, unknown>;
  const ids: number[] = [];
  if (typeof record.commentId === 'number' && Number.isInteger(record.commentId)) ids.push(record.commentId);
  if (Array.isArray(record.includedCommentIds)) {
    for (const id of record.includedCommentIds) {
      if (typeof id === 'number' && Number.isInteger(id)) ids.push(id);
    }
  }
  return ids;
}

function isBotComment(comment: GitHubIssueThreadComment): boolean {
  if (comment.authorType?.toLowerCase() === 'bot') return true;
  return Boolean(comment.author?.toLowerCase().endsWith('[bot]'));
}

function reactionTarget(event: AcceptedGitHubEvent): GitHubReactionTarget | null {
  if (event.event === 'issue_comment' && event.commentId) {
    return { type: 'issue_comment', owner: event.owner, repo: event.repo, commentId: event.commentId };
  }
  if (event.event === 'pull_request_review_comment' && event.commentId) {
    return { type: 'pull_request_review_comment', owner: event.owner, repo: event.repo, commentId: event.commentId };
  }
  if (event.event === 'pull_request_review' && event.reviewId) {
    return {
      type: 'pull_request_review',
      owner: event.owner,
      repo: event.repo,
      pullNumber: event.number,
      reviewId: event.reviewId,
    };
  }
  if (event.event === 'issues' || event.event === 'pull_request') {
    return { type: 'issue', owner: event.owner, repo: event.repo, issueNumber: event.number };
  }
  return null;
}
