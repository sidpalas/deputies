# syntax=docker/dockerfile:1.7

# CreateOS provider rootfs. CreateOS executes commands through its own in-VM
# agent rather than the Deputies sandbox bridge, so this image only needs the
# shared Deputies sandbox toolchain — no bridge process and no long-running
# command. Build it into a CreateOS rootfs template, then point the provider at
# the registered template name/id with CREATEOS_ROOTFS.
ARG DEPUTIES_SANDBOX_BASE_IMAGE=deputies-sandbox-base:local

FROM ${DEPUTIES_SANDBOX_BASE_IMAGE}

RUN mkdir -p /workspace

WORKDIR /workspace
