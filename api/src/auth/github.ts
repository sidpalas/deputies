export type GitHubOAuthUser = {
  id: number;
  login: string;
  name?: string | null;
  avatar_url?: string | null;
};

export type GitHubOAuthClient = {
  exchangeCode(input: { code: string; redirectUri: string }): Promise<string>;
  getUser(accessToken: string): Promise<GitHubOAuthUser>;
  listOrganizations(accessToken: string): Promise<string[]>;
};

export class FetchGitHubOAuthClient implements GitHubOAuthClient {
  constructor(
    private readonly options: {
      clientId: string;
      clientSecret: string;
      oauthBaseUrl: string;
      apiBaseUrl: string;
      fetch?: typeof fetch;
    },
  ) {}

  async exchangeCode(input: { code: string; redirectUri: string }): Promise<string> {
    const response = await this.fetch(`${this.options.oauthBaseUrl.replace(/\/$/, '')}/login/oauth/access_token`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
        code: input.code,
        redirect_uri: input.redirectUri,
      }),
    });
    const body = (await response.json()) as { access_token?: string; error?: string; error_description?: string };
    if (!response.ok || !body.access_token) {
      throw new Error(body.error_description ?? body.error ?? 'GitHub OAuth token exchange failed');
    }
    return body.access_token;
  }

  async getUser(accessToken: string): Promise<GitHubOAuthUser> {
    const response = await this.fetch(`${this.options.apiBaseUrl.replace(/\/$/, '')}/user`, {
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) throw new Error('GitHub user lookup failed');
    return (await response.json()) as GitHubOAuthUser;
  }

  async listOrganizations(accessToken: string): Promise<string[]> {
    const response = await this.fetch(`${this.options.apiBaseUrl.replace(/\/$/, '')}/user/orgs`, {
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) throw new Error('GitHub organization lookup failed');
    const organizations = (await response.json()) as Array<{ login?: string }>;
    return organizations.map((org) => org.login).filter((login): login is string => Boolean(login));
  }

  private fetch(input: string | URL, init?: RequestInit): Promise<Response> {
    return (this.options.fetch ?? fetch)(input, init);
  }
}
