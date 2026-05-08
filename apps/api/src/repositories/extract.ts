export type RepositoryReference = {
  provider: 'github';
  owner: string;
  repo: string;
};

const explicitRepositoryPattern = /(?:^|\s)repo[:\s]+([^\s]+)/i;
const githubUrlPattern = /https?:\/\/(?:www\.)?github\.com\/([^\s/?#]+)\/([^\s/?#]+)(?:[/?#][^\s]*)?/i;

export function extractRepositoryReference(text: string): RepositoryReference | null {
  const explicit = extractExplicitRepository(text);
  if (explicit) return explicit;
  const url = extractGitHubUrlRepository(text);
  if (url) return url;
  return parseBareOwnerRepo(text);
}

function extractExplicitRepository(text: string): RepositoryReference | null {
  const match = explicitRepositoryPattern.exec(text);
  const raw = match?.[1];
  if (!raw) return null;

  return parseOwnerRepo(raw);
}

function extractGitHubUrlRepository(text: string): RepositoryReference | null {
  const match = githubUrlPattern.exec(text);
  const owner = match?.[1];
  const repo = match?.[2];
  if (!owner || !repo) return null;

  return parseOwnerRepo(`${owner}/${repo}`);
}

function parseBareOwnerRepo(text: string): RepositoryReference | null {
  if (/\s/.test(text.trim())) return null;
  return parseOwnerRepo(text);
}

function parseOwnerRepo(value: string): RepositoryReference | null {
  const normalized = value.trim().replace(/\/+$/, '').replace(/\.git$/i, '');
  const parts = normalized.split('/');
  if (parts.length !== 2) return null;

  const [owner, repo] = parts;
  if (!owner || !repo || !isValidGitHubOwner(owner) || !isValidGitHubRepo(repo)) return null;
  return { provider: 'github', owner, repo };
}

function isValidGitHubOwner(value: string): boolean {
  return /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(value);
}

function isValidGitHubRepo(value: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(value) && value !== '.' && value !== '..';
}
