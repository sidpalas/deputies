import type { GitHubClient } from './client.js';
import type { GitHubRepository } from './types.js';

export type GitHubIssueThreadComment = {
  id: number;
  body: string;
  author?: string;
  authorType?: string;
  createdAt?: string;
  htmlUrl?: string;
};

export type GitHubIssueContextAccessProvider = {
  getRepositoryAccess(repository: GitHubRepository): Promise<{ auth: { token: string } }>;
};

export class GitHubIssueContextFetcher {
  constructor(
    private readonly client: Pick<GitHubClient, 'listIssueComments'>,
    private readonly access: GitHubIssueContextAccessProvider,
  ) {}

  async listIssueComments(input: { owner: string; repo: string; issueNumber: number }): Promise<GitHubIssueThreadComment[]> {
    const repositoryAccess = await this.access.getRepositoryAccess({ owner: input.owner, repo: input.repo });
    return this.client.listIssueComments({ ...input, token: repositoryAccess.auth.token });
  }
}
