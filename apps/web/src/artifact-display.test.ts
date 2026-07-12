import { describe, expect, it } from 'vitest';
import type { Artifact } from './api.js';
import { isBrowserPlayableVideoArtifact } from './artifact-display.js';

function artifact(fileName: string, contentType?: string): Artifact {
  return {
    id: 'artifact-1',
    sessionId: 'session-1',
    runId: 'run-1',
    messageId: 'message-1',
    type: 'video',
    storageKey: 'artifact-1',
    payload: { fileName, ...(contentType ? { contentType } : {}) },
    createdAt: '2026-07-11T00:00:00.000Z',
  };
}

describe('isBrowserPlayableVideoArtifact', () => {
  it.each([
    ['demo.mp4', undefined],
    ['demo.m4v', undefined],
    ['demo.webm', undefined],
    ['demo.bin', 'video/webm'],
    ['demo.bin', 'video/webm; codecs=vp8'],
  ])('accepts browser-playable video %s with content type %s', (fileName, contentType) => {
    expect(isBrowserPlayableVideoArtifact(artifact(fileName, contentType))).toBe(true);
  });

  it('rejects unsupported video formats', () => {
    expect(isBrowserPlayableVideoArtifact(artifact('demo.mkv', 'video/x-matroska'))).toBe(false);
  });

  it('prefers an explicit content type over a misleading extension', () => {
    expect(isBrowserPlayableVideoArtifact(artifact('demo.webm', 'text/plain'))).toBe(false);
    expect(isBrowserPlayableVideoArtifact(artifact('demo.webm', 'video/x-matroska'))).toBe(false);
  });
});
