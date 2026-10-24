# Mobile stories

A dev-only harness for the React Native app (`packages/mobile`), in the spirit of Storybook.
A story is one screen state you can open by id, screenshot in about two seconds, and edit with
hot reload. It exists so an agent (or you) can check a UI change without logging in, starting
a session or finding a second phone.

Storybook for React Native was ruled out: `@storybook/react-native` needs
`@gorhom/bottom-sheet` as a peer, which is banned from the native app (#3167).

## Two kinds of story

**Component story.** Draws a component at `dev/stories/<id>`, inside the real app's providers
(theme, i18n, query client, board, presence). Use it for UI whose states are cheap to build
from props: a pill, a callout, a commit row. One story can lay every state out on one screen
with `StoryVariant`, so one screenshot shows them all.

**Scenario story.** Fakes a few live values on top of the real app, then opens a real route.
Use it for whole screens whose state is hard to reach by hand. `crew-browse--crew-flag-on`
pretends a second climber is in your session and opens the real play drawer, so you see the
crew browse mode without a crew.

## Open a story

The route is `dev/stories/<id>`; the index of every story is `dev/stories`.

```bash
# Boot once, in the background. Pick a free port: other sessions usually hold 8081.
BOARDSESH_METRO_PORT=8091 SCREENSHOT_USER_PASSWORD=<prod test pw> vp run mobile:ios-shots

# Shoot a story. It waits for the story's ready line instead of a fixed sleep.
BOARDSESH_METRO_PORT=8091 vp run mobile:ios-shots -- screenshot --story crew-browse--pills
BOARDSESH_METRO_PORT=8091 vp run mobile:ios-shots -- screenshot --story crew-browse--pills --theme light
BOARDSESH_METRO_PORT=8091 vp run mobile:ios-shots -- screenshot --story crew-browse--crew-flag-on
```

The Android tool takes the same `--story`, `--theme` and `--variant` flags. Details on ports,
the `.app` copy and the Metro log: `docs/ios-simulator-screenshots.md`.

Query parameters on the route:

| Parameter | Values                           | Effect                                                       |
| --------- | -------------------------------- | ------------------------------------------------------------ |
| `theme`   | `dark`, `light`, `system`        | Switches the whole app, like Settings. Persists on the sim.  |
| `variant` | `liquidGlass`, `material`, `auto` | The Material look on iOS, for checking Android parity.      |
| `shot`    | any value                        | A new value re-logs the ready line of the story on screen.   |

The shots scripts add `shot=<timestamp>` to every `--story` capture, so shooting the story
already on screen again (after an edit, or with another `--theme`) still gets a fresh
`[stories] ready` line instead of waiting out the 15 s timeout.

Only the focused story applies its `theme` and `variant` parameters. Earlier story routes can
stay mounted in the navigation stack; they stop writing appearance preferences while blurred,
so opening a dark Material story after a light Liquid Glass story settles on the new choice.
Focused parameter or preference changes are checked again, and returning to an earlier story
reapplies its parameters. Leaving a story keeps the current appearance; blur does not reset it.
Missing or invalid parameters leave that preference alone, and matching preferences avoid a write.

Stories only exist in a dev bundle (the simulator dev client, `vp run dev:mobile`). A store
build or OTA update sends `dev/stories/*` home.

## Story ids

`<file>--<key>`, kebab-cased. In `CrewBrowse.stories.tsx`, the key `crewFlagOn` is
`crew-browse--crew-flag-on`. A bare file id (`crew-browse`) opens the story declared first in
that file; the index lists stories sorted by id. Two stories with the same id fail at load,
naming both files.

`dev/stories/reset` clears scenario overrides, goes back to the index and logs
`[stories] ready reset`.

## Write a story

Put `<Name>.stories.tsx` next to the component. Every such file under `packages/mobile/src` is
found automatically; there is no list to update.

```tsx
import type { StoryModule } from '../../dev/stories/types';
import { StorySurface, StoryVariant } from '../../dev/stories/StoryCanvas';

const stories: StoryModule = {
  title: 'Play drawer / Crew browse',
  stories: {
    pills: {
      name: 'Wall-state pill, every state',
      render: () => (
        <>
          <StoryVariant label="browsing">
            <StorySurface>
              <WallStatePill state="browsing" onPress={() => {}} />
            </StorySurface>
          </StoryVariant>
        </>
      ),
    },
    crewFlagOn: {
      name: 'Real drawer, crew of two',
      overrides: { queue: { isSharedSession: true, sessionId: 'story-crew-session' } },
      route: '/climbs?screenshotOpenFirst=1',
    },
  },
};

export default stories;
```

- `render` runs inside the real providers, so hooks like `useTheme` and `useTranslation` work.
- `layout: 'fullscreen'` drops the caption and padding.
- A component story can take `overrides` too, for a component that reads them from context.
  They go on when the story comes into focus and come off when it leaves, unless a newer story
  has replaced them by then. A component story without `overrides` clears any scenario's, so a
  component draws the same whatever you opened before it.
- A scenario's `route` can carry the screenshot-mode params
  (`climbs?screenshotOpenFirst=1`, `?screenshotOpenPreview=1`); see
  `packages/mobile/src/lib/screenshot-mode.ts`. Run Metro in screenshot mode
  (`mobile:ios-shots` does) so the onboarding, consent and QA gates stay out of the way.

## Scenario overrides

`ScenarioOverrides` (`packages/mobile/src/dev/stories/scenario-overrides.ts`) is the list of
live values a story can fake. Each field patches one context value the real provider computes;
anything left out keeps the real value.

| Field                    | Patches                                                      |
| ------------------------ | ------------------------------------------------------------ |
| `queue.isSharedSession`  | `useIsSharedSession()`: whether gestures browse first (#4281) |
| `queue.isCrewSession`    | `useIsCrewSession()`: whether only the wall holder's rest timer may move the wall. Follows `isSharedSession` when left out |
| `queue.sessionId`        | `useQueueSessionId()` and `useQueueSessionControls()`       |
| `queue.sessionUsers`     | The roster in `useQueueLiveStats()`, and `sessionMemberUserIds` in `useQueueSessionControls()` (from each member's `userId`) |

Some readers keep the real session, so judge what they draw from the real app:

| Reader                                   | Why it isn't patched                                         |
| ---------------------------------------- | ------------------------------------------------------------ |
| `BluetoothProvider` (`useQueue()`)       | Reads the full `QueueContext`, which is left alone on purpose |
| `QueueBottomAccessory` (`useQueue()`)    | Same: the persistent queue bar shows the real session        |
| `LiveActivityBridge` (`useQueue()`)      | Same: patching it would start a Live Activity under a fake id |
| `BoardAdapterWrapper`                    | Sits above `DevScenarioOverrides`; ticks go to the real session |

The fake session id exists only on the phone. Anything that sends it to the server fails, so
judge the screen, not the network calls behind it.

To fake something new, add a field to `ScenarioOverrides` and patch its context in
`DevScenarioOverrides.tsx`. That provider sits inside `MobileBoardPresenceProvider`, below the
queue and presence providers, so it can patch either.

Scenario overrides stay on after the story navigates away. They clear when another story
replaces them (a scenario, or a component story with or without `overrides`), on
`dev/stories/reset`, on the index's reset row, or on a reload. Opening the index alone leaves
them on.

## How it stays out of production

`packages/mobile/src/dev/stories/load.ts` is the only door. The story screens, the registry and
every story file are loaded through a `require` behind `__DEV__`, which Metro folds to `false`
in a production bundle before it collects dependencies. Two checks hold this:

- `story-harness-prod-exclusion.test.ts`: app code imports the harness only through `load.ts`
  (a type-only `import type` is fine, judged per statement), never imports a `*.stories` file,
  and every `require` in `load.ts` sits behind `__DEV__`.
- `vp run check:mobile-bundle`: exports both platforms and fails if `[stories] ready` (the story
  screens) or `[stories] registry` (the registry, which pulls in every story file) is in the
  bundle.

The one piece that ships is `DevScenarioOverrides`, which production swaps for a pass-through.

## Log lines

The story screens log through Metro, which is how the shots scripts know when to capture:

- `[stories] ready <id>`: a component story has painted. `dev/stories/reset` logs
  `[stories] ready reset`.
- `[stories] registry <n> stories`: the registry loaded (once per bundle).
- `[stories] scenario <id> -> <route>`: a scenario applied its overrides and navigated.
- `[stories] missing <id> (did you mean …)`: no such story.
- `[stories] scenario overrides {…}` / `cleared`: the override store changed.
