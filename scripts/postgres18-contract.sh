#!/usr/bin/env bash
set -Eeuo pipefail

node --import tsx --test packages/db/scripts/migration-owner-role.test.ts
bash packages/db/docker/dev-db-entrypoint.test.sh
bash packages/db/docker/apply-drizzle-migrations.test.sh
bash scripts/postgres-credentials.test.sh
bash scripts/postgres-logical-replication.test.sh
bash scripts/postgres18-workflow-contract.test.sh
bash scripts/postgres18-spatial-surface.test.sh
bash -n packages/db/docker/dev-db-entrypoint.sh packages/db/docker/apply-drizzle-migrations.sh scripts/dev-db-up.sh scripts/dev-db-image-smoke.sh scripts/lib/postgres-credentials.sh scripts/lib/postgres-spatial-capability.sh scripts/postgres16-role-transition-smoke.sh scripts/postgres16-collation-repair.sh scripts/postgres16-collation-repair-smoke.sh scripts/postgres18-image-smoke.sh scripts/postgres18-architecture-smoke.sh scripts/postgres18-spatial-rehearsal.sh scripts/postgres18-spatial-surface.test.sh scripts/postgres18-production-role-transition.sh scripts/postgres18-workflow-contract.test.sh scripts/postgres-migration-audit.sh scripts/postgres-migration-verify-data.sh scripts/postgres-logical-replication.sh scripts/postgres-logical-replication.test.sh scripts/postgres-credentials.test.sh
