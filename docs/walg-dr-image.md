# The WAL-G image for the homelab DR standby

`ghcr.io/boardsesh/wal-g` is the WAL-G sidecar the homelab PostgreSQL 18
disaster-recovery standby uses for WAL archiving, base backups and restore
drills. This repository builds and publishes it; the
[`blackheathdc-ansible`](https://github.com/marcodejongh/blackheathdc-ansible)
`boardsesh_dr` role consumes it by digest.

## Why we build it ourselves

Upstream publishes no container image. `ghcr.io/wal-g/wal-g` does not exist —
anonymous token requests are denied and every tag probe returns
`manifest unknown`, while a known-good digest on our own repository inspects fine
from the same shell. WAL-G ships release binaries, and its `docker/` tree is test
fixtures. So there was never a digest there to pin, and the DR role's original
pin could not have worked.

## What the image has to satisfy

The ansible role enforces all of this, and
`.github/workflows/walg-image.yml` checks each one so a failure lands in CI
rather than on the DR host.

| Contract | Why |
|---|---|
| The binary is at `/wal-g` and answers `--version` | The role's sidecar gate and the Compose `entrypoint` |
| It is extractable with `docker create` + `docker cp` | The role installs it on the host for the isolated restore drill |
| **It is statically linked** | The extracted binary is then run *inside the PostgreSQL image*, so it must not depend on this image |
| `wal-push`, `wal-fetch`, `backup-push`, `backup-list`, `wal-verify`, `delete` exist | Every subcommand the role's scripts invoke |
| It runs as uid/gid 999, `--network none`, read-only root, all capabilities dropped, tmpfs `/tmp` | The Compose service's security posture |
| `backup-list --json` answers with a JSON array on an empty store | The role's verify script pipes it through `jq 'type == "array"'` |

Static linkage is the load-bearing one, and it is why the build sets
`CGO_ENABLED=0`. The build stage also runs on `$BUILDPLATFORM` and
cross-compiles with `GOARCH`, so the arm64 image costs no emulation. Both
architectures are published, matching the PostgreSQL image this binary has to run
inside.

## Three things that are not obvious

**`GOEXPERIMENT=jsonv2` is required.** wal-g v3.0.9 imports
`encoding/json/v2`, which sits behind that experiment on the Go 1.25 toolchain
its `go.mod` asks for. Without it the build fails with
`build constraints exclude all Go files in .../encoding/json/v2`.

**The build uses module mode, not the vendored tree.** v3.0.9 ships a
`vendor/modules.txt` that modern Go rejects as inconsistent with its `go.mod`.
Module mode is still pinned: every dependency hash is checked against the
repository's own `go.sum`. The source tree itself is pinned by commit SHA rather
than by the tag, because a tag is a mutable reference.

**The image must declare uid 999.** wal-g calls `user.Current()`, which a
CGO-free binary can answer only from `/etc/passwd` or `$USER`. The role runs the
image as uid 999, which the Debian base does not define, so without a passwd
entry every `wal-push` fails with:

```
user: Current requires cgo or $USER set in environment
```

It fails at *backup* time while `--version` stays green, so every gate the role
applies would have passed while the standby archived nothing. The image declares
uid/gid 999 and sets `USER`/`HOME` as a fallback for any other uid. (Inside the
PostgreSQL image, where the extracted binary runs, 999 is already `postgres` —
which is why that half was never affected.)

## Publishing and pinning a new digest

Publishing is `workflow_dispatch` only. The digest is pinned by hand in the
`Homelab` vault, and an image that moved on its own would leave that pin
describing an artifact nobody chose.

1. Dispatch **WAL-G Image** on `main`. The contract job runs for both
   architectures first; publishing only happens if it passes.
2. Read the digest from the run's step summary.
3. Put it in 1Password, vault `Homelab`, item **Boardsesh DR artifacts**, field
   `walg_image_digest`. The role compares its variable against this literal on
   every converge, so inventory and extra-vars cannot redirect it.
4. Re-run `configure.yml` in the ansible repo. It re-verifies the sidecar
   contract, then re-extracts the host binary because the recorded source digest
   no longer matches.

The `sha-<commit>` tag the workflow pushes is a lookup alias only — the role
deploys by digest, the same rule as
[`postgres-image-publishing.md`](./postgres-image-publishing.md).

## Upgrading WAL-G

Bump both `WALG_VERSION` and `WALG_COMMIT` in `docker/walg/Dockerfile`; the
build asserts the checkout landed on that SHA. Resolve the pair with:

```bash
git ls-remote https://github.com/wal-g/wal-g refs/tags/<tag>
```

Then open a PR — the contract job proves the new version still satisfies
everything above, including the WAL round-trip — and publish and re-pin as
described above.
