export type GitHubCallbackTargetInput = {
  owner: string;
  repo: string;
  issueNumber: number;
};

export function githubCallbackTarget(input: GitHubCallbackTargetInput): Record<string, unknown> {
  return { type: 'github', owner: input.owner, repo: input.repo, issueNumber: input.issueNumber };
}
