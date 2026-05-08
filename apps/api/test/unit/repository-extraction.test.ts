import { extractRepositoryReference } from '../../src/repositories/extract.js';

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
