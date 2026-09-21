# WAL-G sidecar for the homelab PostgreSQL 18 DR standby.
#
# Upstream publishes no container image at all: ghcr.io/wal-g/wal-g does not
# exist, WAL-G ships release binaries, and its docker/ tree is test fixtures.
# The DR role in blackheathdc-ansible (roles/boardsesh_dr) therefore pins a
# digest of this image instead.
#
# Two contracts from that role shape this file:
#
#   1. The binary lives at /wal-g and answers --version.
#   2. The role extracts /wal-g with `docker cp` and then runs it *inside the
#      PostgreSQL image* for the isolated restore drill. So the binary must not
#      depend on anything in this image. That is why it is built with
#      CGO_ENABLED=0 and is fully static.
#
# The role also runs the containerised form with network_mode: none,
# read_only: true, cap_drop: ALL, uid/gid 999 and a tmpfs /tmp. A slim Debian
# base keeps /tmp, /etc/passwd and a shell available for diagnosis without
# loosening any of that; the binary itself needs none of it.

ARG WALG_VERSION=v3.0.9
# The commit v3.0.9 pointed at. A tag is a mutable reference, so pinning the tag
# alone would let a rebuild pick up different source; the checkout below is by
# SHA and asserts it landed on this one.
ARG WALG_COMMIT=3e493188db28335fb93a45bd680c6ff8fc3028c1

# --platform=$BUILDPLATFORM keeps this stage on the runner's own architecture and
# cross-compiles with GOARCH instead, so building arm64 costs no emulation.
FROM --platform=$BUILDPLATFORM golang:1.25-bookworm@sha256:3b4a11519ad929d1e1d261a12cff056f0c85b735253d7d861346b9c6f8b36437 AS build

ARG WALG_VERSION
ARG WALG_COMMIT
ARG TARGETARCH

RUN git init --quiet /src \
 && git -C /src remote add origin https://github.com/wal-g/wal-g \
 && git -C /src fetch --quiet --depth 1 origin "${WALG_COMMIT}" \
 && git -C /src checkout --quiet FETCH_HEAD \
 && test "$(git -C /src rev-parse HEAD)" = "${WALG_COMMIT}"

WORKDIR /src/main/pg

# GOEXPERIMENT=jsonv2 because wal-g v3.0.9 imports encoding/json/v2, which is
# behind the experiment on the Go 1.25 toolchain its go.mod asks for.
#
# -mod=mod rather than the vendored tree: v3.0.9 ships a vendor/modules.txt that
# modern Go rejects as inconsistent with go.mod. Module mode is still pinned --
# every dependency hash is checked against the repository's own go.sum.
#
# No build tags, so USE_BROTLI / USE_LIBSODIUM / USE_LZO stay off and nothing
# needs cgo. zstd, which the role selects, is pure Go.
RUN CGO_ENABLED=0 GOOS=linux GOARCH="${TARGETARCH}" GOEXPERIMENT=jsonv2 \
    go build -mod=mod -trimpath \
      -ldflags "-s -w \
        -X github.com/wal-g/wal-g/cmd/pg.walgVersion=${WALG_VERSION} \
        -X github.com/wal-g/wal-g/cmd/pg.gitRevision=${WALG_VERSION}" \
      -o /wal-g .

FROM debian:trixie-slim@sha256:a99cfc517144bc59b1978475ec53b46ecabec7e43635402ee5b77cc54cd1b20a

ARG WALG_VERSION

# wal-g calls user.Current(). A CGO-free binary can only answer that from
# /etc/passwd or from $USER, and the DR role runs this image as uid/gid 999 --
# which the Debian base does not define. Without this, every wal-push fails with
# "user: Current requires cgo or $USER set in environment", and it fails at
# backup time rather than at --version, so the role's own gates would pass.
# Declare the identity the role actually uses, and keep USER/HOME as a fallback
# for any other uid. (Inside the PostgreSQL image, where the role runs the
# extracted binary, uid 999 is already postgres.)
RUN groupadd --system --gid 999 walg \
 && useradd --system --uid 999 --gid 999 --home-dir /tmp \
      --shell /usr/sbin/nologin walg

ENV USER=walg \
    HOME=/tmp

COPY --from=build /wal-g /wal-g

USER 999:999

ENTRYPOINT ["/wal-g"]

LABEL org.boardsesh.walg.version="${WALG_VERSION}" \
      org.boardsesh.walg.flavour="postgres" \
      org.boardsesh.walg.linkage="static" \
      org.opencontainers.image.title="boardsesh wal-g (postgres)" \
      org.opencontainers.image.description="Statically linked WAL-G for the Boardsesh PostgreSQL 18 homelab DR standby" \
      org.opencontainers.image.source="https://github.com/boardsesh/boardsesh"
