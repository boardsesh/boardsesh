# Boardsesh Roadmap

The live, up-to-date roadmap is on GitHub Projects:

**[github.com/orgs/boardsesh/projects/3](https://github.com/orgs/boardsesh/projects/3)**

The board is public — no GitHub login needed to read it.

## How we plan

Every issue is in one of four columns:

- **Now** — actively being worked on. PRs landing this week or next.
- **Next** — queued for the next month or two.
- **Later** — wanted, scoped, but not scheduled. New issues land here by default.
- **Done** — recently shipped. Items sit here for a while before getting archived.

Anyone can [open an issue](https://github.com/boardsesh/boardsesh/issues/new). It will land in **Later** automatically; we'll triage it onto **Next** or **Now** as we plan.

## Big initiatives

Multi-issue features get an `Initiative` tag on the board so you can filter the roadmap to one theme. They also get a **tracking issue** that lists every sub-issue in the order they should land — see [#1773](https://github.com/boardsesh/boardsesh/issues/1773) for the canonical example.

Initiatives that are big enough to ship in **phases** also get one [milestone](https://github.com/boardsesh/boardsesh/milestones) per phase, so you can see progress per checkpoint. Initiatives that ship as a single deliverable get a single milestone.

Current initiatives:

- **Recently Climbed & Display Mode** — gym TV kiosk + recent-climbs feed. Tracking issue [#1773](https://github.com/boardsesh/boardsesh/issues/1773) · [design doc](docs/recently-climbed-display-mode.md) · [board filter](https://github.com/orgs/boardsesh/projects/3/views/1?filterQuery=initiative%3A%22Display+Mode%22) · [milestone](https://github.com/boardsesh/boardsesh/milestone/10)
- **Mobile app** — native iOS/Android app, shipped as a React Native rewrite (`packages/mobile/`) that replaced the earlier Capacitor build, plus the offline-first refactor (vite migration, refdata, mutation queue). [docs/mobile-app-plan.md](docs/mobile-app-plan.md), [docs/ios-app-store-publishing-plan.md](docs/ios-app-store-publishing-plan.md) · [board filter](https://github.com/orgs/boardsesh/projects/3/views/1?filterQuery=initiative%3A%22Mobile+app%22) · phase milestones [0a Hosting](https://github.com/boardsesh/boardsesh/milestone/1) · [0b GraphQL](https://github.com/boardsesh/boardsesh/milestone/2) · [0c Auth](https://github.com/boardsesh/boardsesh/milestone/3) · [1 Vite migration](https://github.com/boardsesh/boardsesh/milestone/4) · [2 Capacitor bundle](https://github.com/boardsesh/boardsesh/milestone/5) · [3 Refdata SQLite](https://github.com/boardsesh/boardsesh/milestone/6) · [4 User cache](https://github.com/boardsesh/boardsesh/milestone/7) · [5 Mutation queue](https://github.com/boardsesh/boardsesh/milestone/8) · [6 Polish](https://github.com/boardsesh/boardsesh/milestone/9)
- **MoonBoard support** — feature parity with Kilter/Tension. [board filter](https://github.com/orgs/boardsesh/projects/3/views/1?filterQuery=initiative%3A%22MoonBoard+support%22)
- **BLE / device picker** — Bluetooth UX, mismatch handling, [ESP32 emulator](CONTRIBUTING.md#testing-ble-end-to-end-with-an-esp32). [board filter](https://github.com/orgs/boardsesh/projects/3/views/1?filterQuery=initiative%3A%22BLE+%2F+device+picker%22)
- **OG smartlinks & SEO** — [docs/og-smartlinks-roadmap.md](docs/og-smartlinks-roadmap.md) · [board filter](https://github.com/orgs/boardsesh/projects/3/views/1?filterQuery=initiative%3A%22OG+smartlinks+%26+SEO%22)
- **Aurora migration** — decoupling from the Aurora API. [docs/aurora-sync.md](docs/aurora-sync.md)

A new initiative gets its own `Initiative` tag on the board once it has a tracking issue and a design doc under `docs/`.

## Want to help?

Issues tagged [`good first issue`](https://github.com/boardsesh/boardsesh/labels/good%20first%20issue) and [`help wanted`](https://github.com/boardsesh/boardsesh/labels/help%20wanted) are the easiest places to start. Drop into [Discord](https://discord.gg/YXA8GsXfQK) if you want to claim one — we'll make sure no one else is already on it and answer any setup questions.
