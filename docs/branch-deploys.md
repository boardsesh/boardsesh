# Branch Deploys: Comprehensive Restoration Strategy

## Current State & Problem

### Architecture Summary

Boardsesh is a monorepo with three deployable services:

| Service                          | Production          | Branch Deploys                                        |
| -------------------------------- | ------------------- | ----------------------------------------------------- |
| **Web** (`packages/web`)         | Vercel (Next.js 15) | Docker container at `{PRID}.preview.boardsesh.com`    |
| **Backend** (`packages/backend`) | Railway (Node.js)   | Docker container at `{PRID}.ws.preview.boardsesh.com` |
| **Database** (`packages/db`)     | Neon PostgreSQL     | `boardsesh-dev-db` Docker image (per PR)              |

### Vercel project settings (production)

The web project deploys from `packages/web`, not the repo root. Two dashboard settings under **Settings → Build & Deployment** are hard prerequisites — `packages/web/vercel.json` does nothing without them (and `vercel.json` is strict JSON, so this can't be a comment in the file):

1. **Root Directory = `packages/web`.** This is how Vercel finds `next` (it lives only in `packages/web/package.json`, not the root). Without it the build fails with `No Next.js version detected`.
2. **"Include source files outside of the Root Directory in the Build Step" = on.** The build reaches outside `packages/web`: `bun.lock` lives at the repo root (so `bun install --frozen-lockfile` walks up to find it), Next transpiles sibling workspace packages from source, and `outputFileTracingIncludes` pulls the board-renderer WASM from the hoisted root `node_modules`. With the toggle off, Vercel clones only `packages/web` and the install regenerates or rejects the lockfile.

Keep the larger build machine — `bun install` builds `sharp` plus the Expo/React Native native tree and OOMs on the default size.

## Production deploys (GitHub Actions)

Production deploys run through a single workflow, `.github/workflows/production-deploy.yml`, on push to `main` (or `workflow_dispatch`). Vercel's native git auto-deploy is off (`git.deploymentEnabled: false` in `packages/web/vercel.json`), so Actions is the only production deployer.

Flow:

1. `detect-changes` decides `web_changed` / `backend_changed` from the push diff (backend uses the same path list as `branch-deploy.yml`; web deploys on anything that isn't docs- or mobile-only). `check-rollback` runs in parallel and flags whether a Vercel Instant Rollback is active (see below).
2. `build-web` runs `vercel pull --environment=production` + `vercel build --prod` and uploads `.vercel` (prebuilt output + project link) as an artifact. `build-backend` runs `vp run docker-context:backend`, builds the generated `.docker-context/backend`, and pushes it to `ghcr.io/boardsesh/boardsesh-daemon` with `:production` / `:staging` / `:sha-<short>` / `:latest` tags.
3. **The gate:** `migrate` runs `@boardsesh/db db:migrate` only once every _attempted_ build passed. A build that ran and failed blocks the gate, which skips both production deploys — nothing reaches prod half-built. (Migrations used to run inside the Vercel build; they moved here so they only run behind the gate.)
4. `deploy-web` (`vercel deploy --prebuilt --prod`) and `deploy-production-backend` (`railway redeploy`) run after the gate.
5. One of three Discord notifications fires (all gated on `DISCORD_DEPLOY_WEBHOOK`, all best-effort — webhook failures `::warning::` rather than fail the run, all post with `allowed_mentions.parse=[]` so user-controlled text like PR titles can't ping the channel):
   - `notify-success` on a promoted deploy — lists the PRs that shipped (parsed from `Merge pull request #N` subjects in `github.event.before..github.sha`, titles via `gh api`).
   - `notify-no-promote` when a rollback is active (see Instant Rollback below).
   - `notify-failure` on any job failure or cancellation.

Required GitHub config — these live in the **`Production` GitHub environment** (Settings → Environments), not as repo-level secrets. Every job that reads them declares `environment: Production`; jobs that don't (`detect-changes`, `build-backend`, which uses only the automatic `GITHUB_TOKEN`) are left out. Environment-scoped secrets only resolve for jobs that opt in via `environment:` — without it they expand to empty strings and the run fails (401 from Vercel, empty `DATABASE_URL`, etc.).

- **Secrets:** `VERCEL_TOKEN`, `DATABASE_URL` (production Neon — used by the gated migrate job), `RAILWAY_TOKEN`, `DISCORD_DEPLOY_WEBHOOK`.
- **Variables:** `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, `RAILWAY_BACKEND_SERVICE_ID`.

Because the `Production` environment is gated to `main`, a `workflow_dispatch` dry run from a feature branch can't resolve these secrets (the environment-scoped jobs are blocked by the deployment-branch rule). Dry-run from `main`, or temporarily add the branch to the environment's allowed deployment branches.

Railway runs from the prebuilt image, not its own build — keep `railway.toml` free of a `[build]` block and point the service Source at `ghcr.io/boardsesh/boardsesh-daemon:production`.

The homelab staging-backend deploy job is commented out in the workflow until the self-hosted runner is healthy.

### Instant Rollback interaction

When someone uses Vercel **Instant Rollback**, production is pinned to a previous deployment and Vercel disables production-domain auto-assignment. The pipeline handles this by **deploying without promoting** rather than failing:

- **`check-rollback`** reads `lastRollbackTarget` on the Vercel project (`GET /v9/projects/{id}`) and outputs `active=true/false`. It fails closed — if the project API can't be read at all, the run is blocked.
- **When a rollback is active**, the run still builds and migrates, but:
  - `deploy-web` runs `vercel deploy --prebuilt --prod --skip-domain` — the production deployment is created and uploaded but _not_ assigned to the production domain, so the rolled-back deployment keeps serving traffic.
  - `deploy-production-backend` pushes the image to GHCR (`:production`, `:sha-<short>`) but **skips the Railway redeploy** (Railway has no "deploy without promote"). The image is ready to redeploy once the rollback is cleared.
  - `notify-no-promote` posts to Discord with the staged web URL and the GHCR image, plus instructions: clear the rollback (revert the offending commit and re-promote), then promote the staged web deployment and redeploy the backend.
- **Migrations only move forward; Instant Rollback never reverts the DB.** The `migrate` job runs `db:migrate` forward and Instant Rollback rolls back _only the web deployment_. A rolled-back web build therefore runs against the already-migrated schema, so **production migrations must stay backward-compatible (expand/contract)** — never drop or rename a column in the same release that depends on it gone. (This also keeps the staged-but-not-promoted release DB-ready for a clean promotion later.)

### What Broke

Branch deploys stopped working after migrating from Vercel Postgres (which was a managed Neon account under Vercel) to a direct Neon paid account. Specifically:

1. **Neon branching integration is broken** - The Vercel-Neon integration that automatically created database branches per preview deployment no longer functions. Neon support has not resolved this.
2. **Migrations are skipped on preview** - `packages/web/vercel.json` explicitly skips migrations for preview deploys:
   ```json
   "buildCommand": "if [ \"$VERCEL_ENV\" != \"preview\" ]; then npm run db:migrate; fi && npm run build --workspace=@boardsesh/web"
   ```
3. **No backend branching** - No automatic branch deploy mechanism tied to Vercel previews. Preview frontends either point to the production backend or have no backend at all.
4. **`NEXT_PUBLIC_WS_URL` is not set for preview** - Preview deployments don't know where to find a backend, so party mode is non-functional.

### What Still Works

- Vercel still creates preview deployments for every PR (frontend builds succeed)
- The backend CORS handler already allows Vercel preview origins (`packages/backend/src/handlers/cors.ts:4`):
  ```ts
  const VERCEL_PREVIEW_REGEX = /^https:\/\/boardsesh-[a-z0-9]+-marcodejonghs-projects\.vercel\.app$/;
  ```
- The join handler already uses a `backendUrl` query param pattern (`packages/backend/src/handlers/join.ts:56`)
- GitHub Actions CI runs on PRs (typecheck, lint, tests)
- The `boardsesh-dev-db` Docker image contains all board data and is rebuilt automatically

---

## Phase 1: Quick Win - Frontend-Only Branch Deploys

**Effort: ~1-2 days | Impact: Preview deploys become functional for frontend-only changes**

### 1.1 Re-enable Migrations on Preview

Drizzle migrations are idempotent - running them against the development database is safe. The current skip was a workaround for the broken Neon branching (to avoid running migrations against a non-existent branch DB). Since branch deploys use the pre-built `boardsesh-dev-db` Docker image (not the production database), migrations should run unconditionally.

**Change in `packages/web/vercel.json`:**

```json
{
  "buildCommand": "npm run db:migrate && npm run build --workspace=@boardsesh/web"
}
```

> **Note:** Migrations run against the development database Docker image, not production. There is no risk of destructive SQL affecting production data.

### 1.2 Set `NEXT_PUBLIC_WS_URL` for Preview Scope

In Vercel project settings, add `NEXT_PUBLIC_WS_URL` with Environment scope set to **Preview**:

```
NEXT_PUBLIC_WS_URL=wss://backend-production.up.railway.app/graphql
```

This points all preview deployments at the production backend. Party mode, sessions, and real-time features will work against production data.

**Files affected:**

- `packages/web/app/components/connection-manager/connection-settings-context.tsx:9` - reads `NEXT_PUBLIC_WS_URL`
- `packages/web/app/lib/graphql/client.ts:10-11` - converts WS URL to HTTP for GraphQL queries

### 1.3 Change Detection Workflow

Create `.github/workflows/branch-deploy.yml` using `dorny/paths-filter` to label PRs and conditionally trigger jobs based on what changed:

```yaml
name: Branch Deploy

on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  detect-changes:
    runs-on: ubuntu-latest
    outputs:
      web: ${{ steps.filter.outputs.web }}
      backend: ${{ steps.filter.outputs.backend }}
      db: ${{ steps.filter.outputs.db }}
      shared: ${{ steps.filter.outputs.shared }}
    steps:
      - uses: actions/checkout@v4
      - uses: dorny/paths-filter@v3
        id: filter
        with:
          filters: |
            web:
              - 'packages/web/**'
              - 'packages/shared-schema/**'
            backend:
              - 'packages/backend/**'
              - 'packages/shared-schema/**'
            db:
              - 'packages/db/src/schema/**'
              - 'packages/db/drizzle/**'
            shared:
              - 'packages/shared-schema/**'

  # Phase 1: Just report what changed
  # Phase 2: Trigger backend/db branch deploys conditionally
  report:
    needs: detect-changes
    runs-on: ubuntu-latest
    steps:
      - name: Comment on PR
        uses: actions/github-script@v7
        with:
          script: |
            const changes = [];
            if ('${{ needs.detect-changes.outputs.web }}' === 'true') changes.push('web');
            if ('${{ needs.detect-changes.outputs.backend }}' === 'true') changes.push('backend');
            if ('${{ needs.detect-changes.outputs.db }}' === 'true') changes.push('db');
            if ('${{ needs.detect-changes.outputs.shared }}' === 'true') changes.push('shared-schema');
            // Add labels, post comments, etc.
```

### Phase 1 Result

After Phase 1, every Vercel preview deployment:

- Runs migrations (safe, idempotent)
- Connects to the production backend for party mode
- Has full functionality for testing frontend changes
- CI reports which packages were modified

---

## Phase 2: Full-Stack Branch Deploys on Homelab

**Effort: ~3-5 days | Impact: Isolated full stack per PR, $0/month**

### 2.1 Architecture Overview

```
GitHub Actions ─→ Build images ─→ Push to GHCR ─→ Ansible deploy
                                                        │
                                                        ▼
┌────────────────────────────────────────────────────────────────────┐
│  Proxmox VM: branch-deploy-host                                    │
│  (Debian 12, 8+ cores, 40GB RAM, 200GB SSD)                       │
│  (Docker, Traefik, Tailscale, cloudflared)                         │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ Traefik (reverse proxy, Docker labels provider)              │  │
│  │   {N}.preview.boardsesh.com      → web-pr-{N}:3000          │  │
│  │   {N}.ws.preview.boardsesh.com   → backend-pr-{N}:8080      │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  ┌── PR #42 stack ──────────┐  ┌── PR #57 stack ──────────┐       │
│  │ web-pr-42     :3000      │  │ web-pr-57     :3000      │       │
│  │ backend-pr-42 :8080      │  │ backend-pr-57 :8080      │       │
│  │ postgres-pr-42:5432      │  │ postgres-pr-57:5432      │       │
│  │ redis-pr-42   :6379      │  │ redis-pr-57   :6379      │       │
│  │ (isolated Docker network)│  │ (isolated Docker network)│       │
│  └──────────────────────────┘  └──────────────────────────┘       │
│                                                                    │
│  ┌── Cloudflare Tunnel ──┐  ┌── Tailscale ──────────────────┐    │
│  │ cloudflared            │  │ Tailscale node (MagicDNS)     │    │
│  │ Routes:                │  │ branch-deploy.ts.net           │    │
│  │  *.preview.boardsesh   │  │                               │    │
│  │  .com → Traefik        │  │ Accessible at:                │    │
│  └────────────────────────┘  │  {N}.preview.boardsesh.com    │    │
│                               │  via split DNS                │    │
│                               └───────────────────────────────┘    │
└────────────────────────────────────────────────────────────────────┘
```

Traffic flow: Cloudflare edge → cloudflared on branch-deploy VM → Traefik on same VM → PR containers. Everything runs on a single dedicated VM — no dependency on existing Traefik LXCs or boardsesh-daemon.

### Key Decisions

| Decision            | Choice                                 | Rationale                                               |
| ------------------- | -------------------------------------- | ------------------------------------------------------- |
| **Infrastructure**  | New dedicated Proxmox VM               | Keeps branch deploys isolated from production services  |
| **Runtime**         | Docker Compose per PR on a single VM   | Simplest for 5-10 deploys; no k8s overhead              |
| **Frontend**        | Docker container (standalone Next.js)  | Full-stack isolation; no Vercel dependency for previews |
| **Build location**  | GitHub Actions → GHCR                  | Keeps build load off home cluster                       |
| **Orchestration**   | Ansible playbook on self-hosted runner | Consistent with existing infra-as-code patterns         |
| **Routing**         | Traefik with Docker labels provider    | Automatic discovery, no file templating needed          |
| **Internal access** | Tailscale                              | Already in use, zero-config VPN                         |
| **External access** | Cloudflare Tunnel                      | Secure, no port forwarding needed                       |

### 2.2 Domain Scheme & DNS

**Domain patterns:**

| Access                | Web URL                             | WebSocket URL                                |
| --------------------- | ----------------------------------- | -------------------------------------------- |
| External (Cloudflare) | `https://{N}.preview.boardsesh.com` | `wss://{N}.ws.preview.boardsesh.com/graphql` |
| Internal (Tailscale)  | Same as external (via split DNS)    | Same as external (via split DNS)             |

Where `{N}` is the PR number.

**DNS configuration:**

- Cloudflare DNS: wildcard CNAME `*.preview.boardsesh.com` → Cloudflare Tunnel
- Cloudflare DNS: wildcard CNAME `*.ws.preview.boardsesh.com` → Cloudflare Tunnel
- Tailscale split DNS: `*.preview.boardsesh.com` → branch-deploy VM's Tailscale IP

### 2.3 Prerequisite: Wire up `getBackendWsUrl()`

> **Document only** — code changes happen in a separate task.

`packages/web/app/lib/backend-url.ts` exists with runtime URL resolution but is NOT wired into the codebase. Two changes are needed:

**A) Update `deriveWsUrlFromHost()` pattern**

Currently produces a dash-delimited backend hostname:

```
42.preview.boardsesh.com → wss://42.ws.preview.boardsesh.com/graphql
```

Must use dot subdomain to match the Cloudflare Tunnel / Traefik routing scheme:

```
{N}.preview.boardsesh.com → wss://{N}.ws.preview.boardsesh.com/graphql
```

Specifically, in `deriveWsUrlFromHost()` (line 38), the pattern `${prLabel}-ws.${rest}` needs to become `${prLabel}.ws.${rest}` (or equivalent restructure of the regex match groups).

**B) Migrate 11 call sites from `process.env.NEXT_PUBLIC_WS_URL` to `getBackendWsUrl()`**

The following files read `NEXT_PUBLIC_WS_URL` directly and need to import `getBackendWsUrl()` instead:

1. `packages/web/app/components/connection-manager/connection-settings-context.tsx:9`
2. `packages/web/app/lib/graphql/client.ts:10`
3. `packages/web/app/components/party-session/persistent-session-context.tsx:63`
4. `packages/web/app/components/party-session/join-session-tab.tsx:17`
5. `packages/web/app/components/notifications/use-notification-subscription.ts:55`
6. `packages/web/app/components/climbs/use-save-climb.ts:37`
7. `packages/web/app/components/climbs/comment-section.tsx:39`
8. `packages/web/app/components/climbs/create-climb-form.tsx:297`
9. `packages/web/app/components/social/subscribe-button.tsx:43`
10. `packages/web/app/components/social/new-climb-feed.tsx:47`
11. `packages/web/app/components/settings/settings-page-content.tsx:36`

### 2.4 Docker Images

#### New: `Dockerfile.web`

A new Dockerfile for the Next.js web app, built in GitHub Actions and pushed to GHCR.

**File: `Dockerfile.web`** (repository root)

```dockerfile
# Stage 1: Install dependencies
FROM oven/bun:1-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY packages/web/package.json ./packages/web/
COPY packages/shared-schema/package.json ./packages/shared-schema/
COPY packages/crypto/package.json ./packages/crypto/
COPY packages/db/package.json ./packages/db/
COPY packages/aurora-sync/package.json ./packages/aurora-sync/
COPY packages/moonboard-ocr/package.json ./packages/moonboard-ocr/
RUN bun install --frozen-lockfile

# Stage 2: Build the Next.js app
FROM oven/bun:1-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build args for environment variables baked into the Next.js build
ARG NEXT_PUBLIC_WS_URL
ARG BASE_URL
ENV NEXT_PUBLIC_WS_URL=$NEXT_PUBLIC_WS_URL
ENV BASE_URL=$BASE_URL

# Skip Sentry source map upload in branch deploys
ENV SENTRY_SUPPRESS_TURBOPACK_WARNING=1
ENV NEXT_TELEMETRY_DISABLED=1

RUN bun run build --filter=@boardsesh/web

# Stage 3: Production image (Node runtime for Next.js standalone)
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Copy built app — standalone output is self-contained, no node_modules needed
COPY --from=builder /app/packages/web/.next/standalone ./
COPY --from=builder /app/packages/web/.next/static ./packages/web/.next/static
COPY --from=builder /app/packages/web/public ./packages/web/public

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/ || exit 1

CMD ["node", "packages/web/server.js"]
```

> **Prerequisites:**
>
> 1. **Migrate the repo to Bun** — the project needs to use a package manager with a centralized module cache to avoid duplicating `node_modules` across 10+ concurrent Docker stacks on the branch-deploy VM. Bun's global cache means installs are near-instant and disk-efficient. Other options that solve the same problem include Yarn PNP (zero-install with zip archives) or pnpm (content-addressable store with hardlinks). The key requirement is **not** duplicating hundreds of megabytes of `node_modules` per PR environment.
> 2. **Add `output: 'standalone'` to `next.config.mjs`:**
>    ```js
>    const nextConfig = {
>      output: 'standalone',
>      // ... existing config
>    };
>    ```
>    The standalone output creates a self-contained server that doesn't need `node_modules` at runtime. Vercel ignores this setting and uses its own build pipeline, so it's safe to add.
> 3. **Note on the runner stage**: The final production image uses `node:22-alpine` (not Bun) because Next.js standalone output is designed to run on Node. Bun is only used for package installation and building.

#### Existing: `Dockerfile.backend`

Already exists and works. Tagged per PR: `ghcr.io/marcodejongh/boardsesh-backend:pr-{N}`

#### Existing: Dev DB Image

`ghcr.io/marcodejongh/boardsesh-dev-db:latest` — pulled directly, no build needed.

### 2.5 Docker Compose Template

Each PR gets 4 containers in an isolated Docker network. The compose template uses Ansible Jinja2 templating and Traefik Docker labels for automatic routing.

**File: `docker-compose.pr.yml.j2`** (Ansible template)

```yaml
services:
  web:
    image: 'ghcr.io/marcodejongh/boardsesh-web:pr-{{ pr_number }}'
    container_name: web-pr-{{ pr_number }}
    restart: unless-stopped
    environment:
      - NODE_ENV=production
      - POSTGRES_URL=postgresql://postgres:password@postgres:5432/main
      - DATABASE_URL=postgresql://postgres:password@postgres:5432/main
      - BASE_URL=https://{{ pr_number }}.preview.boardsesh.com
      - NEXTAUTH_SECRET=branch-deploy-secret-{{ pr_number }}
      - NEXTAUTH_URL=https://{{ pr_number }}.preview.boardsesh.com
      - NEXT_PUBLIC_WS_URL=wss://{{ pr_number }}.ws.preview.boardsesh.com/graphql
      - IRON_SESSION_PASSWORD={"1":"branch-deploy-session-{{ pr_number }}"}
    depends_on:
      postgres:
        condition: service_healthy
    deploy:
      resources:
        limits:
          memory: 512M
          cpus: '0.5'
    labels:
      - 'traefik.enable=true'
      - 'traefik.http.routers.web-pr-{{ pr_number }}.rule=Host(`{{ pr_number }}.preview.boardsesh.com`)'
      - 'traefik.http.routers.web-pr-{{ pr_number }}.entrypoints=websecure'
      - 'traefik.http.routers.web-pr-{{ pr_number }}.tls=true'
      - 'traefik.http.routers.web-pr-{{ pr_number }}.tls.certresolver=letsencrypt'
      - 'traefik.http.services.web-pr-{{ pr_number }}.loadbalancer.server.port=3000'
    networks:
      - pr-{{ pr_number }}
      - traefik

  backend:
    image: 'ghcr.io/marcodejongh/boardsesh-backend:pr-{{ pr_number }}'
    container_name: backend-pr-{{ pr_number }}
    restart: unless-stopped
    environment:
      - PORT=8080
      - DATABASE_URL=postgresql://postgres:password@postgres:5432/main
      - REDIS_URL=redis://redis:6379
      - BOARDSESH_URL=https://{{ pr_number }}.preview.boardsesh.com
      - NEXTAUTH_SECRET=branch-deploy-secret-{{ pr_number }}
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    deploy:
      resources:
        limits:
          memory: 256M
          cpus: '0.25'
    labels:
      - 'traefik.enable=true'
      - 'traefik.http.routers.backend-pr-{{ pr_number }}.rule=Host(`{{ pr_number }}.ws.preview.boardsesh.com`)'
      - 'traefik.http.routers.backend-pr-{{ pr_number }}.entrypoints=websecure'
      - 'traefik.http.routers.backend-pr-{{ pr_number }}.tls=true'
      - 'traefik.http.routers.backend-pr-{{ pr_number }}.tls.certresolver=letsencrypt'
      - 'traefik.http.services.backend-pr-{{ pr_number }}.loadbalancer.server.port=8080'
    healthcheck:
      test: ['CMD', 'wget', '--no-verbose', '--tries=1', '--spider', 'http://localhost:8080/health']
      interval: 30s
      timeout: 3s
      start_period: 10s
      retries: 3
    networks:
      - pr-{{ pr_number }}
      - traefik

  postgres:
    image: ghcr.io/marcodejongh/boardsesh-dev-db:latest
    container_name: postgres-pr-{{ pr_number }}
    restart: unless-stopped
    shm_size: '256mb'
    command: postgres -c max_connections=100 -c log_min_messages=warning -c shared_buffers=128MB
    environment:
      - POSTGRES_USER=postgres
      - POSTGRES_PASSWORD=password
      - POSTGRES_DB=main
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U postgres']
      interval: 10s
      timeout: 5s
      retries: 5
    deploy:
      resources:
        limits:
          memory: 1G
          cpus: '0.5'
    networks:
      - pr-{{ pr_number }}

  redis:
    image: redis:7-alpine
    container_name: redis-pr-{{ pr_number }}
    restart: unless-stopped
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
      interval: 5s
      timeout: 3s
      retries: 5
    deploy:
      resources:
        limits:
          memory: 64M
          cpus: '0.1'
    networks:
      - pr-{{ pr_number }}

networks:
  pr-{{ pr_number }}:
    driver: bridge
  traefik:
    external: true
```

#### Key Design Points

1. **4 containers per PR**: web, backend, postgres, redis — fully isolated stack
2. **Isolated networks**: Each PR stack runs in its own Docker network (`pr-{N}`). Services reference each other by service name — no port conflicts.
3. **Traefik network**: Web and backend containers also join the shared `traefik` network so the reverse proxy can reach them.
4. **No published ports**: Services don't expose ports to the host. All traffic goes through Traefik.
5. **Redis**: Required by the backend for pub/sub (multi-instance scaling)
6. **Resource limits**: Each service has memory and CPU limits to prevent a single PR from consuming all resources
7. **`NEXT_PUBLIC_WS_URL` baked at build time**: It's a client-side env var, set during the Docker image build

### 2.6 Traefik Configuration

Traefik runs on the branch-deploy VM using the Docker labels provider. No file-based dynamic config needed — Traefik discovers containers automatically via Docker labels in the compose template.

**Static config (`traefik.yml`, Ansible template):**

```yaml
api:
  dashboard: true
  insecure: true # Dashboard on :8080 — restrict via Tailscale ACLs

entryPoints:
  web:
    address: ':80'
    http:
      redirections:
        entryPoint:
          to: websecure
          scheme: https
  websecure:
    address: ':443'

providers:
  docker:
    endpoint: 'unix:///var/run/docker.sock'
    exposedByDefault: false
    network: traefik

certificatesResolvers:
  letsencrypt:
    acme:
      email: '{{ acme_email }}'
      storage: /acme/acme.json
      dnsChallenge:
        provider: cloudflare
        resolvers:
          - '1.1.1.1:53'
          - '8.8.8.8:53'

# Environment variables needed for Cloudflare DNS challenge:
#   CF_DNS_API_TOKEN=<your-cloudflare-api-token>
```

**TLS strategy**: Use Cloudflare DNS challenge with wildcard certs for `*.preview.boardsesh.com` and `*.ws.preview.boardsesh.com`. A single cert covers all PR subdomains. The Traefik container needs `CF_DNS_API_TOKEN` set as an environment variable.

### 2.7 Cloudflare Tunnel for External Access

Existing Cloudflare Tunnel setup, with cloudflared running on the branch-deploy VM itself.

**Setup:**

1. Create a Cloudflare Tunnel in the Cloudflare Zero Trust dashboard
2. Note the tunnel ID and token
3. Configure DNS: CNAME `*.preview.boardsesh.com` → `<tunnel-id>.cfargotunnel.com`
4. Configure DNS: CNAME `*.ws.preview.boardsesh.com` → `<tunnel-id>.cfargotunnel.com`

**Cloudflared config (`/etc/cloudflared/config.yml`, Ansible template):**

```yaml
tunnel: { { cloudflare_tunnel_id } }
credentials-file: /etc/cloudflared/credentials.json

ingress:
  # Wildcard route: all *.preview.boardsesh.com traffic → Traefik
  - hostname: '*.preview.boardsesh.com'
    service: https://localhost:443
    originRequest:
      noTLSVerify: true # Traefik handles TLS internally
  - hostname: '*.ws.preview.boardsesh.com'
    service: https://localhost:443
    originRequest:
      noTLSVerify: true
  # Catch-all (required by cloudflared)
  - service: http_status:404
```

**How it works:**

1. External user visits `https://42.preview.boardsesh.com`
2. Cloudflare DNS resolves to the Cloudflare Tunnel
3. `cloudflared` on the branch-deploy VM receives the request
4. Forwards to Traefik at `localhost:443`
5. Traefik matches the `Host` header via Docker labels and routes to the correct PR container

WebSocket support: Cloudflare Tunnels support WebSocket natively. `wss://42.ws.preview.boardsesh.com/graphql` works without additional configuration.

### 2.8 Tailscale Internal Access

For team members on the tailnet to access branch deploys without going through Cloudflare.

**Setup:**

1. Install Tailscale on the branch-deploy VM (handled by Ansible)
2. The VM appears in your tailnet as `branch-deploy` (or whatever hostname you set)

**DNS options for `*.preview.boardsesh.com` resolution on tailnet:**

**Option A: Tailscale Split DNS (recommended)**

- In Tailscale admin console → DNS → Add nameserver
- Set the deploy VM as a nameserver for `preview.boardsesh.com`
- Run a lightweight DNS server (e.g., dnsmasq) on the VM that resolves `*.preview.boardsesh.com` to `127.0.0.1`

```bash
# /etc/dnsmasq.d/boardsesh.conf
address=/preview.boardsesh.com/100.x.y.z  # VM's Tailscale IP
```

**Option B: Homelab DNS (Pi-hole / AdGuard / Unbound)**

- Add wildcard DNS records: `*.preview.boardsesh.com` and `*.ws.preview.boardsesh.com` → VM's LAN IP
- Works for devices on the home network without Tailscale

### 2.9 Ansible Playbook: `manage_branch_deploys.yml`

This is the core of Phase 2. A single playbook that manages all PR environments on the branch-deploy VM. GitHub Actions invokes this playbook on a self-hosted runner — all logic lives in Ansible.

#### Modes of operation

| Mode        | Invocation                           | What it does                                                      |
| ----------- | ------------------------------------ | ----------------------------------------------------------------- |
| **Deploy**  | `-e pr_number=123 -e action=deploy`  | Create/update containers for PR #123                              |
| **Cleanup** | `-e pr_number=123 -e action=cleanup` | Remove containers + volumes for PR #123                           |
| **Sweep**   | `-e action=sweep`                    | Query GitHub API for open PRs, remove environments for closed PRs |

#### New role: `branch_deploy_host`

Provisions the branch-deploy VM and manages PR environments:

```
roles/branch_deploy_host/
├── defaults/main.yml          # resource limits, image defaults, data dir
├── templates/
│   ├── docker-compose.pr.yml.j2    # per-PR compose file (Section 2.5)
│   ├── traefik.yml.j2              # Traefik static config
│   └── cloudflared-config.yml.j2   # Cloudflare Tunnel config
├── tasks/
│   ├── main.yml               # VM provisioning (Docker, Traefik, cloudflared, Tailscale)
│   ├── deploy.yml             # create dirs, template compose, pull, start, health check
│   ├── cleanup.yml            # compose down -v, rm dirs, prune images
│   └── sweep.yml              # query GitHub, find stale, loop cleanup
├── files/
│   ├── stale-deploy-cleanup.timer
│   └── stale-deploy-cleanup.service
└── handlers/
    └── main.yml
```

#### VM provisioning (`tasks/main.yml`)

```yaml
---
- name: Install Docker and Docker Compose
  ansible.builtin.include_role:
    name: geerlingguy.docker
  vars:
    docker_users:
      - '{{ deploy_user }}'

- name: Install required packages
  ansible.builtin.apt:
    name:
      - jq
    state: present

- name: Create deploy directories
  ansible.builtin.file:
    path: '{{ item }}'
    state: directory
    owner: '{{ deploy_user }}'
    group: '{{ deploy_user }}'
    mode: '0755'
  loop:
    - /opt/branch-deploys
    - /var/log/branch-deploys

- name: Create shared Traefik network
  community.docker.docker_network:
    name: traefik
    state: present

- name: Configure Traefik
  ansible.builtin.template:
    src: traefik.yml.j2
    dest: /opt/traefik/traefik.yml
    owner: root
    mode: '0644'
  notify: restart traefik

- name: Run Traefik container
  community.docker.docker_container:
    name: traefik
    image: traefik:v3.2
    restart_policy: unless-stopped
    ports:
      - '80:80'
      - '443:443'
      - '8080:8080'
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - /opt/traefik/traefik.yml:/etc/traefik/traefik.yml:ro
      - /opt/traefik/acme:/acme
    env:
      CF_DNS_API_TOKEN: '{{ vault_cloudflare_dns_api_token }}'
    networks:
      - name: traefik

- name: Log in to GHCR
  community.docker.docker_login:
    registry: ghcr.io
    username: '{{ ghcr_username }}'
    password: '{{ ghcr_token }}'

- name: Install Tailscale
  ansible.builtin.include_role:
    name: artis3n.tailscale
  vars:
    tailscale_authkey: '{{ tailscale_auth_key }}'

- name: Install cloudflared
  ansible.builtin.apt:
    deb: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb'
    state: present

- name: Configure cloudflared
  ansible.builtin.template:
    src: cloudflared-config.yml.j2
    dest: /etc/cloudflared/config.yml
    owner: root
    mode: '0600'
  notify: restart cloudflared

- name: Enable cloudflared service
  ansible.builtin.systemd:
    name: cloudflared
    enabled: true
    state: started

- name: Install stale deploy cleanup timer
  ansible.builtin.copy:
    src: '{{ item }}'
    dest: /etc/systemd/system/
    mode: '0644'
  loop:
    - stale-deploy-cleanup.timer
    - stale-deploy-cleanup.service
  notify: reload systemd

- name: Enable stale deploy cleanup timer
  ansible.builtin.systemd:
    name: stale-deploy-cleanup.timer
    enabled: true
    state: started
```

#### Deploy task (`tasks/deploy.yml`)

```yaml
---
- name: Create PR deploy directory
  ansible.builtin.file:
    path: '/opt/branch-deploys/pr-{{ pr_number }}'
    state: directory
    owner: '{{ deploy_user }}'
    mode: '0755'

- name: Template docker-compose for PR
  ansible.builtin.template:
    src: docker-compose.pr.yml.j2
    dest: '/opt/branch-deploys/pr-{{ pr_number }}/docker-compose.yml'
    owner: '{{ deploy_user }}'
    mode: '0644'

- name: Pull images for PR {{ pr_number }}
  ansible.builtin.command:
    cmd: docker compose -f /opt/branch-deploys/pr-{{ pr_number }}/docker-compose.yml -p pr-{{ pr_number }} pull

- name: Start PR {{ pr_number }} stack
  ansible.builtin.command:
    cmd: docker compose -f /opt/branch-deploys/pr-{{ pr_number }}/docker-compose.yml -p pr-{{ pr_number }} up -d --remove-orphans

- name: Wait for backend health check
  ansible.builtin.uri:
    url: 'http://localhost:8080/health'
    status_code: 200
  register: health
  retries: 10
  delay: 5
  until: health.status == 200
  # Health check goes through Docker network, not host port
  # Use docker exec to check health instead:
  ignore_errors: true
```

#### Cleanup task (`tasks/cleanup.yml`)

```yaml
---
- name: Stop and remove PR {{ pr_number }} stack
  ansible.builtin.command:
    cmd: docker compose -f /opt/branch-deploys/pr-{{ pr_number }}/docker-compose.yml -p pr-{{ pr_number }} down -v --remove-orphans
  ignore_errors: true

- name: Remove PR deploy directory
  ansible.builtin.file:
    path: '/opt/branch-deploys/pr-{{ pr_number }}'
    state: absent

- name: Prune dangling images
  ansible.builtin.command:
    cmd: docker image prune -f
  changed_when: false
```

#### Sweep task (`tasks/sweep.yml`)

```yaml
---
- name: List active PR directories
  ansible.builtin.find:
    paths: /opt/branch-deploys
    file_type: directory
    patterns: 'pr-*'
  register: active_deploys

- name: Get open PRs from GitHub
  ansible.builtin.uri:
    url: 'https://api.github.com/repos/marcodejongh/boardsesh/pulls?state=open&per_page=100'
    headers:
      Authorization: 'Bearer {{ github_token }}'
    return_content: true
  register: open_prs

- name: Extract open PR numbers
  ansible.builtin.set_fact:
    open_pr_numbers: "{{ open_prs.json | map(attribute='number') | list }}"

- name: Cleanup stale deployments
  ansible.builtin.include_tasks: cleanup.yml
  vars:
    pr_number: "{{ item | basename | regex_replace('^pr-', '') }}"
  loop: "{{ active_deploys.files | map(attribute='path') | list }}"
  when: "(item | basename | regex_replace('^pr-', '') | int) not in open_pr_numbers"
```

#### Systemd timer for stale cleanup

**`stale-deploy-cleanup.timer`:**

```ini
[Unit]
Description=Clean up stale branch deploys

[Timer]
OnCalendar=daily
Persistent=true

[Install]
WantedBy=timers.target
```

**`stale-deploy-cleanup.service`:**

```ini
[Unit]
Description=Sweep stale branch deploys (closed PRs)

[Service]
Type=oneshot
ExecStart=/usr/bin/ansible-playbook /opt/branch-deploys/manage_branch_deploys.yml -e action=sweep -e github_token=<token>
User=deployer
```

### 2.10 GitHub Actions Workflows

Three workflows, each invoking the Ansible playbook on a self-hosted runner.

#### `branch-deploy.yml` — Deploy on PR events

```yaml
name: Branch Deploy

on:
  pull_request:
    types: [opened, synchronize, reopened]

# Cancel in-progress deployments for the same PR
concurrency:
  group: branch-deploy-pr-${{ github.event.pull_request.number }}
  cancel-in-progress: true

env:
  REGISTRY: ghcr.io
  WEB_IMAGE: ghcr.io/${{ github.repository_owner }}/boardsesh-web
  BACKEND_IMAGE: ghcr.io/${{ github.repository_owner }}/boardsesh-backend

jobs:
  build-images:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    outputs:
      image_tag: pr-${{ github.event.pull_request.number }}

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Build and push web image
        uses: docker/build-push-action@v5
        with:
          context: .
          file: ./Dockerfile.web
          push: true
          tags: |
            ${{ env.WEB_IMAGE }}:pr-${{ github.event.pull_request.number }}
            ${{ env.WEB_IMAGE }}:sha-${{ github.sha }}
          build-args: |
            NEXT_PUBLIC_WS_URL=wss://${{ github.event.pull_request.number }}.ws.preview.boardsesh.com/graphql
            BASE_URL=https://${{ github.event.pull_request.number }}.preview.boardsesh.com
          cache-from: |
            type=gha,scope=web-pr-${{ github.event.pull_request.number }}
            type=gha,scope=web-main
          cache-to: type=gha,mode=max,scope=web-pr-${{ github.event.pull_request.number }}

      - name: Build and push backend image
        uses: docker/build-push-action@v5
        with:
          context: .
          file: ./Dockerfile.backend
          push: true
          tags: |
            ${{ env.BACKEND_IMAGE }}:pr-${{ github.event.pull_request.number }}
            ${{ env.BACKEND_IMAGE }}:sha-${{ github.sha }}
          cache-from: |
            type=gha,scope=backend-pr-${{ github.event.pull_request.number }}
            type=gha,scope=backend-main
          cache-to: type=gha,mode=max,scope=backend-pr-${{ github.event.pull_request.number }}

  deploy:
    needs: build-images
    runs-on: [self-hosted, homelab, ephemeral]
    container:
      image: ghcr.io/marcodejongh/blackheathdc-ansible/ci-runner:latest
    steps:
      - uses: actions/checkout@v4
      - name: Deploy PR environment
        run: |
          ansible-playbook manage_branch_deploys.yml \
            -e pr_number=${{ github.event.pull_request.number }} \
            -e action=deploy
      - name: Comment on PR
        uses: actions/github-script@v7
        with:
          script: |
            const pr = ${{ github.event.pull_request.number }};
            const body = [
              '### Branch Deploy Ready',
              '',
              `| Service | URL |`,
              `|---------|-----|`,
              `| Web | https://${pr}.preview.boardsesh.com |`,
              `| Backend WS | wss://${pr}.ws.preview.boardsesh.com/graphql |`,
              `| Health check | https://${pr}.ws.preview.boardsesh.com/health |`,
              '',
              `_Deployed from commit ${context.sha.substring(0, 7)}_`,
            ].join('\n');

            const comments = await github.rest.issues.listComments({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: pr,
            });
            const botComment = comments.data.find(
              c => c.user.type === 'Bot' && c.body.includes('Branch Deploy Ready')
            );

            if (botComment) {
              await github.rest.issues.updateComment({
                owner: context.repo.owner,
                repo: context.repo.repo,
                comment_id: botComment.id,
                body,
              });
            } else {
              await github.rest.issues.createComment({
                owner: context.repo.owner,
                repo: context.repo.repo,
                issue_number: pr,
                body,
              });
            }
```

#### `branch-deploy-cleanup.yml` — Cleanup on PR close

```yaml
name: Branch Deploy Cleanup

on:
  pull_request:
    types: [closed]

jobs:
  cleanup:
    runs-on: [self-hosted, homelab, ephemeral]
    container:
      image: ghcr.io/marcodejongh/blackheathdc-ansible/ci-runner:latest
    steps:
      - uses: actions/checkout@v4
      - name: Cleanup PR environment
        run: |
          ansible-playbook manage_branch_deploys.yml \
            -e pr_number=${{ github.event.pull_request.number }} \
            -e action=cleanup

      - name: Delete GHCR images
        uses: actions/github-script@v7
        continue-on-error: true
        with:
          script: |
            const prTag = `pr-${context.payload.pull_request.number}`;
            for (const pkg of ['boardsesh-web', 'boardsesh-backend']) {
              try {
                const versions = await github.rest.packages.getAllPackageVersionsForPackageOwnedByOrg({
                  package_type: 'container',
                  package_name: pkg,
                  org: context.repo.owner,
                });
                const version = versions.data.find(v =>
                  v.metadata?.container?.tags?.includes(prTag)
                );
                if (version) {
                  await github.rest.packages.deletePackageVersionForOrg({
                    package_type: 'container',
                    package_name: pkg,
                    org: context.repo.owner,
                    package_version_id: version.id,
                  });
                }
              } catch (e) {
                console.log(`Could not clean up ${pkg}:${prTag}: ${e.message}`);
              }
            }
```

#### `branch-deploy-sweep.yml` — Sweep stale environments

```yaml
name: Branch Deploy Sweep

on:
  push:
    branches: [main]
  schedule:
    - cron: '0 3 * * *' # Daily at 3am

jobs:
  sweep:
    runs-on: [self-hosted, homelab, ephemeral]
    container:
      image: ghcr.io/marcodejongh/blackheathdc-ansible/ci-runner:latest
    steps:
      - uses: actions/checkout@v4
      - name: Sweep stale PR environments
        run: |
          ansible-playbook manage_branch_deploys.yml \
            -e action=sweep \
            -e github_token=${{ secrets.GITHUB_TOKEN }}
```

### 2.11 CORS

Already handled — `VERCEL_PREVIEW_REGEX` in `packages/backend/src/handlers/cors.ts` matches all Vercel preview URLs. Additionally, the backend CORS handler should be updated to allow `*.preview.boardsesh.com` origins for branch deploy frontends.

### 2.12 Resource Limits & Capacity

| Metric                 | Value                                                    |
| ---------------------- | -------------------------------------------------------- |
| **Per PR**             | ~2GB RAM, ~1.5 CPU cores, ~2GB disk                      |
| **VM spec**            | 8+ cores, 40GB RAM, 200GB SSD                            |
| **Max concurrent PRs** | 10-12 (with headroom)                                    |
| **Cleanup**            | Sweep daily at 3am + on every push to main + on PR close |

Resource breakdown per PR:

| Service             | Memory | CPU  | Disk          |
| ------------------- | ------ | ---- | ------------- |
| Web (Next.js)       | 512MB  | 0.5  | ~200MB image  |
| Backend (Node)      | 256MB  | 0.25 | ~150MB image  |
| PostgreSQL (dev-db) | 1GB    | 0.5  | ~1.5GB (data) |
| Redis               | 64MB   | 0.1  | ~10MB         |

### Phase 2 Result

After Phase 2, PRs get:

- An isolated full-stack environment (web + backend + database + redis)
- The database uses the `boardsesh-dev-db` Docker image (full board data, seed users)
- Frontend and backend containers built per-PR and pushed to GHCR
- Traefik routes traffic automatically via Docker labels
- Accessible externally via Cloudflare Tunnel and internally via Tailscale
- Automatic cleanup when the PR is closed/merged
- GHCR image cleanup removes stale PR images
- Sweep job catches anything the cleanup misses

---

## Phase 3: API Consolidation

**Effort: ~2-4 weeks (incremental) | Impact: Fewer services need direct DB access, simpler branch deploys**

### Why This Matters for Branch Deploys

Currently, both the Next.js frontend (via API routes) and the backend need `DATABASE_URL`. This means branch deploys require:

1. A branch database
2. A branch backend
3. A preview frontend configured to use both

If API routes move to the backend's GraphQL layer, the frontend only needs `NEXT_PUBLIC_WS_URL` - no direct database access. Branch deploys simplify to: branch database + branch backend. The frontend preview "just works" by pointing at the branch backend.

### What Stays in Next.js

These routes are tightly coupled to Next.js auth/middleware and should remain:

| Route                              | Reason                                                     |
| ---------------------------------- | ---------------------------------------------------------- |
| `/api/internal/ws-auth`            | Issues JWT tokens for WebSocket auth, uses Next.js session |
| `/api/internal/aurora-credentials` | Manages Aurora API tokens, auth-gated                      |
| `/api/internal/controllers`        | Board controller registration, auth-gated                  |

### What Moves to Backend GraphQL

Organized by migration priority (pure reads first, then mutations, then proxies):

#### Batch 1: Pure Reads (lowest risk)

| Current Route                                                 | GraphQL Query                   |
| ------------------------------------------------------------- | ------------------------------- |
| `/api/v1/[board]/[layout]/[size]/[sets]/[angle]/[climb_uuid]` | `query climb(board, uuid)`      |
| `/api/v1/[board]/[layout]/[size]/[sets]/[angle]/setters`      | `query setters(board, ...)`     |
| `/api/v1/[board]/[layout]/[size]/[sets]/[angle]/heatmap`      | `query heatmap(board, ...)`     |
| `/api/v1/[board]/climb-stats/[climb_uuid]`                    | `query climbStats(board, uuid)` |
| `/api/v1/[board]/beta/[climb_uuid]`                           | `query beta(board, uuid)`       |
| `/api/v1/[board]/grades`                                      | `query grades(board)`           |
| `/api/v1/angles/[board]/[layout]`                             | `query angles(board, layout)`   |
| `/api/v1/grades/[board]`                                      | `query gradeSystem(board)`      |
| `/api/v1/[board]/slugs/**`                                    | `query slugs(board, ...)`       |
| `/api/internal/profile/[userId]`                              | `query profile(userId)`         |
| `/api/internal/favorites`                                     | `query favorites`               |
| `/api/internal/hold-classifications`                          | `query holdClassifications`     |
| `/api/internal/user-board-mapping`                            | `query userBoardMapping`        |
| `/api/internal/climb-redirect`                                | `query climbRedirect(...)`      |

#### Batch 2: Mutations

| Current Route                           | GraphQL Mutation               |
| --------------------------------------- | ------------------------------ |
| `/api/internal/profile` (POST/PUT)      | `mutation updateProfile(...)`  |
| `/api/internal/favorites` (POST/DELETE) | `mutation toggleFavorite(...)` |

#### Batch 3: Aurora API Proxies

| Current Route                      | GraphQL Query/Mutation                  |
| ---------------------------------- | --------------------------------------- |
| `/api/v1/[board]/proxy/login`      | `mutation auroraLogin(board, ...)`      |
| `/api/v1/[board]/proxy/getLogbook` | `query auroraLogbook(board, ...)`       |
| `/api/v1/[board]/proxy/saveAscent` | `mutation auroraSaveAscent(board, ...)` |
| `/api/v1/[board]/proxy/saveClimb`  | `mutation auroraSaveClimb(board, ...)`  |
| `/api/v1/[board]/proxy/user-sync`  | `mutation auroraUserSync(board, ...)`   |

#### Migration Approach

For each route being migrated:

1. Add the GraphQL query/mutation to the shared schema (`packages/shared-schema/src/schema.ts`)
2. Implement the resolver in the backend (`packages/backend/src/graphql/`)
3. Update frontend consumers to use the GraphQL client instead of `fetch('/api/...')`
4. Keep the Next.js route as a thin proxy during transition (forwards to GraphQL)
5. Remove the Next.js route once all consumers are migrated

### Phase 3 Result

After API consolidation:

- Frontend has no direct database dependency (except auth routes)
- Branch deploys only need: dev-db container + backend container
- Frontend previews connect to branch backend via `getBackendWsUrl()`
- Single source of truth for all data access (GraphQL schema)

---

## Phase 4: Sync Migration

**Effort: ~1-2 weeks | Impact: Remove Vercel crons, centralize sync on backend**

### Current State

Sync runs as **long-lived daemon CLIs on a VM**, not as HTTP crons:

- `aurora-sync daemon` (Kilter/Tension via the Aurora API)
- `kilter-sync daemon` (Kilter Grips via Keycloak + PowerSync + REST)

Each loops internally (one user per cycle, quiet hours, shared/catalog sync piggybacked) and authenticates with stored per-user credentials — nothing fronts them, so there is no `CRON_SECRET`. The earlier Vercel crons (`/api/internal/user-sync-cron`, etc.) and backend handlers (`/sync-cron`, `/kilter-sync-cron`) were removed; a long-lived process is required so the shared/catalog piggyback's in-memory cooldown survives across cycles.

### Branch Deploy Sync Strategy

Branch deploys simply **don't run the daemons** — they use snapshot data from the dev-db image, so there's nothing to schedule or disable. If sync testing is needed on a branch, run the CLI manually (e.g. `bunx kilter-sync catalog --user <id>`) against that branch's database.

---

## Decision Matrix

What changed → what gets deployed:

| Changed Package          | Branch Web | Branch DB | Branch Backend | Notes                               |
| ------------------------ | :--------: | :-------: | :------------: | ----------------------------------- |
| `packages/web` only      |    Yes     |    Yes    |      Yes       | Full stack for complete isolation   |
| `packages/shared-schema` |    Yes     |    Yes    |      Yes       | Shared types affect both            |
| `packages/backend` only  |    Yes     |    Yes    |      Yes       | Full stack for complete isolation   |
| `packages/db/src/schema` |    Yes     |    Yes    |      Yes       | Schema change needs isolated DB     |
| `packages/db/drizzle`    |    Yes     |    Yes    |      Yes       | Migration needs isolated DB         |
| `packages/aurora-sync`   |     No     |    No     |    Optional    | Test via manual sync trigger        |
| Multiple packages        |    Yes     |    Yes    |      Yes       | Full stack always deployed together |

**Implementation:** The `dorny/paths-filter` step from Phase 1 (Section 1.3) drives this matrix. The build-images job builds both web and backend images. The deploy job invokes the Ansible playbook on a self-hosted runner.

---

## Security Considerations

### Network Isolation

- Each PR stack runs in its own Docker bridge network
- Services can only reach each other within their stack (except via Traefik)
- No host ports are published — all traffic routes through Traefik

### Secrets

- Branch deploy secrets (`NEXTAUTH_SECRET`, `IRON_SESSION_PASSWORD`) are deterministic but unique per PR — acceptable for previews
- For production-grade secrets, use Vault or GitHub Environments with required reviewers
- The deploy host's SSH key should have restricted permissions (deploy user only, no sudo)

### External Access (Cloudflare Tunnel)

- Cloudflare Access can be layered on top to require authentication for external previews
- Consider enabling Cloudflare Access policies for `*.preview.boardsesh.com` that require GitHub OAuth — this lets external contributors authenticate but prevents random access

### GHCR Image Access

- The deploy host needs a GHCR token (PAT or fine-grained token) with `read:packages` scope
- Store it as an Ansible Vault secret

### Docker Resource Protection

```json
// /etc/docker/daemon.json
{
  "default-ulimits": {
    "nofile": { "Name": "nofile", "Hard": 65536, "Soft": 65536 }
  },
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
```

---

## Cost & Complexity Analysis

### Phase 1 (Frontend-Only)

| Item                   | Cost                        | Complexity                                      |
| ---------------------- | --------------------------- | ----------------------------------------------- |
| Vercel preview deploys | Free (included in plan)     | Minimal - one `packages/web/vercel.json` change |
| GitHub Actions minutes | Free tier (~2000 min/month) | Low - simple workflow                           |
| **Total**              | **$0/month**                | **~1-2 days**                                   |

### Phase 2 (Full-Stack on Homelab)

| Item                                             | Cost                   | Complexity                         |
| ------------------------------------------------ | ---------------------- | ---------------------------------- |
| New Proxmox VM (8 cores, 40GB, 200GB SSD)        | $0 (homelab resources) | Medium - VM provisioning           |
| Docker containers on VM                          | $0                     | Medium - Ansible role              |
| Cloudflare Tunnel routing                        | $0 (free tier)         | Low - config addition              |
| Traefik (Docker labels)                          | $0                     | Low - automatic via compose labels |
| GitHub Actions (self-hosted runner + GHCR build) | $0                     | Medium - workflow setup            |
| **Total**                                        | **$0/month**           | **~3-5 days**                      |

### Phase 3 (API Consolidation)

| Item                | Cost                                                 | Complexity                  |
| ------------------- | ---------------------------------------------------- | --------------------------- |
| Development time    | N/A                                                  | High - incremental refactor |
| Runtime cost change | Slight reduction (fewer Vercel function invocations) | N/A                         |
| **Total**           | **Net neutral or slight savings**                    | **~2-4 weeks**              |

### Phase 4 (Sync Migration)

| Item                   | Cost                                        | Complexity     |
| ---------------------- | ------------------------------------------- | -------------- |
| Remove Vercel crons    | Slight savings (fewer function invocations) | Low            |
| Backend sync endpoints | Already partially done                      | Low-Medium     |
| External cron          | Free (GitHub Actions scheduled)             | Low            |
| **Total**              | **Slight savings**                          | **~1-2 weeks** |

---

## Risks & Mitigations

### Phase 1

| Risk                                                        | Likelihood | Impact | Mitigation                                                                                        |
| ----------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------- |
| Preview deploys create stale sessions on production backend | Low        | Low    | Sessions auto-expire via TTL (existing `autoEndInterval` in `packages/backend/src/server.ts:294`) |

### Phase 2

| Risk                              | Likelihood | Impact | Mitigation                                                                      |
| --------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------- |
| Docker resource exhaustion on VM  | Low        | Medium | Max 10-12 concurrent PRs, resource limits per container, ~2GB per PR on 40GB VM |
| Stale environments not cleaned up | Low        | Medium | Sweep on every push to main + daily cron at 3am + systemd timer                 |
| Cloudflare Tunnel downtime        | Low        | Low    | PR backends unreachable temporarily; acceptable for dev environments            |
| Homelab outage                    | Low        | Low    | PR environments temporarily unavailable; acceptable for dev environments        |
| Docker image build time           | Medium     | Low    | GHA build cache (per-PR + main fallback), Buildx layer caching                  |

### Phase 3

| Risk                                       | Likelihood | Impact | Mitigation                                                                                      |
| ------------------------------------------ | ---------- | ------ | ----------------------------------------------------------------------------------------------- |
| GraphQL schema bloat                       | Medium     | Low    | Organize by domain (board queries, user queries, etc.)                                          |
| Breaking frontend during migration         | Medium     | Medium | Keep old API routes as thin proxies during transition; remove only after all consumers migrated |
| Performance regression (extra network hop) | Low        | Low    | Frontend already makes GraphQL calls for session data; batch queries where possible             |

### Phase 4

| Risk                           | Likelihood | Impact | Mitigation                                                                                  |
| ------------------------------ | ---------- | ------ | ------------------------------------------------------------------------------------------- |
| Sync downtime during migration | Low        | Medium | Run both Vercel crons and backend sync in parallel for 1 week before removing Vercel crons  |
| Aurora API rate limiting       | Low        | Medium | Backend sync already limits to 1 user per call (`packages/backend/src/handlers/sync.ts:31`) |

---

## Implementation Checklist

### Phase 1: Frontend-Only Previews

- [ ] Re-enable migrations in `packages/web/vercel.json` build command
- [ ] Set `NEXT_PUBLIC_WS_URL` in Vercel Preview environment scope
- [ ] Create change detection workflow (`.github/workflows/branch-deploy.yml`)
- [ ] Verify preview deployments connect to production backend

### Phase 2a: Infrastructure Setup (Ansible)

- [ ] Create Proxmox VM for branch deploys (Debian 12, 8 cores, 40GB RAM, 200GB SSD)
- [ ] Create `branch_deploy_host` Ansible role
- [ ] Install Docker Engine + Docker Compose v2
- [ ] Install Tailscale and join tailnet
- [ ] Install and configure cloudflared on the VM
- [ ] Set up Traefik with Docker provider and wildcard TLS (DNS challenge)
- [ ] Create `deployer` user with Docker access
- [ ] Configure GHCR authentication
- [ ] Set up DNS (Tailscale split DNS for `*.preview.boardsesh.com`)
- [ ] Configure Cloudflare DNS: `*.preview.boardsesh.com` CNAME → tunnel
- [ ] Configure Cloudflare DNS: `*.ws.preview.boardsesh.com` CNAME → tunnel
- [ ] Set up stale deploy cleanup systemd timer

### Phase 2b: Package Manager & Docker Images

- [ ] Migrate repo to a package manager with centralized cache (Bun, pnpm, or Yarn PNP) to avoid `node_modules` duplication across PR stacks
- [ ] Create `Dockerfile.web` for the Next.js app (standalone output)
- [ ] Add `output: 'standalone'` to `next.config.mjs`
- [ ] Test both Dockerfiles build correctly locally
- [ ] Verify the web Docker image works with the dev-db setup

### Phase 2c: Ansible Playbook & GitHub Actions

- [ ] Create `manage_branch_deploys.yml` playbook (deploy/cleanup/sweep)
- [ ] Create docker-compose Jinja2 template with all 4 services
- [ ] Create `.github/workflows/branch-deploy.yml` (build images + Ansible deploy)
- [ ] Create `.github/workflows/branch-deploy-cleanup.yml` (Ansible cleanup + GHCR image delete)
- [ ] Create `.github/workflows/branch-deploy-sweep.yml` (Ansible sweep)
- [ ] Update CORS handler to allow `*.preview.boardsesh.com` origins

### Phase 2d: Validation

- [ ] Test full deploy cycle: open PR → build → deploy → see working app → push → update → close → cleanup
- [ ] Verify external access via Cloudflare Tunnel
- [ ] Verify internal access via Tailscale (if configured)
- [ ] Verify WebSocket connections work end-to-end
- [ ] Test concurrent deploys (open 3+ PRs simultaneously)
- [ ] Verify cleanup on PR close removes all resources and GHCR images
- [ ] Add Cloudflare Access policy for external previews (optional)

### Phase 2e: Prerequisites (boardsesh repo)

- [ ] Wire up `getBackendWsUrl()` — update pattern and migrate 11 call sites
- [ ] Update `deriveWsUrlFromHost()` to use `{N}.ws.preview.boardsesh.com` pattern

---

## Staging Backend (FE-Only Deploys)

When a PR only changes frontend code, building and deploying a per-PR backend is wasteful (~3 min build, 256MB RAM). A persistent **staging backend** container runs on the branch-deploy VM, tracking the `main` branch, and serves as a shared fallback.

### How It Works

```
PR with backend changes:     web-pr-N  →  backend-pr-N     (per-PR, isolated)
PR with FE-only changes:     web-pr-N  →  staging-backend   (shared, tracks main)
```

**Routing priority (branch-deploy Traefik):**

- Per-PR backend: `Host(N.ws.preview.boardsesh.com)` at **priority 100** (wins when present)
- Staging backend: `HostRegexp(^[0-9]+\.ws\.preview\.boardsesh\.com$)` at **priority 1** (catch-all fallback)

Client-side WebSocket resolution works unchanged — `{N}.ws.preview.boardsesh.com` always resolves via the Traefik wildcard, hitting either the per-PR backend or the staging backend.

### What Counts as Backend Changes

The `detect-changes` job in `branch-deploy.yml` checks the PR diff. These paths trigger a per-PR backend build:

- `packages/**`
- `Dockerfile.backend`, `scripts/create-service-docker-context.mjs`, `bun.lock`, `package.json`

Everything else is treated as FE-only. `workflow_dispatch` always does a full build.

> **Note:** The same core package/Docker path list appears in two places (see "Path patterns" below). Keep them in sync. Production also treats `scripts/railway-deployment-status.mjs`, `railway.toml`, and `production-deploy.yml` edits as backend-affecting.

### Staging Backend Configuration

The staging backend runs as part of the shared docker-compose infrastructure (managed by Ansible):

- **Image:** `ghcr.io/boardsesh/boardsesh-daemon:staging` (auto-rebuilt on main push by the `build-backend` job in `production-deploy.yml`; the homelab `deploy-staging-backend` job is currently commented out until the runner is healthy)
- **Database:** Real Neon DB (same `DATABASE_URL` as per-PR deploys)
- **Redis:** Shared Redis container on the `branch-deploys` network
- **NEXTAUTH_SECRET:** Shared fixed value stored in 1Password (Homelab vault, "Branch Deploy Host" item) and as GitHub Actions secret `BRANCH_DEPLOY_STAGING_NEXTAUTH_SECRET`
- **Memory:** 256MB limit, health-checked on `/health`

### Path Patterns

Backend-affecting paths are defined in two places that must stay in sync:

1. `production-deploy.yml` `detect-changes` job — shell `case` patterns (decides web/backend builds + deploys on main push)
2. `branch-deploy.yml` `detect-changes` job — shell `case` patterns (decides per-PR vs staging for PRs)

`scripts/create-service-docker-context.mjs` generates `.docker-context/backend` and `.docker-context/web` before image builds. Each generated context contains every root workspace `package.json` under `manifests/` for the Bun install layer, then only the source packages reachable from that service under `source/`. The Dockerfiles copy only `manifests/` before `bun install`, so source-only edits keep the install cache warm and new workspaces are discovered from root `workspaces` instead of hand-maintained Dockerfile lists.

`service-deploy-inputs.yml` runs the generator and verifies both contexts: manifests must match root `workspaces`, service source closures must match workspace dependencies, and Dockerfiles must not reintroduce per-package `COPY packages/.../package.json` lines.

`production-deploy.yml` polls Railway deployment status after redeploy and attempts to roll back to the previously observed Railway deployment if the new one fails. Production deploys use a non-canceling concurrency group.

### Workflows

| Workflow                    | Trigger                   | Purpose                                                                            |
| --------------------------- | ------------------------- | ---------------------------------------------------------------------------------- |
| `branch-deploy.yml`         | PR open/sync              | Detects changes, builds web (always) + backend (if needed), deploys                |
| `production-deploy.yml`     | Push to main / dispatch   | Builds web + backend, gated migrate, deploys prod web (Vercel) + backend (Railway) |
| `branch-deploy-cleanup.yml` | PR close                  | Removes per-PR containers (backend may not exist for FE-only)                      |
| `branch-deploy-sweep.yml`   | Daily 3am UTC + main push | Cleans stale containers, prunes images (7-day TTL)                                 |

---

## Key Files Reference

### BoardSesh repo

| File                                          | Relevance                                                                     |
| --------------------------------------------- | ----------------------------------------------------------------------------- |
| `docs/branch-deploys.md`                      | This document                                                                 |
| `Dockerfile.web`                              | New — standalone Next.js web container                                        |
| `packages/web/app/lib/backend-url.ts`         | Runtime WS URL resolver (prerequisite: update pattern + wire into call sites) |
| `packages/backend/src/handlers/cors.ts`       | CORS config (needs update for `*.preview.boardsesh.com`)                      |
| `packages/backend/src/handlers/join.ts`       | Existing `backendUrl` query param pattern                                     |
| `packages/backend/src/handlers/sync.ts`       | User sync cron endpoint                                                       |
| `packages/backend/src/server.ts`              | All backend HTTP routes, session cleanup                                      |
| `packages/backend/Dockerfile`                 | Backend container build                                                       |
| `packages/aurora-sync/`                       | Shared sync library used by both web and backend                              |
| `packages/web/vercel.json`                    | Build command (migration skip), cron definitions                              |
| `.github/workflows/branch-deploy.yml`         | Build images + trigger Ansible deploy on PR open/sync                         |
| `.github/workflows/branch-deploy-cleanup.yml` | Trigger Ansible cleanup + GHCR delete on PR close                             |
| `.github/workflows/branch-deploy-sweep.yml`   | Trigger Ansible sweep on push to main / daily                                 |
| `.github/workflows/dev-db-docker.yml`         | Existing path-filtered CI for DB changes                                      |
| `.github/workflows/test.yml`                  | Existing CI for web package                                                   |
| `packages/web/app/api/internal/`              | 12 route files to eventually migrate (Phase 3)                                |
| `packages/web/app/api/v1/`                    | 16 route files to eventually migrate (Phase 3)                                |

### Ansible repo (`blackheathdc-ansible`)

| File                                  | Relevance                                                              |
| ------------------------------------- | ---------------------------------------------------------------------- |
| `roles/branch_deploy_host/`           | New role — VM provisioning + PR lifecycle management                   |
| `playbooks/manage_branch_deploys.yml` | New playbook (deploy/cleanup/sweep)                                    |
| `inventories/hosts.yml`               | New branch-deploy VM entry                                             |
| cloudflared config                    | `*.preview.boardsesh.com` + `*.ws.preview.boardsesh.com` ingress rules |
| `.github/workflows/deploy.yml`        | Existing deploy pattern (prior art for self-hosted runners)            |
