import type { GitHubClient } from './client.js';
import type { GitHubRepository } from './types.js';

export type GitHubReactionTarget =
  | { type: 'issue'; owner: string; repo: string; issueNumber: number }
  | { type: 'issue_comment'; owner: string; repo: string; commentId: number }
  | { type: 'pull_request_review_comment'; owner: string; repo: string; commentId: number }
  | { type: 'pull_request_review'; owner: string; repo: string; pullNumber: number; reviewId: number };

export type GitHubReactionAccessProvider = {
  getRepositoryAccess(repository: GitHubRepository): Promise<{ auth: { token: string } }>;
};

export class GitHubReactionSender {
  constructor(
    private readonly client: Pick<GitHubClient, 'createReaction'>,
    private readonly access: GitHubReactionAccessProvider,
  ) {}

  async addEyes(target: GitHubReactionTarget): Promise<void> {
    const repositoryAccess = await this.access.getRepositoryAccess({ owner: target.owner, repo: target.repo });
    await this.client.createReaction({
      owner: target.owner,
      repo: target.repo,
      path: reactionPath(target),
      token: repositoryAccess.auth.token,
      content: 'eyes',
    });
  }
}

function reactionPath(target: GitHubReactionTarget): string {
  switch (target.type) {
    case 'issue':
      return `issues/${target.issueNumber}`;
    case 'issue_comment':
      return `issues/comments/${target.commentId}`;
    case 'pull_request_review_comment':
      return `pulls/comments/${target.commentId}`;
    case 'pull_request_review':
      return `pulls/${target.pullNumber}/reviews/${target.reviewId}`;
  }
}
