# Third Party Notices

This repository includes design documentation that references external open source background-agent and Slack bot projects as prior art. Those references are for architecture comparison and implementation guidance.

As of this notice, this repository does not intentionally vendor source code, assets, or substantial copied documentation from the projects listed below. If future work copies implementation code, configuration, schemas, tests, fixtures, or substantial prose from these projects, preserve the applicable license headers and update this file with the copied material, source project, upstream commit or version when known, and any local modifications.

This file is a compliance checkpoint for contributors and coding agents. It is not legal advice.

## Referenced Prior Art

## Excluded Source-Available Material

The following source-available material must not be used as open source prior art for Deputies implementation work:

### OpenHands Enterprise

- Upstream repository: https://github.com/OpenHands/OpenHands
- License observed: PolyForm Free Trial License 1.0.0
- Copyright notice observed: `Copyright (c) 2026 All Hands AI`

Do not copy code, schemas, prompts, tests, configuration, architecture details, or implementation patterns from `enterprise/` into Deputies unless a separate commercial/legal review explicitly approves that use. OpenHands may be mentioned only as a non-open-source hosted-agent product reference in `docs/prior-art.md`.

### Junior

- Upstream repository: https://github.com/getsentry/junior
- License: Apache License 2.0
- Upstream notice file observed: none
- Current use in this repository: design comparison and summarized patterns in `docs/prior-art.md`

If copying material from Junior:

- Preserve existing copyright notices and license headers.
- Include the Apache License 2.0 text with redistributed copied material.
- Mark significant changes to copied files where appropriate.
- Preserve upstream `NOTICE` contents if a future upstream version includes a `NOTICE` file.
- Do not imply upstream endorsement.

### Open-Inspect / background-agents

- Upstream repository: https://github.com/ColeMurray/background-agents
- License: MIT License
- Copyright notice observed: `Copyright (c) 2024 Open-Inspect Contributors`
- Current use in this repository: design comparison and summarized patterns in `docs/prior-art.md`

If copying material from Open-Inspect / background-agents:

- Preserve the MIT copyright notice and permission notice.
- Include the MIT License text with redistributed copied material.
- Do not imply upstream endorsement.

### Open SWE

- Upstream repository: https://github.com/langchain-ai/open-swe
- License: MIT License
- Copyright notice observed: `Copyright (c) LangChain, Inc.`
- Current use in this repository: design comparison and summarized patterns in `docs/prior-art.md`

If copying material from Open SWE:

- Preserve the MIT copyright notice and permission notice.
- Include the MIT License text with redistributed copied material.
- Do not imply upstream endorsement.

## Contributor Guidance

- Summarizing ideas, architecture, behavior, and public APIs usually does not require copying license text, but attribution in prior-art docs is still useful.
- Copying code, test fixtures, schemas, config files, prompts, specs, or substantial documentation usually requires preserving license notices.
- Prefer clean-room reimplementation from understood behavior when practical.
- When copying is intentional, keep copied sections small, retain upstream headers, and add a note here that identifies the source and local changes.
