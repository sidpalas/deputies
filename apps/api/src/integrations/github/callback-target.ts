export type GitHubCallbackTargetInput = {
  owner: string;
  repo: string;
  issueNumber: number;
  replyHint?: string;
  sessionUrl?: string;
  includeSessionLink?: boolean;
};

export function githubCallbackTarget(input: GitHubCallbackTargetInput): Record<string, unknown> {
  return {
    type: 'github',
    owner: input.owner,
    repo: input.repo,
    issueNumber: input.issueNumber,
    ...(input.replyHint ? { replyHint: input.replyHint } : {}),
    ...(input.sessionUrl ? { sessionUrl: input.sessionUrl } : {}),
    ...(input.includeSessionLink ? { includeSessionLink: true } : {}),
  };
}
