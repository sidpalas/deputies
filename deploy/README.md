# Deployment Configurations

This directory contains deployment-specific configuration for running Deputies outside local development.

Use one subdirectory per deployment target or infrastructure provider, for example:

- `railway/`
- `docker/`
- `k8s/`
- `terraform/`

Keep provider-specific secrets out of this directory. Document required environment variables in the relevant subdirectory README instead.
