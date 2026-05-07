import { createGitHubAppJwt } from './auth.js';
import type { GitHubClient } from './client.js';
import type { GitHubInstallationToken, GitHubRepository, GitHubRepositoryAccess } from './types.js';

export type GitHubRepositoryAccessServiceOptions = {
  appId: string;
  privateKey: string;
  client: GitHubClient;
  cloneBaseUrl?: string;
  allowedRepositories?: string[];
  now?: () => Date;
};

export class GitHubRepositoryAccessService {
  private readonly allowedRepositories: string[];
  private readonly cloneBaseUrl: string;
  private readonly now: () => Date;
  private readonly tokensByInstallation = new Map<number, GitHubInstallationToken>();
  private readonly installationsByRepository = new Map<string, number>();

  constructor(private readonly options: GitHubRepositoryAccessServiceOptions) {
    this.allowedRepositories = options.allowedRepositories ?? [];
    this.cloneBaseUrl = (options.cloneBaseUrl ?? 'https://github.com').replace(/\/+$/, '');
    this.now = options.now ?? (() => new Date());
  }

  async getRepositoryAccess(repository: GitHubRepository): Promise<GitHubRepositoryAccess> {
    this.assertAllowed(repository);
    const installationId = await this.getInstallationId(repository);
    const token = await this.getInstallationToken(installationId);
    return {
      provider: 'github',
      owner: repository.owner,
      repo: repository.repo,
      cloneUrl: `${this.cloneBaseUrl}/${repository.owner}/${repository.repo}.git`,
      expiresAt: token.expiresAt,
      auth: { type: 'bearer', token: token.token },
    };
  }

  listAllowedRepositories(): string[] {
    return [...this.allowedRepositories];
  }

  private async getInstallationId(repository: GitHubRepository): Promise<number> {
    const key = repositoryKey(repository);
    const cached = this.installationsByRepository.get(key);
    if (cached) return cached;
    const installation = await this.options.client.getRepositoryInstallation({
      ...repository,
      appJwt: this.createAppJwt(),
    });
    this.installationsByRepository.set(key, installation.id);
    return installation.id;
  }

  private async getInstallationToken(installationId: number): Promise<GitHubInstallationToken> {
    const cached = this.tokensByInstallation.get(installationId);
    if (cached && cached.expiresAt.getTime() - this.now().getTime() > 60_000) return cached;
    const token = await this.options.client.createInstallationAccessToken({ installationId, appJwt: this.createAppJwt() });
    const record = { ...token, installationId };
    this.tokensByInstallation.set(installationId, record);
    return record;
  }

  private createAppJwt(): string {
    return createGitHubAppJwt({ appId: this.options.appId, privateKey: this.options.privateKey, now: this.now() });
  }

  private assertAllowed(repository: GitHubRepository): void {
    if (!this.allowedRepositories.length) return;
    const key = repositoryKey(repository).toLowerCase();
    const allowed = this.allowedRepositories.some((pattern) => repositoryPatternMatches(pattern, key));
    if (!allowed) throw new GitHubRepositoryAccessError('unauthorized_repository', `GitHub repository is not allowed: ${repository.owner}/${repository.repo}`);
  }
}

export class GitHubRepositoryAccessError extends Error {
  constructor(
    readonly code: 'unauthorized_repository',
    message: string,
  ) {
    super(message);
  }
}

function repositoryKey(repository: GitHubRepository): string {
  return `${repository.owner}/${repository.repo}`;
}

function repositoryPatternMatches(pattern: string, repositoryKey: string): boolean {
  const normalized = pattern.toLowerCase();
  if (normalized === repositoryKey) return true;
  if (!normalized.endsWith('/*')) return false;
  return repositoryKey.startsWith(normalized.slice(0, -1));
}
