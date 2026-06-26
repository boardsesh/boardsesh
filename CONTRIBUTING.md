# Contributing to Boardsesh

[Join us on Discord](https://discord.gg/YXA8GsXfQK)

Boardsesh is a monorepo: a Next.js web app, a React Native (Expo) mobile app, and a GraphQL-WS backend. They share code through packages under `packages/shared/`. Most active work is on the mobile app, so this guide leads with React Native and then covers web and backend.

## Where work is tracked

The roadmap lives on one public GitHub project: [Boardsesh Roadmap](https://github.com/orgs/boardsesh/projects/3). Every issue sits in Now, Next, Later, or Done, and large multi-issue features carry an `Initiative` tag you can filter on. New issues you open land in Later by default, and we triage from there.

Large features also get a tracking issue that lists their sub-issues in the order they should land. See [#1773 (Recently Climbed & Display Mode)](https://github.com/boardsesh/boardsesh/issues/1773) for the pattern to copy when you propose a similarly sized change.

See [ROADMAP.md](./ROADMAP.md) for the full picture.

## Quick start

Run the setup script. It checks prerequisites (Node.js, Docker, bun, jq), installs the `vp` toolchain and dependencies, writes the env files, and pulls the prebuilt dev database with all the Kilter and Tension climbs in it.

```bash
# macOS / Linux
./scripts/setup-dev.sh

# Windows (PowerShell): install Vite+ first, then run the steps manually
irm https://vite.plus/ps1 | iex
```

Start the stack and open [http://localhost:3000](http://localhost:3000):

```bash
vp run dev
```

Log in with the seeded test account: `test@boardsesh.com` / `test`.

External contributors: fork the repo, clone your fork, branch, make the change, and open a pull request against `main`. Regular contributors who work on several branches at once usually run git worktrees instead, covered below.

### Testing a pull request without building anything

Every pull request that touches the mobile app gets its own over-the-air update channel named `pr-<number>`, published automatically when the pull request opens. If you have the `tester` role, you can point a normal App Store or TestFlight build at that channel from inside the app and try the change without compiling anything. Whether the channel will work for a given pull request is shown by the OTA compatibility comment on the pull request: a JavaScript-only change rides the channel, and a native change needs a real build instead. Full steps are in [Path A](#path-a-small-changes-through-the-ota-channel-switcher) below.

## The vp toolchain

The repo is driven by [Vite+](https://viteplus.dev), invoked as `vp`. It runs lint, format, tests, typecheck, and every custom dev task from one config (`vite.config.ts`), so everyone gets the same behavior locally and in CI.

Use `vp` for all validation. `bun run`, `bunx`, and `npx` bypass the unified config and can mutate `bun.lock`, so a pre-commit hook (`.claude/hooks/block-bun-npm-run.sh`) blocks them. The only sanctioned exceptions are `bunx drizzle-kit generate` for migrations and `bun run backend:start` for the production backend.

The setup script installs `vp`. To install it on its own:

```bash
curl -fsSL https://vite.plus | bash   # macOS / Linux
```

Commands you will use most:

| Command                                      | What it does                                                                                                            |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `vp check`                                   | Format + lint. This is the canonical check, and the pre-commit hook runs `vp check --fix`.                              |
| `vp run typecheck`                           | TypeScript across every package. Run it before you push. Scope it with `:web`, `:backend`, `:mobile`, `:db`, `:shared`. |
| `vp test`                                    | Run tests. Add `run --reporter=agent` for compact output.                                                               |
| `vp test run --project web\|backend\|mobile` | Scope tests to one package. The `--project` flag must come after `run`.                                                 |
| `vp run dev`                                 | Start the database, backend, and web together.                                                                          |
| `vp run dev:mobile`                          | Start the mobile Metro bundler.                                                                                         |

Use `vp check` and `vp run typecheck` to validate, not `vp run build` (a build interferes with the dev server).

## Running the stack

`vp run dev` starts the Postgres and Redis containers, applies pending migrations, and launches the backend and web servers. The pieces also run on their own:

- `vp run db:up` starts Postgres and Redis (plus migrations).
- `vp run dev:backend` starts the database and the backend.
- `vp run dev:web` starts the database and web.
- `vp run dev:mobile` starts the mobile Metro bundler.

Default ports: web on 3000, backend GraphQL-WS on 8080, Postgres on 5432, Redis on 6379.

The dev database is a prebuilt image (`ghcr.io/boardsesh/boardsesh-dev-db`) that already contains all board data, the `test@boardsesh.com` / `test` user, and seed data. To reset it to a clean state:

```bash
docker compose down -v && vp run db:up
```

### QA notes in the dev drawer

`vp run dev` shows the current git branch in the user drawer during development. To leave notes for whoever tests the branch, create `.boardsesh/qa-notes.md` before you start the server, or pass an explicit file:

```bash
vp run dev -- --qa-notes-file docs/my-qa-notes.md
```

The notes are served only by the dev server, and `.boardsesh/` is git-ignored.

## Contributing to the mobile app (React Native)

The mobile app is `packages/mobile/`, built on Expo SDK 56, React Native 0.85, and Expo Router. The app runs as an Expo dev client: a native shell that loads its JavaScript from a Metro bundler at runtime, so most changes ship as JavaScript without a new native build. The deep-link scheme is `com.boardsesh.app://`.

Start the bundler with `vp run dev:mobile`. Pair it with a device or build using one of the two paths below, depending on how big your change is.

After mobile changes, run the validation sequence:

1. `vp run typecheck:mobile`
2. `vp run test:mobile` (or `vp test run --project mobile`)
3. `vp run check:mobile-bundle` (a headless Metro bundle check that runs on Linux)
4. `vp run check:mobile-simulator` (macOS only; skips elsewhere)

Read [docs/react-native-performance.md](./docs/react-native-performance.md) before touching any list, provider, gesture, or board-art code, and [docs/mobile-sheets-vs-routes.md](./docs/mobile-sheets-vs-routes.md) before adding a screen or sheet.

### Path A: small changes through the OTA channel switcher

For a small fix you can test your pull request on a regular App Store or TestFlight build, with no local build at all. Every pull request that touches React Native code publishes its JavaScript bundle to its own update channel named `pr-<number>` (the `mobile-ota-preview.yml` workflow does this), and a build can switch to that channel at runtime.

To use it:

1. Install a current store or TestFlight build of Boardsesh.
2. Get the `tester` role on your Boardsesh account. Ask a maintainer on Discord; an admin grants it in the admin panel under Roles (admins count as testers automatically).
3. Open More, then Development, then OTA Channel Switcher.
4. Enter `pr-<number>` for the pull request you want. The app pulls that pull request's JavaScript and reloads into it.

To know whether the `pr-<number>` channel will actually work for a pull request, read the OTA compatibility comment it posts. The channel only delivers to a store build when the pull request is JavaScript-only and its native fingerprint matches the store binary. A pull request that changes native code (a new Expo plugin, a native module, an SDK bump) gets a new fingerprint that the store binary can't load, so its channel is skipped and the comment says so. For those, use Path B. The switcher lives at `src/components/ChannelSwitcherScreen.tsx`, with the channel logic in `src/lib/channel-switch.ts`; it shows only when `isTester && !__DEV__ && Updates.isEnabled`. Background: [docs/mobile-ota-updates.md](./docs/mobile-ota-updates.md).

### Path B: larger work through a dev build and the Metro switcher

For larger or native work, build a dev client once and point it at your local Metro bundler. The dev client also gives you fast reloads and an in-app way to jump between Metro servers running in different worktrees.

Build a dev client:

- iOS on a real device: `vp run mobile:dev-client-build` triggers an EAS build of the `development-device` client. Install it on the iPhone you test with.
- iOS locally on a Mac: `vp run mobile:ios` builds and runs through the shared Xcode cache.
- Android locally: from `packages/mobile`, run `bunx expo run:android` to build and install a local dev client.

Then run the bundler with `vp run dev:mobile` and connect the dev client to it. In a dev build, open More, then Development, then Metro Servers (`src/components/DevServerSwitcherScreen.tsx`). It lists Metro bundlers it discovered on local ports and across your Tailscale peers (`src/lib/metro-discovery.ts`), each labeled with its branch, worktree, and commit. Pick one, or add a target by URL (`http://host:port`), and the app reloads its JavaScript from that bundler. The branch and QA notes for the selected bundler show in the dev metadata panel at the top of the More tab (`src/components/DevMetadataPanel.tsx`).

A new dev build is only needed when native dependencies change. JavaScript and TypeScript changes ride the bundler (or, on store builds, the OTA channel from Path A).

### Screenshots

To capture screenshots of the running app:

- `vp run mobile:android-shots` boots an x86_64 emulator (Linux with KVM) and captures against Metro with a cached dev-client APK. Run `vp run mobile:android-doctor` once first to bootstrap the Android SDK and JDK.
- `vp run mobile:ios-shots` does the same on an iOS simulator (macOS only).

These are also available as Claude Code skills (see [AI skills in the repo](#ai-skills-in-the-repo)).

## Develop and test from anywhere with Tailscale

A real phone can't reach `localhost` on your machine, so on-device testing runs over [Tailscale](https://tailscale.com). Sign every machine into the same tailnet and several things start working across it:

- `vp run dev` binds the web server to your machine's MagicDNS name. Look for `[dev] Web URL: http://<your-host>.ts.net:3000` in the output and open that in a mobile browser. Vercel preview URLs (`https://<preview>.boardsesh.com`) work too.
- The mobile Metro switcher (Path B) discovers bundlers running on your tailnet peers, so a dev client on your phone can load JavaScript from Metro on your laptop or a worktree on another machine. `TAILSCALE_HOSTS` overrides discovery; setting it empty short-circuits the probe on cloud builds.
- A bigger machine can host the dev database and smaller laptops reuse it, covered next.

### Sharing a local dev database over Tailscale

If one machine already runs the dev database, other machines can reuse it instead of starting their own Docker:

1. On the host, sign into Tailscale and run `vp run db:up`. The compose stack publishes Postgres and Redis on the host and lets the dev Postgres accept password auth from the tailnet.
2. On the client, sign into the same tailnet and run `vp run dev` or `vp run db:up`. With no local Boardsesh Postgres running, the bootstrap scans online Tailscale peers for a dev database and writes the connection to `.boardsesh/dev-db.env`.
3. Backend and web startup read `.boardsesh/dev-db.env` automatically, so the checked-in `localhost` defaults don't mask the tailnet host.

Local Docker wins when it is already running. To force a specific peer, set `BOARDSESH_DEV_DB_HOST=<tailscale-host-or-ip>` before `vp run db:up`. This is development data on a shared local password, so keep port 5432 behind your firewall and Tailscale access controls.

## Working across git worktrees

The repo is checked out as a bare repo at `.bare/` with one worktree per branch (run `git worktree list` to see them). Each worktree is an independent checkout with its own branch, so you can run several Claude Code agent sessions in parallel, one branch each, without them stepping on each other.

```bash
git worktree add ../my-feature -b feat/my-feature origin/main   # new branch off main
git worktree list                                               # show all worktrees
git worktree prune                                              # clean up stale entries
```

A few things are shared across worktrees so parallel sessions stay fast:

- The dev database. One Docker stack (or one tailnet host) serves every worktree on the machine.
- The iOS Xcode build cache, at `~/Library/Caches/boardsesh/xcode/packages-mobile-ios/build`. Override or isolate it with `BOARDSESH_IOS_BUILD_CACHE_DIR`.

## Backend changes

The backend is `packages/backend/`: a GraphQL-WS server on port 8080, backed by Postgres and Redis (pub/sub for multi-instance party sessions). Backend and server logic belongs here, not in the Next.js app; we are moving REST and server code out of `packages/web` over time.

Run it with `vp run dev:backend` (it starts the database first). Use the structured Winston logger, not `console.*` (a lint rule blocks `console` in backend source). See [docs/logging.md](./docs/logging.md).

Tests run with `vp test run --project backend`. Vitest auto-starts Postgres and Redis from `packages/backend/docker-compose.test.yml`. Set `SKIP_TEST_INFRA=1` to skip the Docker spin-up, or `CI=1` when the caller already provides those services.

## Environment variables

The setup script writes working defaults into each package, so you rarely edit these by hand. The ones below matter when you point an app at a different backend, test OAuth, or run on a device.

Backend, in `packages/backend/.env.development`:

| Variable             | Purpose                                                                             |
| -------------------- | ----------------------------------------------------------------------------------- |
| `PORT`               | Backend port (default 8080).                                                        |
| `DATABASE_URL`       | Postgres connection string.                                                         |
| `REDIS_URL`          | Redis connection string.                                                            |
| `NEXTAUTH_SECRET`    | Session secret. Must match the web app's value.                                     |
| `BACKEND_PUBLIC_URL` | Publicly reachable backend origin. Use your Tailscale URL when testing on a device. |

Web, in `packages/web/.env.local`:

| Variable             | Purpose                                                                        |
| -------------------- | ------------------------------------------------------------------------------ |
| `DATABASE_URL`       | Postgres connection string.                                                    |
| `NEXT_PUBLIC_WS_URL` | Backend WebSocket URL the browser connects to (`ws://localhost:8080/graphql`). |
| `NEXTAUTH_SECRET`    | Must match the backend's value.                                                |

Mobile: copy `packages/mobile/.env.example` to `packages/mobile/.env.development.local` and set these to aim the app at a local or custom backend:

| Variable                  | Purpose                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------- |
| `EXPO_PUBLIC_BACKEND_URL` | GraphQL backend base URL (`http://localhost:8080`, or your Tailscale URL on a device). |
| `EXPO_PUBLIC_WS_URL`      | GraphQL WebSocket URL (`ws://localhost:8080/graphql`).                                 |
| `EXPO_PUBLIC_WEB_URL`     | Web origin for OAuth redirects (`http://localhost:3000`).                              |

Dev infrastructure, set in your shell when needed:

| Variable                        | Purpose                                                                     |
| ------------------------------- | --------------------------------------------------------------------------- |
| `BOARDSESH_DEV_DB_HOST`         | Force a specific Tailscale peer as the dev database host.                   |
| `BOARDSESH_IOS_BUILD_CACHE_DIR` | Override the shared iOS Xcode build cache.                                  |
| `TAILSCALE_HOSTS`               | Override Metro/host discovery; set empty to skip the probe on cloud builds. |

## AI skills in the repo

The repo ships Claude Code skills under `.claude/skills/`. Invoke them as slash commands in Claude Code:

- `android-screenshots` captures the mobile app on an Android emulator, driven against Metro with a cached dev-client APK (Linux/KVM friendly).
- `ios-screenshots` does the same on an iOS simulator (macOS only).
- `posthog-product-health-audit` mines PostHog telemetry with a multi-agent workflow and files deduplicated, severity-labelled GitHub issues.

`CLAUDE.md` and `AGENTS.md` hold the project rules and architecture that agents follow. The Claude Code config in `.claude/` adds a session setup script (`setup.sh`) and the hook that blocks `bun run` / `npx` / `bunx` for validation.

## Testing BLE end-to-end with an ESP32

The Bluetooth code path is the hardest to validate without a real climbing board, so the repo ships firmware that turns a generic ESP32 into a fake Kilter / Tension / Decoy / Touchstone / Grasshopper / MoonBoard. The phone or browser pairs with it like a real board, and every BLE write is forwarded over a WebSocket to a debug page in the web app, which decodes the payload and renders the lit holds. That exercises the same encoder, framing, and protocol logic that runs against real hardware.

Cost is roughly £5 / $5 for the ESP32. Nothing else is needed: no LEDs, no level shifter, no soldering. A generic ESP32 dev board (DevKitC, WROOM-32, WROVER-E, S3 dev kit) works fine.

### One-time setup

1. Install [PlatformIO Core](https://platformio.org/install/cli) (`pip install platformio` or the VS Code extension). The dev environment is `esp32-emulator`, defined in `packages/board-controller/esp32/platformio.ini`.
2. Set Wi-Fi credentials. The first build copies `packages/board-controller/esp32/.env.example` to `.env` automatically. `.env` is git-ignored, so edit it locally:
   ```
   EMULATOR_WIFI_SSID=your-network
   EMULATOR_WIFI_PASS=your-password
   ```
   2.4 GHz networks only (the ESP32 doesn't speak 5 GHz). WPA2 is fine; WPA3 is not yet.
3. Build and flash:
   ```bash
   cd packages/board-controller/esp32
   pio run -e esp32-emulator -t upload
   ```
   If `esptool` reports "Unable to verify flash chip connection" (some boards lack the auto-reset circuit), hold the BOOT button while the upload starts.
4. Confirm the firmware came up. Tail the serial log:
   ```bash
   pio device monitor --baud 115200
   ```
   You should see something like:
   ```
   [WiFi] Connected. IP: 192.168.20.38
   [BLE] Advertising as: Kilter Board#751737@3
   [WS] Listening on port 81
   ```
   Note the IP; the web UI needs it.

### Use it from the web app

> The debug page only works from `http://localhost:3000`. It opens a plain `ws://<esp32-ip>:81` socket, and browsers block plain WebSockets from HTTPS origins as mixed content. Vercel preview URLs and other `https://` origins load the page but the sockets silently fail. Use a local dev server.

1. Run `vp run dev` and open `http://localhost:3000`.
2. Click your avatar (top-left), then Development. The menu entry only appears in development builds.
3. Click the + tab and fill in:
   - IP address: the one the firmware printed.
   - Board / Layout / Size / Hold sets / Angle: the same cascading dropdowns as the Custom Board flow. Pick whichever board you're testing.
   - Serial / API level: any value; they only affect the BLE advertised name (for example `Tension Board#480221@3`).
4. Save. The tab opens a WebSocket to the ESP32 and pushes your config so it re-advertises with the right protocol and name.
5. From the phone or browser, open Boardsesh's BLE picker, pair with the advertised device, queue a climb, and send to board. The development tab decodes the BLE payload and renders the holds in real time.

You can keep several ESP32s connected at once. Each gets its own tab, sockets stay open in the background, and switching the active tab doesn't drop the others.

### What it can test

- Aurora API v2 and v3 framing (`Q`/`R`/`S`/`T` and `M`/`N`/`O`/`P` command bytes), single- and multi-packet sequences, position and colour encoding, and v2 power-budget scaling.
- MoonBoard ASCII protocol (`l#S0,P35,E197#`) including chunked writes that span multiple BLE packets.
- Reconnect and disconnect handling, stale advertising name caching, and multi-board sessions.

It does not simulate LED hardware response timing, board-side errors, or the GATT side-channels Aurora uses for things like firmware updates. For those you still need a real board.

### Troubleshooting

- Device doesn't show up in the BLE picker after switching board type. iOS and macOS cache scan results; toggle Bluetooth off and on on the phone. The firmware force-disconnects the central on a config change, but the OS-level scanner cache is independent.
- No serial output after flashing. Press the EN/RST button to reset; some adapters don't auto-reset reliably.
- Wi-Fi never connects. Re-check the SSID and password in `.env`. Boot logs print `[WiFi] Reason: 202 - AUTH_FAIL` on a bad password and `[WiFi] EMULATOR_WIFI_SSID empty` if the build script didn't pick up your `.env`.
- Flashing fails at 921600 baud. Some WROVER-E modules can't sustain it. The emulator env already drops to 460800; if yours still fails, lower it further with `upload_speed = 230400` in `platformio.ini`.

## Keeping local data up to date

### Shared data sync (public climbs)

With your server running, trigger a shared sync by visiting:

- Kilter: [http://localhost:3000/api/internal/shared-sync/kilter](http://localhost:3000/api/internal/shared-sync/kilter)
- Tension: [http://localhost:3000/api/internal/shared-sync/tension](http://localhost:3000/api/internal/shared-sync/tension)

This pulls the latest climbs, climb stats, beta links, and other data from Aurora's servers.

### Aurora user data sync (one-way only)

Aurora user data sync is one-way (Aurora to Boardsesh). When you link your Aurora account in the app settings:

- Your Aurora data (logbook, ascents, climbs) imports to Boardsesh.
- Data syncs immediately on first link.
- A background sync runs every 6 hours.
- Data you create in Boardsesh stays local and does not sync back to Aurora.

This is a limitation of Aurora's API, not a choice on our side.

## Opening a pull request

1. Branch off `main` (or work in a worktree). Make your change and run `vp check` and `vp run typecheck`. The pre-commit hook runs `vp check --fix` for you.
2. Open a pull request against `main`. Fill in the Release Notes section from the template, written for climbers (what they get, not what the code does). Internal-only changes (refactor, CI, deps, tests) get `none`.
3. CI runs lint, typecheck, tests, and the mobile checks. Keep iterating until it's green.

The project rules and architecture agents follow are in `CLAUDE.md`, which is useful reading for humans too.

## Self-hosting

Official self-hosting support is planned but still involved to set up. For now the development setup above is the path: it's a standard Next.js app with Postgres. Contributions here are welcome.

## Thanks

This app started as a fork of [Climbdex](https://github.com/lemeryfertitta/Climbdex), and we use [BoardLib](https://github.com/lemeryfertitta/BoardLib) to build the database. Thanks to @lemeryfertitta for making this project possible.
