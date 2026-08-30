# ESP32 OTA Implementation Plan

This document outlines the phased implementation plan for the ESP32 OTA update system described in [esp32-ota-architecture.md](./esp32-ota-architecture.md).

## Summary

A custom OTA solution that leverages existing infrastructure:

- **Backend**: GraphQL API for version management and fleet tracking
- **Binary Storage**: GitHub Releases (no S3 needed)
- **ESP32**: Native ESP-IDF OTA with HTTPS download from GitHub
- **CI/CD**: GitHub Actions for automated builds across channels (alpha/beta/stable)

**Target scale**: 20-100 devices (expandable)

## Channel Strategy

All firmware binaries are stored as GitHub Release assets:

| Channel    | Trigger            | Tag Format                 | GitHub Release Type |
| ---------- | ------------------ | -------------------------- | ------------------- |
| **Alpha**  | PR created/updated | `alpha/pr-{num}-{sha}`     | Pre-release         |
| **Beta**   | Push to main       | `beta/{sha}`               | Pre-release         |
| **Stable** | Manual promotion   | `v{major}.{minor}.{patch}` | Latest release      |

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  PR Branch  │────▶│    main     │────▶│   Stable    │
│             │     │             │     │  (manual)   │
└─────────────┘     └─────────────┘     └─────────────┘
       │                   │                   │
       ▼                   ▼                   ▼
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Alpha     │     │    Beta     │     │   Stable    │
│ Pre-release │     │ Pre-release │     │   Latest    │
└─────────────┘     └─────────────┘     └─────────────┘
```

### Why GitHub Releases?

- **No additional infrastructure** - No S3 bucket setup or costs
- **Built-in versioning** - Releases tied to git tags naturally
- **Free hosting** - GitHub hosts binaries at no cost
- **Simple CI** - Native `gh release create` in Actions
- **Public URLs** - Direct download links for ESP32

---

## Implementation Phases

### Phase 1: Database & Backend Foundation

**Scope**: Backend changes only

#### 1.1 Database Schema

Create migrations for OTA tables in `packages/db/`:

```bash
# From packages/db/
vp exec drizzle-kit generate
```

**Tables to create**:

- `esp32_firmware_releases` - Firmware version registry (synced from GitHub)
- `esp32_controller_firmware` - Per-controller firmware state and channel preference
- `esp32_firmware_update_log` - Audit trail

**Files to create/modify**:

- `packages/db/src/schema/app/firmware.ts` - Drizzle schema
- `packages/db/src/schema/index.ts` - Export new tables

#### 1.2 GraphQL Schema Extension

Add firmware types to shared schema:

**File**: `packages/shared-schema/src/schema.ts`

- Add `FirmwareRelease`, `FirmwareChannel`, `FirmwareUpdateInfo` types
- Add `FirmwareUpdateState` enum
- Add input types for mutations

#### 1.3 Backend Resolvers

Create firmware resolver module:

**Files to create**:

- `packages/backend/src/graphql/resolvers/firmware/index.ts`
- `packages/backend/src/graphql/resolvers/firmware/queries.ts`
  - `availableFirmware` - List firmware by board type and channel
  - `firmwareReleases` - Admin listing
  - `controllerFirmwareStatuses` - Fleet status
- `packages/backend/src/graphql/resolvers/firmware/mutations.ts`
  - `checkFirmwareUpdate` - Controller update check
  - `reportFirmwareStatus` - Controller status reporting
  - `registerFirmwareBuild` - CI registration (requires CI_API_KEY)
  - `setUpdateChannel` - Controller channel preference
  - `promoteBetaToStable` - Manual promotion trigger
- `packages/backend/src/graphql/resolvers/firmware/subscriptions.ts`
  - `firmwareUpdateAvailable` - Push notifications to controllers

**Files to modify**:

- `packages/backend/src/graphql/resolvers/index.ts` - Add firmware resolvers
- `packages/backend/src/websocket/setup.ts` - Add CI API key auth

#### 1.4 CI Authentication

Add CI API key validation for GitHub Actions:

**Environment variables**:

- `CI_API_KEY` - Secret for GitHub Actions authentication

**Auth flow**: Bearer token in Authorization header, validated in `requireCIAuth()` helper.

---

### Phase 2: ESP32 Firmware Implementation

**Scope**: Embedded C++ code

#### 2.1 OTA Manager Module

Create core OTA functionality:

**Files to create**:

- `packages/board-controller/esp32/src/ota/ota_manager.h`
- `packages/board-controller/esp32/src/ota/ota_manager.cpp`

**Features**:

- Periodic update checks (configurable interval, default 1 hour)
- HTTPS firmware download from GitHub Releases
- SHA256 checksum verification
- ESP-IDF dual-partition OTA with automatic rollback
- Status reporting to backend via GraphQL

#### 2.2 Version Header

Auto-generated version info:

**File**: `packages/board-controller/esp32/src/version.h`

```cpp
#pragma once
#define FIRMWARE_VERSION "1.0.0"
#define FIRMWARE_VERSION_CODE 10000
#define FIRMWARE_CHANNEL "stable"
```

CI injects correct values during build.

#### 2.3 WebSocket Client Extensions

Add firmware-related GraphQL operations:

**File to modify**: `packages/board-controller/esp32/src/websocket/`

- `sendCheckFirmwareUpdate()` - Query for updates
- `sendFirmwareStatus()` - Report progress
- `queryAvailableFirmware()` - List available versions
- `mutateSetUpdateChannel()` - Change channel preference

#### 2.4 Main Integration

Integrate OTA manager into main loop:

**File to modify**: `packages/board-controller/esp32/src/main.cpp`

- Initialize OTA manager in `setup()`
- Call `otaManager.loop()` in main loop
- Handle update notifications from WebSocket

---

### Phase 3: CI/CD Pipeline

**Scope**: GitHub Actions workflows

#### 3.1 Alpha Build Workflow (PRs)

Builds firmware on every PR update:

**File**: `.github/workflows/firmware-alpha.yml`

```yaml
name: Firmware Alpha Build

on:
  pull_request:
    paths:
      - 'packages/board-controller/esp32/**'
      - 'embedded/**'

jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        board: [esp32, esp32s3]
    steps:
      - uses: actions/checkout@v4

      - name: Setup PlatformIO
        run: pip install platformio

      - name: Build firmware
        working-directory: packages/board-controller/esp32
        run: pio run -e ${{ matrix.board }}

      - name: Create alpha release
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          VERSION="pr-${{ github.event.pull_request.number }}-${GITHUB_SHA:0:7}"
          TAG="alpha/${VERSION}"

          # Delete existing release for this PR+SHA if exists
          gh release delete "$TAG" --yes || true
          git push origin --delete "$TAG" || true

          # Create new pre-release
          gh release create "$TAG" \
            --title "Alpha: PR #${{ github.event.pull_request.number }}" \
            --notes "PR: #${{ github.event.pull_request.number }}\nCommit: ${GITHUB_SHA:0:7}\nBranch: ${{ github.head_ref }}" \
            --prerelease \
            packages/board-controller/esp32/.pio/build/*/firmware.bin

      - name: Register with backend
        run: |
          # GraphQL mutation to register build
          curl -X POST "${{ vars.BACKEND_URL }}/graphql" \
            -H "Authorization: Bearer ${{ secrets.CI_API_KEY }}" \
            -H "Content-Type: application/json" \
            -d '{"query": "mutation { registerFirmwareBuild(input: {...}) { id } }"}'
```

#### 3.2 Beta Build Workflow (main branch)

Builds firmware on every push to main:

**File**: `.github/workflows/firmware-beta.yml`

```yaml
name: Firmware Beta Build

on:
  push:
    branches: [main]
    paths:
      - 'packages/board-controller/esp32/**'
      - 'embedded/**'

jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        board: [esp32, esp32s3]
    steps:
      - uses: actions/checkout@v4

      - name: Setup PlatformIO
        run: pip install platformio

      - name: Build firmware
        working-directory: packages/board-controller/esp32
        run: pio run -e ${{ matrix.board }}

      - name: Create beta release
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          VERSION="${GITHUB_SHA:0:7}"
          TAG="beta/${VERSION}"

          gh release create "$TAG" \
            --title "Beta: ${VERSION}" \
            --notes "Commit: ${GITHUB_SHA}\nBranch: main" \
            --prerelease \
            packages/board-controller/esp32/.pio/build/*/firmware.bin

      - name: Register with backend
        run: |
          # GraphQL mutation to register build
```

#### 3.3 Stable Promotion Workflow (manual)

Manual workflow to promote a tested beta to stable:

**File**: `.github/workflows/firmware-promote.yml`

```yaml
name: Promote to Stable

on:
  workflow_dispatch:
    inputs:
      beta_tag:
        description: 'Beta tag to promote (e.g., beta/abc1234)'
        required: true
      version:
        description: 'Semantic version (e.g., 1.2.3)'
        required: true

jobs:
  promote:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Download beta assets
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          gh release download "${{ inputs.beta_tag }}" --dir ./firmware-assets

      - name: Create stable release
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          TAG="v${{ inputs.version }}"

          gh release create "$TAG" \
            --title "v${{ inputs.version }}" \
            --notes "Stable release promoted from ${{ inputs.beta_tag }}" \
            --latest \
            ./firmware-assets/*

      - name: Register stable release with backend
        run: |
          # GraphQL mutation to register as stable

      - name: Notify controllers (optional)
        run: |
          # GraphQL mutation to trigger update notifications
```

#### 3.4 Alpha Cleanup Workflow

Cleanup old alpha releases to avoid clutter:

**File**: `.github/workflows/firmware-cleanup.yml`

```yaml
name: Cleanup Alpha Releases

on:
  schedule:
    - cron: '0 0 * * 0' # Weekly on Sunday
  workflow_dispatch:

jobs:
  cleanup:
    runs-on: ubuntu-latest
    steps:
      - name: Delete old alpha releases
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          # Keep only last 5 alpha releases per PR
          # Delete alpha releases older than 30 days
          gh release list --limit 100 | grep "alpha/" | while read release; do
            # Logic to determine if release should be deleted
          done
```

---

### Phase 4: ESP32 WebUI Firmware Browser

**Scope**: Embedded web interface

#### 4.1 Firmware Routes

HTTP endpoints on ESP32 that proxy to GraphQL:

**File to create**: `packages/board-controller/esp32/src/web/firmware_routes.cpp`

- `GET /api/firmware/available` - Cached firmware list
- `GET /api/firmware/status` - Current version and state
- `POST /api/firmware/install` - Trigger update
- `POST /api/firmware/channel` - Change channel preference

#### 4.2 WebUI Page

Single-page firmware browser:

**File to create**: `packages/board-controller/esp32/data/firmware.html`

- View firmware across all channels
- See PR details for alpha builds
- Install any version
- Change update channel
- Real-time update progress

---

### Phase 5: Admin Dashboard (Optional)

**Scope**: Next.js web components

#### 5.1 Firmware Management Page

Admin interface for fleet management:

**Files to create**:

- `packages/web/app/admin/firmware/page.tsx`
- `packages/web/app/components/firmware/FirmwareList.tsx`
- `packages/web/app/components/firmware/ControllerStatus.tsx`

**Features**:

- View all firmware releases (from GitHub + database)
- See controller fleet status
- Trigger updates for specific controllers
- View update logs and errors
- Promote beta to stable (triggers GitHub workflow)
- Deactivate problematic releases

---

## Implementation Order

```
Phase 1 (Backend)     ████████░░░░░░░░░░░░
Phase 2 (ESP32)       ░░░░████████░░░░░░░░
Phase 3 (CI/CD)       ░░░░░░░░████████░░░░
Phase 4 (WebUI)       ░░░░░░░░░░░░████░░░░
Phase 5 (Admin)       ░░░░░░░░░░░░░░░░████  (optional)
```

**Recommended approach**:

1. Complete Phase 1 fully (enables CI to register builds)
2. Phase 2 + 3 in parallel (ESP32 dev + CI workflow)
3. Phase 4 after OTA works end-to-end
4. Phase 5 as needed for fleet management

---

## Version Code Calculation

```
Stable:  MAJOR * 10000 + MINOR * 100 + PATCH
         1.2.3 → 10203
         2.0.0 → 20000

Beta:    Unix timestamp (seconds since epoch)
         2024-01-15 12:00:00 → 1705320000

Alpha:   Unix timestamp (seconds since epoch)
         2024-01-15 12:00:00 → 1705320000
```

**Note**: Timestamp-based version codes for beta/alpha are always "newer" numerically than stable releases. The channel preference determines which updates are offered to each controller.

---

## Download URLs

GitHub Release assets have predictable URLs:

```
https://github.com/{owner}/{repo}/releases/download/{tag}/{asset_name}

Examples:
- Stable: https://github.com/marcodejongh/boardsesh/releases/download/v1.2.3/firmware-esp32.bin
- Beta:   https://github.com/marcodejongh/boardsesh/releases/download/beta/abc1234/firmware-esp32.bin
- Alpha:  https://github.com/marcodejongh/boardsesh/releases/download/alpha/pr-123-abc1234/firmware-esp32.bin
```

ESP32 downloads directly from these URLs (no authentication needed for public repos).

---

## Testing Strategy

### Phase 1 Testing

- Unit tests for GraphQL resolvers
- Manual GraphQL playground testing
- Verify database migrations

### Phase 2 Testing

- Bench test: ESP32 dev board with serial monitor
- Test update flow with manually uploaded binary
- Verify checksum validation
- Test rollback by uploading intentionally broken firmware

### Phase 3 Testing

- Create test PR to verify alpha builds
- Merge to main to verify beta builds
- Run promotion workflow to test stable release
- Verify GitHub Release creation and asset uploads

### End-to-End Testing

1. Create a PR with firmware changes
2. Verify alpha release is created
3. Set ESP32 to alpha channel, verify it downloads PR build
4. Merge PR to main
5. Verify beta release is created
6. Run promotion workflow
7. Verify stable release is created and marked as latest
8. Verify ESP32 on stable channel receives update

---

## Rollout Plan

### Initial Deployment

- Deploy backend changes
- Build and flash initial OTA-capable firmware manually
- Test with 2-3 development boards

### Beta Testing

- Enable CI pipeline
- Onboard 5-10 beta testers (beta channel)
- Monitor logs via Axiom integration
- Fix any issues, iterate on PRs (alpha channel)

### Production Rollout

- Promote first stable release via workflow
- Gradual rollout to remaining devices
- Monitor for rollback events

---

## Risk Mitigation

### Bricked Devices

- ESP-IDF dual-partition ensures automatic rollback
- 60-second validation window before confirming update
- Manual recovery possible via USB if needed

### Network Failures

- Resumable downloads not supported initially (full retry)
- Conservative timeout (30 seconds)
- Exponential backoff on check failures

### Bad Firmware

- SHA256 verification before flashing
- Can delete/unpublish GitHub Release immediately
- Previous stable always available as fallback
- Backend `is_active` flag to hide releases from API

### GitHub Rate Limits

- Backend caches release info (ESP32 queries backend, not GitHub directly)
- 5000 requests/hour for authenticated requests (CI)
- Unauthenticated downloads unlimited for public repos

---

## Dependencies

### Required Secrets (GitHub Actions)

- `CI_API_KEY` - Backend authentication for firmware registration
- `GITHUB_TOKEN` - Provided automatically, used for `gh release`

### Required Variables (GitHub Actions)

- `BACKEND_URL` - GraphQL endpoint URL

### No Longer Required (vs S3 approach)

- ~~`RAILWAY_S3_ACCESS_KEY`~~
- ~~`RAILWAY_S3_SECRET_KEY`~~
- ~~`RAILWAY_S3_BUCKET`~~
- ~~`RAILWAY_S3_ENDPOINT`~~

---

## File Summary

### New Files

| Path                                                          | Description       |
| ------------------------------------------------------------- | ----------------- |
| `packages/db/src/schema/app/firmware.ts`                      | Database schema   |
| `packages/backend/src/graphql/resolvers/firmware/*.ts`        | GraphQL resolvers |
| `packages/board-controller/esp32/src/ota/*.cpp`               | OTA manager       |
| `packages/board-controller/esp32/src/version.h`               | Version defines   |
| `packages/board-controller/esp32/src/web/firmware_routes.cpp` | WebUI routes      |
| `packages/board-controller/esp32/data/firmware.html`          | WebUI page        |
| `.github/workflows/firmware-alpha.yml`                        | Alpha build (PRs) |
| `.github/workflows/firmware-beta.yml`                         | Beta build (main) |
| `.github/workflows/firmware-promote.yml`                      | Manual promotion  |
| `.github/workflows/firmware-cleanup.yml`                      | Alpha cleanup     |

### Modified Files

| Path                                                  | Changes                     |
| ----------------------------------------------------- | --------------------------- |
| `packages/shared-schema/src/schema.ts`                | Add firmware types          |
| `packages/backend/src/graphql/resolvers/index.ts`     | Register firmware resolvers |
| `packages/backend/src/websocket/setup.ts`             | CI API key auth             |
| `packages/board-controller/esp32/src/main.cpp`        | Integrate OTA manager       |
| `packages/board-controller/esp32/src/websocket/*.cpp` | GraphQL methods             |
| `packages/board-controller/esp32/platformio.ini`      | Add OTA dependencies        |

---

## Comparison: GitHub Releases vs S3

| Aspect             | GitHub Releases                  | S3                        |
| ------------------ | -------------------------------- | ------------------------- |
| **Setup**          | None                             | Bucket + credentials      |
| **Cost**           | Free                             | ~$0.02/GB/month           |
| **CI integration** | Native `gh` CLI                  | AWS CLI setup             |
| **URL stability**  | Permanent per release            | Permanent                 |
| **Access control** | Public (or repo access)          | IAM policies              |
| **Cleanup**        | Manual or scheduled              | Manual or lifecycle rules |
| **Rate limits**    | 5000/hr API, unlimited downloads | Unlimited                 |
| **Versioning**     | Built-in (tags)                  | Manual path structure     |

**Decision**: GitHub Releases chosen for simplicity and zero additional infrastructure.
