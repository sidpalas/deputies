# Deputies WWW

This is the static root-domain site for Deputies.

It intentionally uses Astro, Caddy, and an explicit Dockerfile even though the root site is still static:

- Astro gives us a static content workflow, file-based routes, MDX blog posts, and hashed production assets.
- Caddy serves immutable `/_astro/*` and `/assets/*` files while keeping HTML revalidatable for safe CDN behavior.
- The Dockerfile makes deployment explicit and portable instead of depending on platform-specific build detection.

This keeps the `www` service aligned with the rest of the project: deployable anywhere a container can run, while still being simple enough to replace with a static host later if needed.

Common commands:

```sh
mise run //apps/www:dev
mise run //apps/www:build:with-static-demo
mise run //apps/www:preview
```

Create a draft post with frontmatter in the dated content directory:

```sh
mise run //apps/www:blog:new
mise run //apps/www:blog:new -- --date 2026-05-28 --description "Short summary."
```

Blog posts live in dated folders under `src/content/blog/yyyy/mm/<post-slug>/index.mdx`. The public URL uses only the
post folder slug, so `src/content/blog/2026/05/my-post/index.mdx` publishes to `/blog/my-post/`. Use the generator script
as the starting point, use the existing draft template as a reference, and set `draft: false` in frontmatter when a post
should be published to `/blog/`, `/blog/<slug>/`, and `/rss.xml`.

Post-specific images and other blog assets should live beside the post under
`src/content/blog/yyyy/mm/<post-slug>/assets/`. Reference them from Markdown with relative paths like
`![Alt text](./assets/image.png)`, or import them with `astro:assets` when the post needs optimized image handling. Use
`public/` for stable site-level files that need hand-written URLs, such as `/og-image.png`, `/images/simple-mode.svg`,
or externally referenced assets.

Static demo data:

Review exported data before publishing it. The export is designed for a public read-only demo and includes the session
prompts, event payloads, artifact metadata, external resources, and callback delivery status needed by the UI.
When `--include-artifacts` is used, stored artifact files are copied into `apps/web/public/demo/artifacts` and their
URLs are rewritten so image and browser-playable video artifacts render in the static demo.

```sh
DATABASE_URL=postgres://deputies:deputies@127.0.0.1:5432/deputies pnpm --dir apps/control-plane demo:export -- --session-id <session-id> --session-id <session-id>
mise run //apps/www:build:with-static-demo
```

The current public demo set was exported from local Postgres and SeaweedFS/S3 using `.env.local` for `DATABASE_URL` and
artifact storage settings:

```sh
set -a; source ./.env.local; set +a
pnpm --dir apps/control-plane demo:export -- --include-artifacts \
  --session-id 2e1b8be8-d872-45f9-851f-b4400319827d \
  --session-id 3d89bb50-2b1c-46f9-a3a6-a192ddc38ef2 \
  --session-id 5def100c-eed1-4b37-82c2-066b97bd390b \
  --session-id d7d24550-4804-45d5-9df8-da26e079e796 \
  --session-id 6678a357-0e6d-4cae-bc74-3ce5394d8cdb
mise run //apps/www:build:with-static-demo
```

For local preview, build the embedded web demo before starting the www dev server:

```sh
mise run //apps/web:build:static-demo
mise run //apps/www:dev
```

If you explicitly want the most recently updated sessions instead of a reviewed set of ids, pass `--latest`:

```sh
DATABASE_URL=... pnpm --dir apps/control-plane demo:export -- --latest --limit 3
```
