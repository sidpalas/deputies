import { createApp, createServices } from '../../src/app/server.js';
import { loadConfig } from '../../src/config/index.js';
import { createGitHubWebhookSignature, verifyGitHubWebhookSignature } from '../../src/integrations/github/webhook-auth.js';
import { GitHubWebhookService } from '../../src/integrations/github/webhook-service.js';
import { GitHubCompletionCallbackSender } from '../../src/integrations/github/callback-sender.js';
import { MemoryStore } from '../../src/store/memory.js';

const secret = 'dev-github-webhook-secret';

describe('GitHub webhook integration', () => {
  it('verifies GitHub webhook signatures', () => {
    const body = JSON.stringify({ action: 'opened' });
    const signature = createGitHubWebhookSignature({ body, secret });

    expect(verifyGitHubWebhookSignature({ signature, body, secret })).toBe(true);
    expect(verifyGitHubWebhookSignature({ signature: `${signature}0`, body, secret })).toBe(false);
    expect(verifyGitHubWebhookSignature({ signature: undefined, body, secret })).toBe(false);
  });

  it('creates sessions from GitHub issues and reuses issue threads for comments', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const github = new GitHubWebhookService(store, services.sessions, services.messages, {
      allowedUsers: ['octocat'],
      allowedOrganizations: ['acme'],
    });

    const issue = await github.handle({
      headers: { deliveryId: 'delivery-1', event: 'issues' },
      payload: issuePayload({ action: 'opened', title: 'Fix the flaky test', body: 'It fails intermittently.' }),
    });
    const comment = await github.handle({
      headers: { deliveryId: 'delivery-2', event: 'issue_comment' },
      payload: issueCommentPayload({ body: 'Please handle this.' }),
    });

    expect(issue.type).toBe('accepted');
    expect(comment.type).toBe('accepted');
    if (issue.type !== 'accepted' || comment.type !== 'accepted') throw new Error('Expected accepted GitHub events');
    expect(issue.session.id).toBe(comment.session.id);

    const messages = await services.messages.list(issue.session.id);
    expect(messages).toHaveLength(2);
    expect(messages.map((message) => message.source)).toEqual(['github', 'github']);
    expect(messages[0]!.context?.repository).toEqual({ provider: 'github', owner: 'acme', repo: 'widget' });
    expect(messages[0]!.context?.callback).toEqual({ type: 'github', owner: 'acme', repo: 'widget', issueNumber: 42 });
    expect(messages[0]!.prompt).toContain('GitHub webhook context:\n---');
    expect(messages[0]!.prompt).toContain('Event: issues.opened');
    expect(messages[0]!.prompt).toContain('Repository: acme/widget');
    expect(messages[0]!.prompt).not.toContain('github_untrusted_content');
    expect(messages[0]!.prompt).not.toContain('IMPORTANT:');
    expect(messages[1]!.prompt).toContain('Event: issue_comment.created');
    expect(messages[1]!.prompt).toContain('Current tagged GitHub message:\n---\n[octocat]: Please handle this.');
    expect(messages[1]!.prompt).toContain('Please handle this.');
  });

  it('includes prior unprocessed GitHub issue comments as thread context', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const github = new GitHubWebhookService(store, services.sessions, services.messages, {
      issueContextFetcher: {
        async listIssueComments() {
          return [
            { id: 10, author: 'alice', body: 'Extra repro detail', createdAt: '2026-05-06T00:00:00Z' },
            { id: 11, author: 'open-inspect-sidpalas', authorType: 'Bot', body: 'Deputy response that should be hidden' },
            { id: 99, author: 'octocat', body: '@dev-deputies please handle this' },
          ];
        },
      },
    });

    const accepted = await github.handle({
      headers: { deliveryId: 'delivery-1', event: 'issue_comment' },
      payload: issueCommentPayload({ body: '@dev-deputies please handle this' }),
    });

    expect(accepted.type).toBe('accepted');
    if (accepted.type !== 'accepted') throw new Error('Expected accepted GitHub event');
    const messages = await services.messages.list(accepted.session.id);
    expect(messages[0]!.prompt).toContain('Prior unprocessed GitHub comments:');
    expect(messages[0]!.prompt).toContain('Prior unprocessed GitHub comments:\n---');
    expect(messages[0]!.prompt).toContain('[alice at 2026-05-06T00:00:00Z]:');
    expect(messages[0]!.prompt).toContain('Extra repro detail');
    expect(messages[0]!.prompt).toContain('Current tagged GitHub message:\n---\n[octocat]: @dev-deputies please handle this');
    expect(messages[0]!.prompt).not.toContain('Deputy response that should be hidden');
    expect(messages[0]!.prompt).not.toContain('[octocat]: @dev-deputies please handle this\n\nPrior unprocessed GitHub comments');
    expect(messages[0]!.context?.github).toMatchObject({ commentId: 99, includedCommentIds: [10] });
  });

  it('does not repeat GitHub comments already included in prior messages', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    let fetches = 0;
    const github = new GitHubWebhookService(store, services.sessions, services.messages, {
      issueContextFetcher: {
        async listIssueComments() {
          fetches += 1;
          if (fetches === 1) {
            return [
              { id: 10, author: 'alice', body: 'Already processed' },
              { id: 99, author: 'octocat', body: '@dev-deputies please handle this' },
            ];
          }
          return [
            { id: 10, author: 'alice', body: 'Already processed' },
            { id: 11, author: 'bob', body: 'New context' },
            { id: 100, author: 'octocat', body: '@dev-deputies follow up' },
          ];
        },
      },
    });

    const first = await github.handle({
      headers: { deliveryId: 'delivery-1', event: 'issue_comment' },
      payload: issueCommentPayload({ body: '@dev-deputies please handle this' }),
    });
    const second = await github.handle({
      headers: { deliveryId: 'delivery-2', event: 'issue_comment' },
      payload: issueCommentPayload({ body: '@dev-deputies follow up', commentId: 100 }),
    });

    expect(first.type).toBe('accepted');
    expect(second.type).toBe('accepted');
    if (first.type !== 'accepted') throw new Error('Expected accepted GitHub event');
    const messages = await services.messages.list(first.session.id);
    expect(messages[1]!.prompt).not.toContain('Already processed');
    expect(messages[1]!.prompt).toContain('New context');
    expect(messages[1]!.prompt).toContain('Event: issue_comment.created');
    expect(messages[1]!.prompt).not.toContain('https://github.com/acme/widget/issues/42#issuecomment-100');
    expect(messages[1]!.prompt).not.toContain('URL:');
    expect(messages[1]!.prompt).not.toContain('GitHub thread: acme/widget#42');
    expect(messages[1]!.prompt).not.toContain('Repository: acme/widget');
    expect(messages[1]!.prompt).not.toContain('Issue #42:');
    expect(messages[1]!.prompt).not.toContain('Actor: octocat');
    expect(messages[1]!.prompt).not.toContain('Labels: bug');
    expect(messages[1]!.prompt).not.toContain('Description:\nIt fails intermittently.');
  });

  it('adds an eyes reaction to accepted GitHub webhook subjects', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const reactions: unknown[] = [];
    const github = new GitHubWebhookService(store, services.sessions, services.messages, {
      reactionSender: {
        async addEyes(target) {
          reactions.push(target);
        },
      },
    });

    const issue = await github.handle({ headers: { deliveryId: 'delivery-1', event: 'issues' }, payload: issuePayload({}) });
    const comment = await github.handle({ headers: { deliveryId: 'delivery-2', event: 'issue_comment' }, payload: issueCommentPayload({}) });

    expect(issue.type).toBe('accepted');
    expect(comment.type).toBe('accepted');
    expect(reactions).toEqual([
      { type: 'issue', owner: 'acme', repo: 'widget', issueNumber: 42 },
      { type: 'issue_comment', owner: 'acme', repo: 'widget', commentId: 99 },
    ]);
  });

  it('ignores GitHub webhooks from users or repository owners outside allowlists', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const github = new GitHubWebhookService(store, services.sessions, services.messages, {
      allowedUsers: ['octocat'],
      allowedOrganizations: ['acme'],
    });

    const wrongUser = await github.handle({
      headers: { deliveryId: 'delivery-1', event: 'issues' },
      payload: issuePayload({ sender: 'mallory' }),
    });
    const wrongOwner = await github.handle({
      headers: { deliveryId: 'delivery-2', event: 'issues' },
      payload: issuePayload({ owner: 'other-org' }),
    });

    expect(wrongUser).toEqual({ ok: true, type: 'ignored', reason: 'unauthorized_user' });
    expect(wrongOwner).toEqual({ ok: true, type: 'ignored', reason: 'unauthorized_repository_owner' });
    expect(await store.listSessions()).toHaveLength(0);
  });

  it('dedupes GitHub webhook deliveries', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const github = new GitHubWebhookService(store, services.sessions, services.messages);

    const first = await github.handle({ headers: { deliveryId: 'delivery-1', event: 'issues' }, payload: issuePayload({}) });
    const duplicate = await github.handle({ headers: { deliveryId: 'delivery-1', event: 'issues' }, payload: issuePayload({}) });

    expect(first.type).toBe('accepted');
    expect(duplicate).toEqual({ ok: true, type: 'duplicate' });
  });

  it('requires configured trigger handles in GitHub event text', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const github = new GitHubWebhookService(store, services.sessions, services.messages, {
      triggerHandles: ['dev-deputies'],
    });

    const missingTag = await github.handle({
      headers: { deliveryId: 'delivery-1', event: 'issue_comment' },
      payload: issueCommentPayload({ body: 'Please handle this.' }),
    });
    const tagged = await github.handle({
      headers: { deliveryId: 'delivery-2', event: 'issue_comment' },
      payload: issueCommentPayload({ body: '@dev-deputies please handle this.' }),
    });

    expect(missingTag).toEqual({ ok: true, type: 'ignored', reason: 'missing_trigger_handle' });
    expect(tagged.type).toBe('accepted');
    expect(await store.listSessions()).toHaveLength(1);
  });

  it('accepts PR review comments and submitted PR reviews', async () => {
    const store = new MemoryStore();
    const services = createServices(store);
    const github = new GitHubWebhookService(store, services.sessions, services.messages, {
      allowedUsers: ['octocat'],
      allowedOrganizations: ['acme'],
    });

    const reviewComment = await github.handle({
      headers: { deliveryId: 'delivery-1', event: 'pull_request_review_comment' },
      payload: pullRequestReviewCommentPayload(),
    });
    const review = await github.handle({
      headers: { deliveryId: 'delivery-2', event: 'pull_request_review' },
      payload: pullRequestReviewPayload(),
    });

    expect(reviewComment.type).toBe('accepted');
    expect(review.type).toBe('accepted');
    if (reviewComment.type !== 'accepted' || review.type !== 'accepted') throw new Error('Expected accepted GitHub events');
    expect(reviewComment.session.id).toBe(review.session.id);

    const messages = await services.messages.list(reviewComment.session.id);
    expect(messages).toHaveLength(2);
    expect(messages[0]!.prompt).toContain('Event: pull_request_review_comment.created');
    expect(messages[0]!.prompt).toContain('File: src/app.ts');
    expect(messages[0]!.prompt).toContain('Diff context:');
    expect(messages[1]!.prompt).toContain('Event: pull_request_review.submitted');
    expect(messages[1]!.prompt).toContain('Review state: commented');
    expect(messages[1]!.prompt).toContain('Please update this before merge.');
  });

  it('accepts signed GitHub webhook requests without API auth', async () => {
    const store = new MemoryStore();
    const app = createApp(loadConfig({
      API_AUTH_MODE: 'bearer',
      API_BEARER_TOKEN: 'secret',
      GITHUB_WEBHOOK_SECRET: secret,
      GITHUB_ALLOWED_USERS: 'octocat',
      GITHUB_ALLOWED_ORGANIZATIONS: 'acme',
      GITHUB_TRIGGER_HANDLES: 'dev-deputies',
    }), createServices(store));
    const body = JSON.stringify(issuePayload({ title: '@dev-deputies fix the flaky test' }));

    const response = await app.request('/webhooks/github/events', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': 'delivery-1',
        'x-github-event': 'issues',
        'x-hub-signature-256': createGitHubWebhookSignature({ body, secret }),
      },
      body,
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ ok: true, type: 'accepted' });
    expect(await store.listSessions()).toHaveLength(1);
  });

  it('does not post acknowledgement-only GitHub completion comments', async () => {
    const comments: unknown[] = [];
    const sender = new GitHubCompletionCallbackSender({
      async createIssueComment(input) {
        comments.push(input);
        return { id: 1 };
      },
    }, {
      async getRepositoryAccess() {
        return { auth: { token: 'ghs_token' } };
      },
    });

    await sender.deliver({ type: 'github', target: { owner: 'acme', repo: 'widget', issueNumber: 42 } }, {
      event: 'message_completed',
      sessionId: 'session-1',
      runId: 'run-1',
      messageId: 'message-1',
      text: 'Webhook event processed: issue_comment.created. New comment from sidpalas has been acknowledged.',
      artifacts: [],
    });

    expect(comments).toEqual([]);
  });

  it('posts meaningful GitHub completion comments only', async () => {
    const comments: unknown[] = [];
    const sender = new GitHubCompletionCallbackSender({
      async createIssueComment(input) {
        comments.push(input);
        return { id: 1 };
      },
    }, {
      async getRepositoryAccess() {
        return { auth: { token: 'ghs_token' } };
      },
    });
    const callback = { type: 'github' as const, target: { owner: 'acme', repo: 'widget', issueNumber: 42 } };

    await sender.deliver(callback, completionPayload('Received and acknowledged.'));
    await sender.deliver(callback, completionPayload('The webhook event has been received and processed.'));
    await sender.deliver(callback, completionPayload('I found the failing path and opened PR #12 with a fix.'));

    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ body: 'I found the failing path and opened PR #12 with a fix.' });
  });
});

function completionPayload(text: string) {
  return {
    event: 'message_completed' as const,
    sessionId: 'session-1',
    runId: 'run-1',
    messageId: 'message-1',
    text,
    artifacts: [],
  };
}

function issuePayload(input: { action?: string; owner?: string; repo?: string; sender?: string; title?: string; body?: string } = {}) {
  return {
    action: input.action ?? 'opened',
    repository: { owner: { login: input.owner ?? 'acme' }, name: input.repo ?? 'widget', full_name: `${input.owner ?? 'acme'}/${input.repo ?? 'widget'}` },
    sender: { login: input.sender ?? 'octocat', type: 'User' },
    issue: {
      number: 42,
      title: input.title ?? 'Fix the flaky test',
      body: input.body ?? 'It fails intermittently.',
      html_url: 'https://github.com/acme/widget/issues/42',
      user: { login: 'octocat' },
      labels: [{ name: 'bug' }],
    },
  };
}

function issueCommentPayload(input: { body?: string; commentId?: number } = {}) {
  return {
    action: 'created',
    repository: { owner: { login: 'acme' }, name: 'widget', full_name: 'acme/widget' },
    sender: { login: 'octocat', type: 'User' },
    issue: {
      number: 42,
      title: 'Fix the flaky test',
      body: 'It fails intermittently.',
      html_url: 'https://github.com/acme/widget/issues/42',
      user: { login: 'octocat' },
      labels: [{ name: 'bug' }],
    },
    comment: {
      id: input.commentId ?? 99,
      body: input.body ?? 'Please handle this.',
      html_url: `https://github.com/acme/widget/issues/42#issuecomment-${input.commentId ?? 99}`,
      user: { login: 'octocat' },
    },
  };
}

function pullRequestReviewCommentPayload() {
  return {
    action: 'created',
    repository: { owner: { login: 'acme' }, name: 'widget', full_name: 'acme/widget' },
    sender: { login: 'octocat', type: 'User' },
    pull_request: {
      number: 42,
      title: 'Improve app startup',
      body: 'The startup path needs cleanup.',
      html_url: 'https://github.com/acme/widget/pull/42',
      user: { login: 'octocat' },
      labels: [{ name: 'bug' }],
    },
    comment: {
      id: 100,
      body: '@dev-deputies please fix this edge case.',
      html_url: 'https://github.com/acme/widget/pull/42#discussion_r100',
      user: { login: 'octocat' },
      path: 'src/app.ts',
      diff_hunk: '@@ -1,2 +1,2 @@',
    },
  };
}

function pullRequestReviewPayload() {
  return {
    action: 'submitted',
    repository: { owner: { login: 'acme' }, name: 'widget', full_name: 'acme/widget' },
    sender: { login: 'octocat', type: 'User' },
    pull_request: {
      number: 42,
      title: 'Improve app startup',
      body: 'The startup path needs cleanup.',
      html_url: 'https://github.com/acme/widget/pull/42',
      user: { login: 'octocat' },
      labels: [{ name: 'bug' }],
    },
    review: {
      id: 101,
      body: '@dev-deputies Please update this before merge.',
      state: 'commented',
      user: { login: 'octocat' },
    },
  };
}
