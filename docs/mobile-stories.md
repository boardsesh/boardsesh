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

Stories only exist in a dev bundle (the simulator dev client, `vp run dev:mobile`). A store
build or OTA update sends `dev/stories/*` home.

## Story ids

`<file>--<key>`, kebab-cased. In `CrewBrowse.stories.tsx`, the key `crewFlagOn` is
`crew-browse--crew-flag-on`. A bare file id (`crew-browse`) opens that file's first story. Two
stories with the same id fail at load, naming both files.

`dev/stories/reset` clears scenario overrides and goes back to the index.

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
  They are cleared when the story unmounts.
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
| `queue.sessionId`        | `useQueueSessionId()` and `useQueueSessionControls()`       |
| `queue.sessionUsers`     | The roster in `useQueueLiveStats()`                          |

The fake session id exists only on the phone. Anything that sends it to the server fails, so
judge the screen, not the network calls behind it.

To fake something new, add a field to `ScenarioOverrides` and patch its context in
`DevScenarioOverrides.tsx`. That provider sits inside `MobileBoardPresenceProvider`, below the
queue and presence providers, so it can patch either.

Scenario overrides stay on after the story navigates away. They clear when another story
replaces them, on `dev/stories/reset`, on the index's reset row, or on a reload.

## How it stays out of production

`packages/mobile/src/dev/stories/load.ts` is the only door. The story screens, the registry and
every story file are loaded through a `require` behind `__DEV__`, which Metro folds to `false`
in a production bundle before it collects dependencies. Two checks hold this:

- `story-harness-prod-exclusion.test.ts`: app code imports the harness only through `load.ts`,
  and every `require` there sits behind `__DEV__`.
- `vp run check:mobile-bundle`: exports both platforms and fails if `[stories] ready` is in the
  bundle.

The one piece that ships is `DevScenarioOverrides`, which production swaps for a pass-through.

## Log lines

The story screens log through Metro, which is how the shots scripts know when to capture:

- `[stories] ready <id>`: a component story has painted.
- `[stories] scenario <id> -> <route>`: a scenario applied its overrides and navigated.
- `[stories] missing <id> (did you mean …)`: no such story.
- `[stories] scenario overrides {…}` / `cleared`: the override store changed.
