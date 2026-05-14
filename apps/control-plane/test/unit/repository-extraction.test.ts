import { extractRepositoryReference, parseStructuredGitHubRepository } from '../../src/repositories/extract.js';

describe('extractRepositoryReference', () => {
  it('extracts explicit repo syntax with a colon', () => {
    expect(extractRepositoryReference('please use repo:manaflow-ai/manaflow')).toEqual({
      provider: 'github',
      owner: 'manaflow-ai',
      repo: 'manaflow',
    });
  });

  it('extracts explicit repo syntax with a space', () => {
    expect(extractRepositoryReference('please use repo manaflow-ai/manaflow')).toEqual({
      provider: 'github',
      owner: 'manaflow-ai',
      repo: 'manaflow',
    });
  });

  it('extracts GitHub URLs', () => {
    expect(extractRepositoryReference('look at https://github.com/manaflow-ai/manaflow/issues/123')).toEqual({
      provider: 'github',
      owner: 'manaflow-ai',
      repo: 'manaflow',
    });
  });

  it('extracts bare owner/repo input', () => {
    expect(extractRepositoryReference('manaflow-ai/manaflow')).toEqual({
      provider: 'github',
      owner: 'manaflow-ai',
      repo: 'manaflow',
    });
  });

  it('strips trailing slashes and git suffixes', () => {
    expect(extractRepositoryReference('clone repo:manaflow-ai/manaflow.git/')).toEqual({
      provider: 'github',
      owner: 'manaflow-ai',
      repo: 'manaflow',
    });
  });

  it('prefers explicit repo syntax over GitHub URLs', () => {
    expect(extractRepositoryReference('see https://github.com/wrong/repo but use repo:manaflow-ai/manaflow')).toEqual({
      provider: 'github',
      owner: 'manaflow-ai',
      repo: 'manaflow',
    });
  });

  it('does not infer a default owner for repo-name-only syntax', () => {
    expect(extractRepositoryReference('please use repo:manaflow')).toBeNull();
  });

  it('rejects ambiguous explicit paths', () => {
    expect(extractRepositoryReference('please use repo:manaflow-ai/manaflow/extra')).toBeNull();
  });

  it('rejects invalid owner and repo values', () => {
    expect(extractRepositoryReference('please use repo:-bad/manaflow')).toBeNull();
    expect(extractRepositoryReference('please use repo:manaflow-ai/../')).toBeNull();
  });

  it('returns null when no repository appears in text', () => {
    expect(extractRepositoryReference('please fix the flaky test')).toBeNull();
  });
});

describe('parseStructuredGitHubRepository', () => {
  it.each([
    ['simple names', 'acme', 'widget'],
    ['single-character names', 'a', 'b'],
    ['owner hyphens and repo punctuation', 'acme-inc', 'widget.api_name-1'],
    ['maximum-length owner', 'a'.repeat(39), '.github'],
  ])('accepts valid GitHub repository %s', (_label, owner, repo) => {
    expect(parseStructuredGitHubRepository(owner, repo)).toEqual({ provider: 'github', owner, repo });
  });

  it.each([
    ['owner with trailing slash', 'acme/', 'widget'],
    ['repo with trailing slash', 'acme', 'widget/'],
    ['repo with git suffix', 'acme', 'widget.git'],
    ['owner with whitespace', ' acme', 'widget'],
    ['repo with whitespace', 'acme', 'widget '],
    ['invalid owner punctuation', 'acme_inc', 'widget'],
    ['invalid owner edge hyphen', '-acme', 'widget'],
    ['invalid repo path traversal', 'acme', '..'],
    ['invalid repo path separator', 'acme', 'widget/extra'],
  ])('rejects structured GitHub repository %s', (_label, owner, repo) => {
    expect(parseStructuredGitHubRepository(owner, repo)).toBeNull();
  });
});
