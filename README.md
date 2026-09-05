# Boardsesh

**Track, Train, and Climb Together**

A centralized hub for all your LED climbing board training.

Try it out at [boardsesh.com](https://www.boardsesh.com/) | [Join us on Discord](https://discord.gg/YXA8GsXfQK) | [Sponsor us](https://github.com/sponsors/boardsesh)

## Our Vision

LED climbing boards like Kilter, Tension, MoonBoard, Decoy, and Grasshopper have revolutionized indoor training. We believe the climbing community deserves a centralized platform that brings all these boards together—making it easier to track progress, train with friends, and get the most out of your board.

Boardsesh is a unified experience that works across different board types, helping you focus on what matters most—climbing.

## What Boardsesh Offers

- **Queue management** — Coordinate climbs when training with others
- **Real-time collaboration** — Share sessions with friends via Party Mode
- **Multi-board support** — Works with Kilter, Tension, and more
- **Active development** — New features and improvements from the community
- **Self-hosting option** — Run your own instance if you prefer

## Open Source

Boardsesh is free and open source, and self-hosting will always be an option. The product core (the apps, the backend and sync services, the Aura board renderer, and the rest of the product logic) is under the GNU Affero General Public License v3.0 or later: if you distribute a modified Boardsesh, or run one for other people over a network, you make your modified source available to them. The interoperability infrastructure (the public API schema and clients, the board catalogue and protocol definitions, the Bluetooth libraries and the controller firmware) stays under the Apache License 2.0 so integrations and independent hardware can build on it freely. [`LICENSING.md`](./LICENSING.md) draws the exact boundary and records that every release before the transition remains under Apache-2.0. You can view the code, contribute features, report bugs, or fork it entirely to run your own instance.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup instructions and [ROADMAP.md](./ROADMAP.md) for what's coming next.

## API Documentation

Building something cool with climbing data? We provide a public API that developers can use to access climb information and build their own integrations. [Explore the API Documentation →](https://www.boardsesh.com/docs)

## Support Boardsesh

When the official Kilter app suddenly disappeared, it became clear why an open-source alternative needs to exist. Aurora's backend shutdown left climbers without access to their playlists, logbooks, and draft climbs — a single-vendor risk we're working to eliminate.

Boardsesh is free, open source, and always will be. But running it costs real money — hosting, database, and infrastructure bills add up, especially as more climbers join. We promise not to enshittify Boardsesh, and self-hosting will always be an option.

If you find Boardsesh useful and can spare it, sponsorship helps us keep the lights on:

[![Sponsor Boardsesh](https://img.shields.io/badge/Sponsor-Boardsesh-ea4aaa?logo=github-sponsors&style=for-the-badge)](https://github.com/sponsors/boardsesh)

## Thanks

Most Boardsesh updates reach your phone without an app store release, and that's down to [xprem](https://github.com/mercuretechnologies/xprem) — the self-hosted Expo OTA update server built by [Mercure Technologies](https://github.com/mercuretechnologies), who gave Boardsesh an enterprise license for it.

Between mid-June and late August 2026 we shipped 552 user-facing changes to the mobile app, and only 64 of them needed a new App Store or Play build. xprem also runs our per-PR preview channels, so anyone on a store build can switch to a pull request's bundle from What's New and tell us whether it works before it merges.

## Join the Community

We're always looking to collaborate with climbers, developers, and anyone passionate about improving the board climbing experience. Whether you want to contribute code, suggest features, or just say hello—we'd love to hear from you.

---

_Together, we can build the best training companion for board climbers everywhere._
