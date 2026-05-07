import { randomUUID } from 'node:crypto';
import type { MessageService } from '../../messages/service.js';
import type { SessionService } from '../../sessions/service.js';
import type { AppStore, MessageRecord, SessionRecord } from '../../store/types.js';
import type { GitHubIssueContextFetcher, GitHubIssueThreadComment } from './issue-context-fetcher.js';
import type { GitHubReactionSender, GitHubReactionTarget } from './reaction-sender.js';

export type GitHubWebhookHeaders = {
  deliveryId?: string;
  event?: string;
};

export type GitHubWebhookServiceOptions = {
  allowedUsers?: string[];
  allowedOrganizations?: string[];
  triggerHandles?: string[];
  reactionSender?: Pick<GitHubReactionSender, 'addEyes'>;
  issueContextFetcher?: Pick<GitHubIssueContextFetcher, 'listIssueComments'>;
};

export type GitHubWebhookResult =
  | { ok: true; type: 'ignored'; reason: string }
  | { ok: true; type: 'duplicate' }
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
    private readonly store: AppStore,
    private readonly sessions: SessionService,
    private readonly messages: MessageService,
    private readonly options: GitHubWebhookServiceOptions = {},
  ) {}

  async handle(input: { headers: GitHubWebhookHeaders; payload: Record<string, unknown> }): Promise<GitHubWebhookResult> {
    const accepted = parseAcceptedEvent(input.headers, input.payload as GitHubWebhookPayload);
    if (!accepted) return { ok: true, type: 'ignored', reason: 'unsupported_event' };

    const delivery = await this.store.createIntegrationDelivery({
      id: randomUUID(),
      source: 'github',
      dedupeKey: accepted.deliveryId,
      receivedAt: new Date(),
      metadata: { event: accepted.event, action: accepted.action, owner: accepted.owner, repo: accepted.repo, number: accepted.number },
    });
    if (!delivery) return { ok: true, type: 'duplicate' };

    const authorizationFailure = this.authorizationFailure(accepted);
    if (authorizationFailure) {
      await this.store.markIntegrationDeliveryFailed({ source: 'github', dedupeKey: accepted.deliveryId, failedAt: new Date(), error: authorizationFailure });
      return { ok: true, type: 'ignored', reason: authorizationFailure };
    }

    const triggerFailure = this.triggerFailure(accepted);
    if (triggerFailure) {
      await this.store.markIntegrationDeliveryFailed({ source: 'github', dedupeKey: accepted.deliveryId, failedAt: new Date(), error: triggerFailure });
      return { ok: true, type: 'ignored', reason: triggerFailure };
    }

    await this.addReceivedReaction(accepted);

    const threadId = githubExternalThreadId(accepted);
    const session = await this.getOrCreateSession(threadId, accepted);
    if (session.status === 'archived') {
      await this.store.markIntegrationDeliveryProcessed({ source: 'github', dedupeKey: accepted.deliveryId, processedAt: new Date() });
      return { ok: true, type: 'ignored', reason: 'session_archived' };
    }
    const existingMessageCount = (await this.store.getMessages(session.id)).length;
    const threadContext = await this.fetchThreadContext(session, accepted);

    const message = await this.messages.enqueue({
      sessionId: session.id,
      prompt: renderGitHubPrompt(accepted, threadContext, { includeFullThreadContext: existingMessageCount === 0 }),
      source: 'github',
      context: {
        source: 'github',
        repository: { provider: 'github', owner: accepted.owner, repo: accepted.repo },
        github: {
          event: accepted.event,
          action: accepted.action,
          deliveryId: accepted.deliveryId,
          owner: accepted.owner,
          repo: accepted.repo,
          number: accepted.number,
          itemType: accepted.itemType,
          ...(accepted.commentId ? { commentId: accepted.commentId } : {}),
          includedCommentIds: threadContext.comments.map((comment) => comment.id),
        },
        callback: { type: 'github', owner: accepted.owner, repo: accepted.repo, issueNumber: accepted.number },
      },
    });

    await this.store.markIntegrationDeliveryProcessed({ source: 'github', dedupeKey: accepted.deliveryId, processedAt: new Date() });
    return { ok: true, type: 'accepted', session, message };
  }

  private async getOrCreateSession(threadId: string, event: AcceptedGitHubEvent): Promise<SessionRecord> {
    const existingThread = await this.store.getExternalThread('github', threadId);
    if (existingThread) {
      const session = await this.sessions.get(existingThread.sessionId);
      if (session) return session;
    }

    const session = await this.sessions.create({ title: githubSessionTitle(event) });
    await this.store.createExternalThread({
      id: randomUUID(),
      source: 'github',
      externalId: threadId,
      sessionId: session.id,
      metadata: { owner: event.owner, repo: event.repo, number: event.number, itemType: event.itemType },
      now: new Date(),
    });
    return session;
  }

  private authorizationFailure(event: AcceptedGitHubEvent): string | null {
    if (!isAllowed(event.owner, this.options.allowedOrganizations)) return 'unauthorized_repository_owner';
    if (!event.actor || !isAllowed(event.actor, this.options.allowedUsers)) return 'unauthorized_user';
    return null;
  }

  private triggerFailure(event: AcceptedGitHubEvent): string | null {
    if (!this.options.triggerHandles?.length) return null;
    return eventMentionsTrigger(event, this.options.triggerHandles) ? null : 'missing_trigger_handle';
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

  private async fetchThreadContext(session: SessionRecord, event: AcceptedGitHubEvent): Promise<GitHubThreadContext> {
    if (!this.options.issueContextFetcher) return { comments: [], unavailableReason: 'GitHub issue comment context fetcher is not configured' };
    try {
      const seenCommentIds = await this.processedCommentIds(session.id);
      if (event.commentId) seenCommentIds.add(event.commentId);
      const comments = await this.options.issueContextFetcher.listIssueComments({ owner: event.owner, repo: event.repo, issueNumber: event.number });
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
  if (headers.event === 'issue_comment') return parseIssueCommentEvent(headers.deliveryId, action, repository, payload, actor);
  if (headers.event === 'pull_request') return parsePullRequestEvent(headers.deliveryId, action, repository, payload, actor);
  if (headers.event === 'pull_request_review_comment') return parsePullRequestReviewCommentEvent(headers.deliveryId, action, repository, payload, actor);
  if (headers.event === 'pull_request_review') return parsePullRequestReviewEvent(headers.deliveryId, action, repository, payload, actor);
  return null;
}

function parseIssueEvent(deliveryId: string, action: string, repository: { owner: string; repo: string }, payload: GitHubWebhookPayload, actor: string | undefined): AcceptedGitHubEvent | null {
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

function parseIssueCommentEvent(deliveryId: string, action: string, repository: { owner: string; repo: string }, payload: GitHubWebhookPayload, actor: string | undefined): AcceptedGitHubEvent | null {
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

function parsePullRequestEvent(deliveryId: string, action: string, repository: { owner: string; repo: string }, payload: GitHubWebhookPayload, actor: string | undefined): AcceptedGitHubEvent | null {
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

function parsePullRequestReviewCommentEvent(deliveryId: string, action: string, repository: { owner: string; repo: string }, payload: GitHubWebhookPayload, actor: string | undefined): AcceptedGitHubEvent | null {
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

function parsePullRequestReviewEvent(deliveryId: string, action: string, repository: { owner: string; repo: string }, payload: GitHubWebhookPayload, actor: string | undefined): AcceptedGitHubEvent | null {
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

function renderGitHubPrompt(event: AcceptedGitHubEvent, threadContext: GitHubThreadContext, options: GitHubPromptOptions): string {
  const eventType = `${event.event}.${event.action}`;
  const lines = ['GitHub webhook context:', '---'];
  if (options.includeFullThreadContext) {
    lines.push(
      'GitHub event received.',
      '',
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
    if (event.headRef || event.baseRef) lines.push(`Branch: ${event.headRef ?? 'unknown'} -> ${event.baseRef ?? 'unknown'}`);
    if (event.headSha) lines.push(`Head SHA: ${event.headSha}`);
    if (event.labels.length) lines.push(`Labels: ${event.labels.join(', ')}`);
    if (event.body) lines.push('', 'Description:', event.body);
  }
  lines.push('---', '');

  if (threadContext.comments.length) {
    lines.push('Prior unprocessed GitHub comments:', '---');
    for (const comment of threadContext.comments) {
      lines.push('', `[${comment.author ?? 'github-user'}${comment.createdAt ? ` at ${comment.createdAt}` : ''}]:`, comment.body || '(empty comment)');
    }
    lines.push('---', '');
  } else if (threadContext.unavailableReason) {
    lines.push('Prior unprocessed GitHub comments:', '---');
    lines.push(`Prior GitHub comments were unavailable: ${threadContext.unavailableReason}.`);
    lines.push('---', '');
  }

  lines.push('Current tagged GitHub message:', '---');
  if (event.commentBody) lines.push(`[${event.actor ?? 'github-user'}]: ${event.commentBody}`);
  else if (event.reviewBody) lines.push(`[${event.actor ?? 'github-user'}]: ${event.reviewBody}`);
  else if (event.body) lines.push(`[${event.actor ?? 'github-user'}]: ${event.body}`);
  else lines.push(`[${event.actor ?? 'github-user'}]: (no body)`);
  if (event.reviewState) lines.push(`Review state: ${event.reviewState}`);
  if (event.path) lines.push(`File: ${event.path}`);
  if (event.diffHunk) lines.push('', 'Diff context:', event.diffHunk);
  return lines.join('\n');
}

function githubExternalThreadId(event: Pick<AcceptedGitHubEvent, 'owner' | 'repo' | 'number'>): string {
  return `${event.owner}/${event.repo}#${event.number}`;
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
  return value.map((label) => typeof label === 'object' && label ? stringValue((label as { name?: unknown }).name) : null).filter((label): label is string => Boolean(label));
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

function eventMentionsTrigger(event: AcceptedGitHubEvent, handles: string[]): boolean {
  const text = [event.title, event.body, event.commentBody, event.reviewBody].filter((value): value is string => Boolean(value)).join('\n').toLowerCase();
  if (!text) return false;
  return handles.some((handle) => {
    const normalized = handle.trim().toLowerCase().replace(/^@/, '');
    return Boolean(normalized) && text.includes(`@${normalized}`);
  });
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
    return { type: 'pull_request_review', owner: event.owner, repo: event.repo, pullNumber: event.number, reviewId: event.reviewId };
  }
  if (event.event === 'issues' || event.event === 'pull_request') {
    return { type: 'issue', owner: event.owner, repo: event.repo, issueNumber: event.number };
  }
  return null;
}
