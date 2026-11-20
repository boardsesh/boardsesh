# Mobile view stories

Screenshots render the same prop-driven view components as the app, with fixed data supplied by a story. Production screen containers own authentication, queries, pagination, mutations and navigation. Keep fixture data, forced states and capture parameters out of those containers.

## Open a story

```sh
vp run mobile:ios-shots -- --story climbs--populated --theme dark --shutdown
vp run mobile:android-shots -- --story climbs--populated --variant material --shutdown
```

These commands boot Metro with `EXPO_PUBLIC_STORY_MODE=1`. The root chooses the story application before importing the production application. It mounts fonts, translation, theme, safe areas, gestures, native navigation and sheet/dialog infrastructure. It does **not** mount authentication, database, queries, sync, queues, BLE or network providers. Appearance changes are in memory and do not update user preferences.

The route `dev/stories/<id>` also selects that isolated root in a dev bundle. For a fresh capture, use the commands above so the production root cannot initialize before the router resolves the link. A production bundle does not load story modules.

Native deep links to `dev/stories` and its internal `dev/story-tabs` routes bypass application consent deferral in dev bundles. The isolated root has no application consent flow to settle; ordinary app links and production bundles retain that gate.

Visual capture runners preserve `--render-mode aura|classic|default` in the story deep link. Ad hoc links can use `?renderMode=classic`; the default is Aura. Requested Aura captures wait for renderer capability and fail if the installed binary would fall back to classic.

Story IDs are `<filename>--<key>`, kebab-cased: `Climbs.stories.tsx` with `populated` becomes `climbs--populated`. A bare filename ID selects its first declared story. The index at `dev/stories` lists all stories. Only the requested module is evaluated for a direct story link.

| Parameter | Values | Behavior |
| --- | --- | --- |
| `theme` | `dark`, `light`, `system` | In-memory theme |
| `variant` | `liquidGlass`, `material`, `auto` | Native presentation variant |
| `locale` | Supported app locale | In-memory translation instance |
| `shot` | Unique nonce | Remounts the story and its readiness checks |

## Write a story

Place `<Name>.stories.tsx` next to the view. Metro discovers these files automatically.

```tsx
import type { StoryModule } from '../../dev/stories/types';
import { ClimbsView } from './ClimbsView';
import { populatedClimbsProps } from '../../dev/fixtures/climbs';

const stories: StoryModule = {
  title: 'Climbs',
  stories: {
    populated: {
      name: 'Popular climbs',
      layout: 'fullscreen',
      tab: 'climbs',
      render: () => <ClimbsView {...populatedClimbsProps} />,
    },
  },
};
export default stories;
```

Set `tab` on fullscreen tab stories to mount the production tab navigator, native headers, tablet rail and foldable split shell. The public story URL redirects internally while retaining its story ID and capture readiness.

Retain the production screen’s content wrappers as well as its chrome: climb lists apply `useHorizontalSafeArea` to their clip bounds, Profile uses `ReadableColumn`, and Session pads its tab content before marking `HorizontalSafeAreaApplied`. The player scene applies the same measured `playContentSideInsets` route policy as the live player. Shared session-detail presentation bounds its list header and rows together and marks that subtree inset; overlays remain outside those bounds. Native iPad sidebars and the Duo rail can otherwise cover successfully rendered content. Inspect the raw capture as well as the readiness result; asset readiness does not prove that navigation chrome leaves those assets visible.

Use ordinary props and local state for interactions. A view can read theme, translations and layout; it must not require fake auth/query/board providers. Extract shared chrome into a view with explicit props too. Fixtures belong under `src/dev/fixtures` or in the story module, never in the production screen.

## Capture readiness

The harness waits for native layout and two animation frames before reporting readiness. Stories with board artwork, images, opening sheets or asynchronously prepared view state must set `readiness: 'explicit'` and call the supplied `onReady` only after that content is ready. Pass `onError` to required asset loading so a missing image fails the capture.

```tsx
render: ({ onReady, onError }) => (
  <BoardStory onAssetsReady={onReady} onAssetError={onError} />
),
readiness: 'explicit',
```

Metro emits `[stories] root ready`, `[stories] ready <id>`, `[stories] missing <id>` or `[stories] error <id> <reason>`. Capture scripts fail on errors, unknown IDs, missing logs and readiness timeouts. They do not save an image after an unverified fixed delay. iOS visual captures observe both Metro and the continuous native JavaScript log because Metro console forwarding can omit a ready message. Each launch/navigation takes fresh byte offsets; native events must also have an original event timestamp at or after that boundary, excluding buffered old-process messages. Relaunch boundaries are taken after successful termination. Errors from either stream still fail the capture.

For iPhone Duo hinge failures, the capture debug artifact retains the latest image from each display and a `probes.jsonl` log with capture and conversion errors. Startup diagnostics also retain the hinge log before installation can fail (including C-only library-entry process names/PIDs before its C-only SpringBoard guard) and `startup.jsonl` stage timings, command exit status, signal, error code and output-presence flags without environment values. Cleanup failures trigger diagnostic-only `launchctl getenv` reads of both owned names and a unique never-set control (15 seconds each); these records do not infer absence from an exit code or turn a failed cleanup into success. Failed display reads are unknown, not proof of a dark screen; the runner waits for a known pose before toggling the hinge.

The instrumented Duo run `43902351703` showed the hinge library entering `launchctl` in both failed attempts. After the timed-out first cleanup, `getenv DYLD_INSERT_LIBRARIES` returned nonempty output while the cleared log key and never-set control returned empty output (all exit 0). The constructor now rejects non-SpringBoard processes with exact `getprogname()`/`strcmp` before calling Foundation. Injection and failed removal are observed; Foundation initialization as the timeout cause remains a hypothesis until native validation. Cleanup failures remain fatal.

Before an immutable iOS story or integration-smoke Metro session starts, the runner resolves the current iOS runtime version once with the capture environment (bounded to 120 seconds). It passes that exact value through the existing runtime override to avoid recalculating the fingerprint for each manifest request. Existing nonempty overrides are preserved; resolver failures stop capture. Native builds, OTA publishing, Android captures and watched development servers are unchanged.

iOS capture and probe jobs allow 90 minutes for the complete shard, including the existing bounded cold-boot retry. In run `43867676396`, the first Pro Max attempt spent 22 minutes booting and exhausting launch retries; the second recovered and captured 13 stories between 13:47 and 14:07 UTC before the old 60-minute job limit interrupted it. The larger job budget leaves time for the remaining captures and artifact upload; individual boot, launch and story readiness deadlines are unchanged.

`mobile:screenshots` uses the same isolated root for visual store/help captures. `scripts/lib/mobile-visual-stories.ts` maps established capture filenames to explicit stories, preserving the device and locale output directories. Board-family stories must use that board's real fixture geometry; a missing family must fail instead of substituting Kilter artwork.

CPP captures write a `cpp-capture.json` sidecar with `kind: "view-stories"`. It binds the source checkout, exact story/board inventory, locale, device, appearance, and raw PNG hashes. Framing carries that metadata into `presentation.json`; publication checks both sidecars against the current sources and pixels. These fixtures do not claim a verified backend recording. Existing recorded captures keep their separate snapshot provenance and checks. Native Live Activity presentation sources retain their native fixture validation.

## Integration smoke remains separate

The `smoke` flow opens the real Home, Profile and Climbs screens and the real play drawer against recorded backend responses. `src/dev/integration` owns dev-only login/bootstrap and content reporting. A generic `ContentRenderObserverProvider` observes markers mounted inside rendered content; production defaults to no observer. Tests must not emit success merely because a query returned rows.

The integration bootstrap uses public auth APIs, ordinary test-device preferences and a consent boundary before the production root loads. Theme and locale are injected through provider props. Smoke board setup selects exactly one recorded owned board through the ordinary activation action. Integration video recorders separately inject a simulator transport before app startup and use real board, query, queue and session actions; they do not seed provider state or fake backend responses. Production components do not read capture environment variables. Missing recorded responses remain smoke failures. View stories do not prove authentication, backend, pagination, sync, BLE or native Live Activity behavior. Simulator video transport proves encoded application writes and session interactions, not physical radio or LED behavior.

Layout measurement uses the generic `LayoutObserverProvider`. Without an observer, anchors are inert and add no wrapper. Story and integration roots install the dev reporter, which retains the `[showcase-anchor]` geometry protocol used by showcase video recording.

## Checks

Run `vp run typecheck:mobile`, `vp run test:mobile` and `vp run check:mobile-bundle`. The production-exclusion checks ensure app imports enter through dev-gated loaders and the exported bundle contains no story registry/readiness sentinels. Native screenshots still require a simulator or emulator; Linux bundle checks do not prove a screen painted on-device.
