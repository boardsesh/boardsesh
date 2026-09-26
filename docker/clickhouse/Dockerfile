# ClickHouse for xprem Observe on Railway (service boardsesh-ota-clickhouse).
#
# The stock image with one extra file in config.d. Stock ClickHouse sizes itself
# for a dedicated analytics host: a 5 GiB mark cache, an 8 GiB uncompressed cache,
# a memory ceiling of 90% of whatever the cgroup allows, and seventeen system log
# tables that write every few seconds. Observe is five small tables fed by roughly
# 136k OTA requests a week, and Railway bills memory on usage, page cache included.
# The stock server idled at 2.9 GB under a 24 GB ceiling. See
# config.d/boardsesh-lean.xml for each setting and why.
#
# Base version: 25.3, the version xprem tests against (docker-compose.yml and
# .github/workflows/push.yml in the xprem repo). xprem's goose migrations have never
# run on anything else, so this file changes configuration only, never the version.
#
# Pinned by index digest because a tag is a mutable reference: 25.3 moves with
# every patch release, and a rebuild must not pick up a different server. The
# digest below resolved to 25.3.14.14 (amd64 and arm64).
#
# The upstream entrypoint is kept on purpose. The Railway service relies on its
# CLICKHOUSE_USER / CLICKHOUSE_PASSWORD / CLICKHOUSE_DB handling, and on the
# docker_related_config.xml it ships (listen on 0.0.0.0).
FROM clickhouse/clickhouse-server:25.3@sha256:b627d7a9bc0e0c1bac26cdbe9d2fc6316faa29c5d8a174f28f5abd57d0fa6ba2

COPY config.d/boardsesh-lean.xml /etc/clickhouse-server/config.d/boardsesh-lean.xml

LABEL org.boardsesh.clickhouse.base="clickhouse/clickhouse-server:25.3.14.14" \
      org.opencontainers.image.title="boardsesh clickhouse (xprem Observe)" \
      org.opencontainers.image.description="ClickHouse 25.3 with a 1.2 GB memory ceiling, small caches and only query_log enabled, for the Boardsesh OTA Observe service on Railway" \
      org.opencontainers.image.source="https://github.com/boardsesh/boardsesh"
