import type { GitHubClient } from './client.js';
import type { GitHubRepository } from './types.js';
import { archivedSessionNotice, archivedSessionRecoveredNotice } from '../archive.js';

export type GitHubArchivedSessionAccessProvider = {
  getRepositoryAccess(repository: GitHubRepository): Promise<{ auth: { token: string } }>;
};

export class GitHubArchivedSessionNotifier {
  constructor(
    private readonly client: Pick<GitHubClient, 'createIssueComment'>,
    private readonly access: GitHubArchivedSessionAccessProvider,
  ) {}

  async postNotice(input: { owner: string; repo: string; issueNumber: number }): Promise<void> {
    await this.postIssueComment(input, archivedSessionNotice());
  }

  async postRecoveryAcknowledgement(input: { owner: string; repo: string; issueNumber: number }): Promise<void> {
    await this.postIssueComment(input, archivedSessionRecoveredNotice());
  }

  private async postIssueComment(input: { owner: string; repo: string; issueNumber: number }, body: string): Promise<void> {
    const repositoryAccess = await this.access.getRepositoryAccess({ owner: input.owner, repo: input.repo });
    await this.client.createIssueComment({
      owner: input.owner,
      repo: input.repo,
      issueNumber: input.issueNumber,
      token: repositoryAccess.auth.token,
      body,
    });
  }
}
