const untrustedTagName = 'github_untrusted_content';
const reservedTagPattern = /<\/?github_untrusted_content\b/gi;

export type GitHubPromptSection = {
  label: string;
  source: string;
  content: string;
};

export type GitHubPromptInput = {
  repository: string;
  subject: string;
  instruction: string;
  sections: GitHubPromptSection[];
};

export function buildGitHubPrompt(input: GitHubPromptInput): string {
  const lines = [
    `GitHub repository: ${input.repository}`,
    `Subject: ${input.subject}`,
    '',
    input.instruction,
  ];

  for (const section of input.sections) {
    if (!section.content.trim()) continue;
    lines.push('', `### ${section.label}`, wrapGitHubUntrustedContent(section.source, section.content));
  }

  return lines.join('\n');
}

export function wrapGitHubUntrustedContent(source: string, content: string): string {
  return `<${untrustedTagName} source="${escapeTagAttribute(source)}">\n${sanitizeGitHubUntrustedContent(content)}\n</${untrustedTagName}>`;
}

export function renderGitHubWebhookContext(content: string): string {
  return ['GitHub webhook context:', '---', sanitizeGitHubUntrustedContent(content), '---'].join('\n');
}

export function sanitizeGitHubUntrustedContent(content: string): string {
  return content.replace(reservedTagPattern, (match) => `&lt;${match.slice(1)}`);
}

function escapeTagAttribute(value: string): string {
  return value.replace(/[&"<>]/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '"':
        return '&quot;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      default:
        return character;
    }
  });
}
