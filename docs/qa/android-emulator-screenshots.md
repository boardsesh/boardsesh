# Android screenshots

Use isolated view stories for deterministic captures:

```sh
vp run mobile:android-shots -- --story climbs--populated --theme dark --shutdown
vp run mobile:android-shots -- --story player--lit --shutdown
```

The story root loads presentation providers and injected fixture props. It does not start authentication, SQLite, sync, BLE or backend queries. Capture waits for layout and required assets. A missing story, render failure or readiness timeout fails the command.

`--story` accepts the IDs listed at `dev/stories`. `--theme` accepts `dark`, `light` or `system`; `--variant` accepts `liquidGlass`, `material` or `auto`. Use `navigate --story <id>` with an existing capture session, or `screenshot --story <id>` to save a still from it. `--shutdown` closes the capture device after the run.

Legacy `--to board-view`, `board-sheet`, `session-detail`, `logbook` and `progress` aliases now select their view stories. Raw `screenshot*` query commands are rejected. Ordinary `--to` application routes remain available for manual integration inspection and use real application state.

For complete store/help/CPP captures use `vp run mobile:screenshots -- --flow <flow>`. The main runner preserves established device, locale and filename recipes while selecting isolated stories. Run `--flow smoke` separately to exercise real screens against recorded backend responses.

Production screenshot-driving hooks have been removed. Showcase and tutorial video recorders retain live integration behavior through dev-only transport injection and real application controls. Native Live Activity captures still use the actual system API through the isolated dev setup.

See [Mobile view stories](../mobile/mobile-stories.md), [recorded fixtures](mobile-screenshot-fixtures.md) and [the integration gate](mobile-e2e-gate.md).
