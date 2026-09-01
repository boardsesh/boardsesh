# PostgreSQL Tailscale forwarder

This directory contains the credential-free TCP forwarder used for direct
Boardsesh production database operations. See
[`docs/postgres-secure-network.md`](../../docs/postgres-secure-network.md) for
the architecture, environment contract, tailnet policy merge, and rollout.

The image is published by `.github/workflows/postgres-secure-network.yml` and
must be deployed by immutable digest. The checked-in Railway configuration has
no build section because Railway is not the image builder.
