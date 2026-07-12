import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import {
  artifactToolDescription,
  artifactToolParameters,
  createArtifactFromSandbox,
  type ArtifactToolServices,
} from '../artifacts/tool.js';

const piArtifactToolParameters = artifactToolParameters as unknown as ToolDefinition['parameters'];

export function createPiArtifactToolDefinition(services: ArtifactToolServices): ToolDefinition {
  const browserSession = `deputies-${services.runId}`;
  return {
    name: 'artifact',
    label: 'artifact',
    description: artifactToolDescription,
    promptSnippet: 'Publish sandbox files as durable artifacts visible in the product UI',
    promptGuidelines: [
      'Use artifact({ action: "create", ... }) for files the user should view or download, including screenshots, images, reports, logs, and videos.',
      'If you mention a created artifact in your final response, use the markdownLink returned by the artifact tool as-is, or use its downloadUrl as the markdown href. Do not wrap artifact download URLs in the session URL.',
      `After user-visible UI changes, check browser capture with command -v agent-browser and command -v deputies-record (or Playwright plus test -d "$PLAYWRIGHT_BROWSERS_PATH"). When agent-browser is available, verify before recording with --session ${browserSession} on every command: open the app, set viewport 1440 900, wait on visible UI/text/URL/readiness rather than fixed sleeps, snapshot -i -c, interact by @refs, and capture PNGs; use read on each PNG so you can see it. Use batch when exec latency matters, and agent-browser tab after links that may open a new page. Await document.fonts.ready and report failed fonts; treat fallback-font captures as inaccurate. Close the session after verification. Use agent-browser for verification and debugging, not for laboriously driving the final demo. On browserless sandboxes, skip capture without failing the run.`,
      'For multi-step flows, prefer deputies-record with the target viewport preset (desktop, laptop, tablet, or mobile) when available; otherwise record at 1440x900 for at most 60 seconds with Playwright recordVideo. If deputies-record returns font warnings, disclose them to the user and say the capture may not match production. Close the browser before transcoding, then use ffmpeg -i in.webm -c:v libx264 -pix_fmt yuv420p -movflags +faststart out.mp4 when ffmpeg exists.',
      'Prefer MP4 (H.264/yuv420p) for artifact type=video; WebM is accepted. Publish AVI, MOV, MKV, and other video formats as type=file. Give captures user-facing titles.',
    ],
    parameters: piArtifactToolParameters,
    executionMode: 'sequential',
    async execute(_toolCallId, params) {
      const result = await createArtifactFromSandbox(services, params as Record<string, unknown>);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    },
  };
}
