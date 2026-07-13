# Optional Artifact Object Storage

## Status

Implemented for the current product path.

## Problem

Runs already produce durable artifact metadata, but large or binary outputs do not fit well in Postgres or event payloads. Screenshots, generated images, diagnostic bundles, large logs, and reports need durable storage that can be displayed in the web UI, downloaded by users, and referenced from integrations without bloating the primary database.

The system also needs to remain easy to run locally. Local development should not require a cloud bucket, and production deployments should not be locked to one object storage vendor.

## Goals

- Add optional object storage for artifact blobs while keeping Postgres as the source of truth for artifact metadata.
- Support user-facing artifact previews and downloads from the session UI.
- Keep local development simple through a `docker-compose` service or an explicitly configured filesystem fallback.
- Prefer an S3-compatible storage contract so deployments can use AWS S3, Cloudflare R2, Tigris, Garage, SeaweedFS, MinIO, or compatible platform storage.
- Make object storage disabled by default unless the deployment opts in.

## Non-Goals

- Building a general file manager or arbitrary user upload system.
- Replacing Postgres artifact rows, events, callbacks, or session history with object storage.
- Guaranteeing permanent public URLs for artifacts.
- Full-text search inside logs, archives, or exported sessions.
- Cross-region replication, lifecycle policies, malware scanning, or DLP in the first version.
- Downloadable session export bundles.

## Users / Use Cases

- Operators reviewing a run need to view screenshots, reports, and large logs from the session detail page.
- Users need to download a generated file or diagnostic bundle after a run completes.
- Integrations need stable artifact references to include in completion callbacks, Slack replies, or GitHub comments.
- Developers need to test artifact upload, preview, and download flows locally without creating a cloud bucket.
- Self-hosters need to bring their own object storage and avoid vendor-specific APIs.

## Requirements

- Artifact metadata remains stored in Postgres using the existing `artifacts` table, with `storage_key`, `url`, `type`, `title`, and `payload` identifying how to retrieve and display the artifact.
- Blob storage is optional. If object storage is not configured, existing external-link artifacts continue to work and blob-producing features should fail clearly or use an explicitly configured local fallback.
- The storage adapter exposes provider-neutral `put`, `get`, optional byte-range `getRange`, and optional `delete` operations. Downloads and previews currently proxy through the authenticated product API rather than exposing signed bucket URLs.
- Artifact reads through the product API remain protected by the same session auth as `GET /sessions/:sessionId/artifacts`.
- The browser should not need direct permanent bucket credentials.
- Artifacts should include content metadata when available: file name, content type, byte size, checksum, previewability, and retention hint.
- Image artifacts should be previewable in the session UI when the content type is browser-safe.
- Large text/log artifacts should be downloadable and previewable through a capped API preview.
- Local development should provide one documented path for object storage via `docker-compose` and one no-service filesystem fallback.

## Local Development Storage Options

- Recommended default: SeaweedFS S3 API in `docker-compose` for local development. It is lightweight, S3-compatible enough for artifact flows, Apache-2.0 licensed, and avoids MinIO's current licensing concerns.
- Secondary option: Garage for teams that want a production-capable self-hosted S3-compatible store. It is active and simple to operate, but its AGPL license may have the same adoption concerns as MinIO for some users.
- Test-only option: LocalStack S3 or Adobe S3Mock for automated tests that need S3 behavior but not production-like storage. These are useful for CI, but should not be documented as production storage.
- Compatibility option: MinIO remains useful because it is the most common S3-compatible local target, but it should not be the only documented path given licensing, project direction, and patching concerns.
- Fallback option: local filesystem storage behind the same artifact adapter. This is the simplest single-process development path, but it should be documented as non-production unless paired with shared persistent volumes and single-replica assumptions.

## Product Behavior

- Session artifacts list shows artifact title, type, creation time, source run/message, size when known, and an action to view or download.
- Image-like artifacts are shown inline for browser-safe stored images up to the UI autoload limit; large images expose an open/download link instead.
- File, report, archive, and log artifacts expose authenticated download links.
- Text-like artifacts expose lazy-loaded inline previews through `GET /sessions/:sessionId/artifacts/:artifactId/preview`; previews are capped server-side and report whether they were truncated.
- External-link artifacts keep their current behavior and are visually distinguished from internally stored blobs.
- If a stored artifact is unavailable, the UI shows a clear unavailable state rather than a broken link.
- Completion callbacks may include artifact metadata and API URLs, but should avoid long-lived public signed URLs unless explicitly configured.

## Implemented Shape

- `ARTIFACT_STORAGE_PROVIDER=disabled|filesystem|s3`, default `disabled`.
- Filesystem storage requires `ARTIFACT_STORAGE_FILESYSTEM_PATH` and is intended for local/single-process use.
- S3-compatible storage requires `ARTIFACT_STORAGE_S3_BUCKET`, `ARTIFACT_STORAGE_S3_ACCESS_KEY_ID`, and `ARTIFACT_STORAGE_S3_SECRET_ACCESS_KEY`; `ARTIFACT_STORAGE_S3_ENDPOINT`, `ARTIFACT_STORAGE_S3_REGION`, `ARTIFACT_STORAGE_S3_FORCE_PATH_STYLE`, and `ARTIFACT_STORAGE_S3_CREATE_BUCKET` configure compatible local or hosted stores.
- Local Compose runs SeaweedFS S3 and configures both combined and split stacks to use it.
- Pi runs receive an `artifact` tool. The current `create` action publishes a file from the sandbox as a durable artifact; supported types are `file`, `log`, `screenshot`, `report`, and `image`.
- The artifact tool enforces `ARTIFACT_CREATE_MAX_BYTES`, default 25 MiB, before reading the sandbox file.
- Stored artifact metadata includes `storage: "internal"`, `sizeBytes`, `checksumSha256`, optional `contentType`, optional `fileName`, and `sourcePath` for tool-created artifacts.
- Stored artifact objects are keyed as `artifacts/:sessionCreatedAtTimestamp/sessions/:sessionId/runs/:runId/:artifactCreatedAtTimestamp-:artifactId[-fileName]`, where timestamps are compact UTC values such as `20260514T024500123Z`.
- Product API routes are `GET /sessions/:sessionId/artifacts`, `GET /sessions/:sessionId/artifacts/:artifactId/download`, and `GET /sessions/:sessionId/artifacts/:artifactId/preview`.

## Future Work

- Add archive-aware artifact retention cleanup. Archiving a session should not immediately delete artifact blobs, but a later cleanup job can delete stored blobs after a configurable retention window, preserve artifact metadata, mark expired artifacts as unavailable, and have download/preview routes return a stable expired response.
- Signed URL redirects are not implemented yet; API proxying is the current access path.
- Image previews currently use authenticated download URLs; dedicated image thumbnail generation is future work.

## Acceptance Criteria

- With object storage disabled, existing artifact listing and external-link artifacts continue to work.
- With local object storage enabled, a run can create a blob artifact through `artifact({ action: "create" })`, store it outside Postgres, list it through the session artifacts API, preview supported text artifacts, and download it through an authenticated API flow.
- Local development documentation includes a working `docker-compose` SeaweedFS object storage service and required environment variables.
- No permanent object storage credentials are exposed to the browser, event payloads, callbacks, or logs.
- Artifact metadata in Postgres is sufficient to render artifact lists even if object storage is temporarily unavailable.
- The session UI can preview at least browser-safe image artifacts and download all stored artifact types.
- Tests cover disabled storage, successful upload/download, auth-protected reads, and missing-object behavior.

## Remaining Questions

- What retention policy should apply to artifacts by default?
- Should logs be captured continuously as artifacts during a run, or only emitted by the runner/tool at completion?
- Do callbacks need durable API download URLs, short-lived signed URLs, or only artifact IDs?

## Links

- Related issues:
- Related specs:
- Related decisions:
