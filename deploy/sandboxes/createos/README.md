# CreateOS Sandbox Image

Rootfs assets for the CreateOS sandbox provider
(`SANDBOX_PROVIDER=createos`). CreateOS provisions a VM per session from the
NodeOps CreateOS control plane and runs agent commands through its native
in-VM agent, so — unlike the Docker and Daytona images — this image does
**not** start the Deputies sandbox bridge and needs no long-running command.
It only supplies the shared Deputies sandbox toolchain
(`deploy/sandboxes/base/`).

## How the provider uses a rootfs

The provider sizes each VM with a catalog shape (`CREATEOS_SHAPE`) and
optionally pins a rootfs (`CREATEOS_ROOTFS`). When `CREATEOS_ROOTFS` is
empty, the control plane's host-default rootfs is used. To run real agent
work you usually want a rootfs that carries the Deputies toolchain, built
from this image.

## Build and register a rootfs template

CreateOS builds a rootfs from a Dockerfile through its templates API. Build
the base toolchain locally, then register this image as a template with the
`@nodeops-createos/sandbox` client:

```sh
docker build -f deploy/sandboxes/base/Dockerfile -t deputies-sandbox-base:local .
docker build -f deploy/sandboxes/createos/Dockerfile -t deputies-createos-sandbox:local .
```

```ts
import { CreateosSandboxClient } from '@nodeops-createos/sandbox';
import { readFileSync } from 'node:fs';

const client = new CreateosSandboxClient(); // CREATEOS_SANDBOX_API_KEY / _BASE_URL
const template = await client.templates.create({
  dockerfile: readFileSync('deploy/sandboxes/createos/Dockerfile', 'utf8'),
});
// Set CREATEOS_ROOTFS to the registered template name/id.
```

Then configure:

```sh
SANDBOX_PROVIDER=createos
CREATEOS_API_KEY=...
CREATEOS_SHAPE=s-2vcpu-4gb # optional; this is the default
CREATEOS_ROOTFS=<registered-template-name-or-id>
```

## Custom repository rootfs

As with the other providers, most repositories need extra language runtimes,
system packages, or CLIs. Derive from this image rather than editing it in
place so the toolchain stays intact:

```Dockerfile
FROM deputies-createos-sandbox:local

USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*
USER sandbox
```
