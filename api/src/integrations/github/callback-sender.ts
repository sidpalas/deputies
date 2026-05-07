import type { CompletionCallback, CompletionCallbackPayload, CompletionCallbackSender } from '../../callbacks/service.js';
import type { GitHubClient } from './client.js';
import type { GitHubRepository } from './types.js';

export type GitHubCallbackAccessProvider = {
  getRepositoryAccess(repository: GitHubRepository): Promise<{ auth: { token: string } }>;
};

export class GitHubCompletionCallbackSender implements CompletionCallbackSender {
  readonly type = 'github';

  constructor(
    private readonly client: Pick<GitHubClient, 'createIssueComment'>,
    private readonly access: GitHubCallbackAccessProvider,
  ) {}

  async deliver(callback: CompletionCallback, payload: CompletionCallbackPayload): Promise<void> {
    const owner = stringTarget(callback.target.owner);
    const repo = stringTarget(callback.target.repo);
    const issueNumber = numberTarget(callback.target.issueNumber);
    if (!owner || !repo || !issueNumber) throw new Error('GitHub callback target is missing owner, repo, or issueNumber');

    const repositoryAccess = await this.access.getRepositoryAccess({ owner, repo });
    const body = payload.text.trim();
    if (!body || isAcknowledgementOnly(body)) return;
    await this.client.createIssueComment({ owner, repo, issueNumber, token: repositoryAccess.auth.token, body });
  }
}

function isAcknowledgementOnly(body: string): boolean {
  const normalized = body.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!normalized) return true;
  if (normalized.includes('webhook event processed') && normalized.includes('acknowledged')) return true;
  if (normalized.includes('webhook event') && normalized.includes('received and processed')) return true;
  if (normalized.includes('the webhook event has been received and processed')) return true;
  if (normalized.includes('webhook received') && normalized.includes('acknowledged')) return true;
  if (normalized.includes('new comment') && normalized.includes('acknowledged')) return true;
  return acknowledgementSentences.has(normalized.replace(/[.!]+$/, ''));
}

const acknowledgementSentences = new Set([
  'acknowledged',
  'received',
  'received and acknowledged',
  'i have acknowledged this',
  'i have received this',
  'the comment has been acknowledged',
  'this comment has been acknowledged',
  'the webhook has been acknowledged',
  'this webhook has been acknowledged',
]);

function stringTarget(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function numberTarget(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}
