import type { Context, Hono } from 'hono';
import type { AppConfig } from '../config/index.js';
import { GitHubApiError } from '../integrations/github/client.js';
import { GitHubRepositoryAccessError } from '../integrations/github/repository-access.js';
import { writeError } from './http-error.js';
import type { AppServices, AppVariables } from './server.js';

export function registerRepositoryRoutes(
  app: Hono<{ Variables: AppVariables }>,
  config: AppConfig,
  services: AppServices,
): void {
  app.get('/repositories', async (c) => {
    let repositories = configuredRepositoryOptions(config);
    if (services.githubRepositoryAccess) {
      try {
        const installedRepositories = await services.githubRepositoryAccess.listRepositories();
        if (installedRepositories.length) {
          repositories = installedRepositories.map((repository) => ({
            fullName: repository.fullName,
            owner: repository.owner,
            name: repository.repo,
            description: repository.description,
            private: repository.private,
            defaultBranch: repository.defaultBranch,
          }));
        }
      } catch {
        // Keep the picker useful when GitHub installation listing is temporarily unavailable.
      }
    }
    return c.json({ repositories });
  });

  app.get('/repositories/:owner/:repo/branches', async (c) => {
    if (!services.githubRepositoryAccess) return c.json({ branches: [] });
    try {
      const branches = await services.githubRepositoryAccess.listBranches({
        owner: c.req.param('owner'),
        repo: c.req.param('repo'),
      });
      return c.json({ branches });
    } catch (error) {
      return writeGitHubRepositoryError(c, error);
    }
  });
}

function configuredRepositoryOptions(config: AppConfig) {
  return config.githubAllowedRepositories
    .filter((repository) => repository.includes('/') && !repository.includes('*'))
    .map((fullName) => {
      const [owner, name] = fullName.split('/');
      return { fullName, owner, name };
    });
}

function writeGitHubRepositoryError(c: Context, error: unknown) {
  if (error instanceof GitHubRepositoryAccessError) {
    return writeError(c, 403, error.code, error.message);
  }
  if (error instanceof GitHubApiError) {
    if (error.statusCode === 401 || error.statusCode === 403) {
      return writeError(c, 403, 'github_authorization_failed', 'GitHub authorization failed for this repository');
    }
    if (error.statusCode === 404) {
      return writeError(c, 404, 'github_repository_not_found', 'GitHub repository or installation was not found');
    }
    return writeError(c, 502, 'github_api_error', 'GitHub API request failed');
  }
  throw error;
}
