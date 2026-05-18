# Deputies WWW

This is the static root-domain site for Deputies.

It intentionally uses Vite, Caddy, and an explicit Dockerfile even though the site is currently a single HTML page:

- Vite gives us a tiny local dev/build workflow and hashed production assets.
- Caddy serves immutable `/assets/*` files while keeping `index.html` revalidatable for safe CDN behavior.
- The Dockerfile makes deployment explicit and portable instead of depending on platform-specific build detection.

This keeps the `www` service aligned with the rest of the project: deployable anywhere a container can run, while still being simple enough to replace with a static host later if needed.

Common commands:

```sh
pnpm www:dev
pnpm www:build
pnpm www:preview
```
