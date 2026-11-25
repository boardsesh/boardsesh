# Operations and delivery

Deployment, releases, hosting configuration, database operations, storage, disaster recovery and CI. Read each runbook’s gates before applying it.

[All documentation](../README.md)

## Start here

- [Production deploys: the concurrency group, and what to do when main stops shipping](production-deploy.md)
- [Database portability and recovery requirements](database-portability.md)
- [PostgreSQL disaster recovery architecture](postgres-dr-architecture.md)
- [Mobile store release runbook](mobile-store-release.md)

## Guides and supporting records

Current behavior and operational requirements live with their topic. A proposal,
measurement or historical qualification is supporting evidence; its stated limits
and outstanding acceptance gates still apply. A merged change alone does not prove
a production rollout or a physical-device result.

| Document | Path |
| --- | --- |
| [Android release artifacts and Play internal build](android-sideload-build.md) | `android-sideload-build.md` |
| [Branch Deploys: Comprehensive Restoration Strategy](branch-deploys.md) | `branch-deploys.md` |
| [CI runners and slot capacity](ci-runners.md) | `ci-runners.md` |
| [Cloudflare (zone config, edge caching, deploy tooling)](cloudflare.md) | `cloudflare.md` |
| [Database portability and recovery requirements](database-portability.md) | `database-portability.md` |
| [Database connectivity: connect retries and health probes](db-connectivity.md) | `db-connectivity.md` |
| [Database migrations: numbering, collisions, and the renumber bot](db-migrations.md) | `db-migrations.md` |
| [Expo web deployment: dev /app proxy vs prod subdomain (app.boardsesh.com)](expo-web-deployment.md) | `expo-web-deployment.md` |
| [Expo web PR previews](expo-web-previews.md) | `expo-web-previews.md` |
| [Feature flags](feature-flags.md) | `feature-flags.md` |
| [Homelab worker deploys](homelab-deploys.md) | `homelab-deploys.md` |
| [Marketing page loading and performance verification](marketing-page-performance.md) | `marketing-page-performance.md` |
| [Mobile OTA updates (production: self-hosted expo-open-ota V3)](mobile-ota-updates.md) | `mobile-ota-updates.md` |
| [Mobile store release runbook](mobile-store-release.md) | `mobile-store-release.md` |
| [Giving the production primary a real TLS certificate](pg-primary-tls-rollout.md) | `pg-primary-tls-rollout.md` |
| [PostgreSQL 16 collation repair](postgres-16-collation-repair.md) | `postgres-16-collation-repair.md` |
| [PostgreSQL 16 to 18.6 Migration and Availability Runbook](postgres-18-migration.md) | `postgres-18-migration.md` |
| [PostGIS usage audit — Railway production (read-only), 2026-08-23](postgres-18-postgis-audit.md) | `postgres-18-postgis-audit.md` |
| [PostGIS cross-version spatial rehearsal](postgres-18-postgis-rehearsal.md) | `postgres-18-postgis-rehearsal.md` |
| [PostgreSQL disaster recovery architecture](postgres-dr-architecture.md) | `postgres-dr-architecture.md` |
| [Trusted PostgreSQL image publishing](postgres-image-publishing.md) | `postgres-image-publishing.md` |
| [Postgres query costs under the 4 GB cap](postgres-query-costs.md) | `postgres-query-costs.md` |
| [Production deploys: the concurrency group, and what to do when main stops shipping](production-deploy.md) | `production-deploy.md` |
| [R2 migration acceptance record — October 2026](r2-migration-2026-10.md) | `r2-migration-2026-10.md` |
| [Railway cost reduction — September 2026](railway-cost-reduction.md) | `railway-cost-reduction.md` |
| [Railway (OTA project config-as-code)](railway.md) | `railway.md` |
| [Static image CDN](static-assets.md) | `static-assets.md` |
| [User media storage](user-media-storage.md) | `user-media-storage.md` |
| [The WAL-G image for the homelab DR standby](walg-dr-image.md) | `walg-dr-image.md` |
| [OTA homelab deployment](ota-homelab.md) | `ota-homelab.md` |
