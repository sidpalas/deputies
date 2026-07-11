import { describe, expect, it } from 'vitest';
import type { ArtifactToolServices } from '../../src/artifacts/tool.js';
import { createPiArtifactToolDefinition } from '../../src/runner-pi/artifact-tool.js';

describe('Pi artifact tool prompt guidance', () => {
  it('keeps the complete browser capture recipe within the prompt budget', () => {
    const tool = createPiArtifactToolDefinition({} as ArtifactToolServices);
    const guidelines = tool.promptGuidelines ?? [];
    const prompt = guidelines.join('\n');

    expect(guidelines.length).toBeLessThanOrEqual(5);
    expect(prompt).toContain('command -v deputies-record');
    expect(prompt).toContain('test -d "$PLAYWRIGHT_BROWSERS_PATH"');
    expect(prompt).toContain('use read on each PNG');
    expect(prompt).toContain('document.fonts.ready');
    expect(prompt).toContain('fallback-font captures as inaccurate');
    expect(prompt).toContain('returns font warnings');
    expect(prompt).toContain('disclose them to the user');
    expect(prompt).toContain('desktop, laptop, tablet, or mobile');
    expect(prompt).toContain('at most 60 seconds');
    expect(prompt).toContain('-pix_fmt yuv420p');
    expect(prompt).toContain('WebM is accepted');
    expect(prompt).toContain('browserless sandboxes');
  });
});
