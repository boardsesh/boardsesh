FROM debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171 AS builder

ARG PGBOUNCER_VERSION=1.25.2
ARG PGBOUNCER_SHA256=924ad35113fd0a71c8e2dbe85b5d03445532e2b7b37a9f8a48983beea238b332

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
      build-essential \
      ca-certificates \
      curl \
      libc-ares-dev \
      libevent-dev \
      libssl-dev \
      pkg-config \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

RUN curl --fail --location --proto '=https' --tlsv1.2 \
      "https://www.pgbouncer.org/downloads/files/${PGBOUNCER_VERSION}/pgbouncer-${PGBOUNCER_VERSION}.tar.gz" \
      --output pgbouncer.tar.gz \
    && printf '%s  %s\n' "${PGBOUNCER_SHA256}" pgbouncer.tar.gz | sha256sum --check --strict \
    && tar --extract --gzip --file pgbouncer.tar.gz --strip-components=1 \
    && ./configure --prefix=/usr/local --with-cares \
    && make -j"$(nproc)" pgbouncer \
    && install --directory /staging/usr/local/bin \
    && install --mode=0755 pgbouncer /staging/usr/local/bin/pgbouncer \
    && pgbouncer_version_output="$(/staging/usr/local/bin/pgbouncer --version)" \
    && printf '%s\n' "$pgbouncer_version_output" | grep --line-regexp --fixed-strings "PgBouncer ${PGBOUNCER_VERSION}" \
    && printf '%s\n' "$pgbouncer_version_output" | grep --fixed-strings 'adns: c-ares' \
    && printf '%s\n' "$pgbouncer_version_output" | grep --fixed-strings 'tls: OpenSSL'

FROM debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171 AS runtime

LABEL org.opencontainers.image.source="https://github.com/boardsesh/boardsesh" \
      org.opencontainers.image.title="Boardsesh PgBouncer" \
      org.opencontainers.image.version="1.25.2" \
      org.opencontainers.image.licenses="ISC"

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
      ca-certificates \
      libc-ares2 \
      libevent-2.1-7 \
      libssl3 \
      openssl \
      postgresql-client \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 pgbouncer \
    && useradd --uid 10001 --gid pgbouncer --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin pgbouncer \
    && install --directory --owner=pgbouncer --group=pgbouncer --mode=0700 /run/pgbouncer

COPY --from=builder /staging/usr/local/bin/pgbouncer /usr/local/bin/pgbouncer
COPY --chmod=0755 docker-entrypoint.sh healthcheck.sh /usr/local/bin/

USER 10001:10001

EXPOSE 6432
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 CMD ["/usr/local/bin/healthcheck.sh"]

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
