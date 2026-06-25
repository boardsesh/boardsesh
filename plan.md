# PlayDrawer → full-screen route refactor (continue here)

Branch: `mobile/remove-gorhom-bottom-sheet` · Worktree: `/Users/marcodejongh/Projects/github/boardsesh/spike-expo-sheet` · Tracks #3167.
Delete this file when the route refactor lands.

## What's already done (committed on this branch)

1. **`@gorhom/bottom-sheet` fully removed** from `packages/mobile`; every sheet migrated to Expo's native drop-in `@expo/ui/community/bottom-sheet` (added `@expo/ui@~56.0.18`). Deleted the `SheetBackdrop` fork + `GlassSheetBackground`; removed the gorhom dep from `package.json`/`bun.lock`.
2. **Shared wrappers reworked** — `Sheet.tsx` / `ModalSheet.tsx`: native sheet + content-pinned `KeyboardAvoidingView` footer (replaces gorhom's `BottomSheetFooter`).
3. **change-board freeze fixed** — `UserDrawerProvider` defers modal-route pushes until the drawer `Modal` unmounts (`pendingNavRef`).
4. **Full-screen PlayDrawer (overlay approach)** — `PlayDrawerOverlay` (FullWindowOverlay iOS / transparent Modal Android + reanimated slide + edge-to-edge `GlassSurface`) + interactive drag-to-dismiss. Renders edge-to-edge, glass, top-aligned, with the below-fold peek. **VERIFIED on iOS sim.**

Gates green: `vp run typecheck:mobile`, `vp run test:mobile` (346 files / 2573 tests), `vp check` on changed files.

## The bug that forces this refactor

The full-screen PlayDrawer is a `FullWindowOverlay` (separate, higher-level UIWindow). Native `@expo/ui` sheets + the native share sheet present off the **main** window's VC, which is **below** the overlay window — so **everything opened from the player (beta sheet, queue sheet, share) renders BEHIND it.** gorhom used to give all these a **shared modal stack**; native sheets have none.

Only other `FullWindowOverlay`s stack above the player (that's why `ClimbReactionMenu`/long-press climb-actions still work).

## Chosen fix: PlayDrawer as a `fullScreenModal` expo-router route

Make the player a real top-of-stack modal VC. Anything presented **from within its React tree** (sub-drawers, queue, share) presents off the player's VC and stacks above naturally; it still covers the tab bar.

**By construction this fixes 5 of the 6 reported breakages** — the sub-drawers (LogAscent, AngleSelector, ClimbActions, AddBetaVideo) and the native share are already rendered _inside_ `PlayDrawer`, so as route content they stack above. **Only `QueueSheet` needs extra handling** (see Wrinkle).

### Implementation steps

1. **New route** `packages/mobile/app/play.tsx` → renders the player content (a `PlayDrawerRouteContent`). Register in `packages/mobile/app/_layout.tsx` Stack (model it on the existing `onboarding` screen ~line 412): `options={{ presentation: 'fullScreenModal', headerShown: false, animation: 'slide_from_bottom', gestureEnabled: true }}`. The native modal presentation gives the slide + drag-to-dismiss, so `PlayDrawerOverlay`'s portal/slide is no longer needed (keep its `GlassSurface` background recipe — see step 5).

2. **Open = navigate + target store.** `openPlayDrawer(climb, options)` in `drawer-host-provider.tsx` (~line 245) currently calls `playDrawerRef.current?.open(...)`. Change it to: stash `{climb, options}` in a drawer-host ref/state (a "pending play target") **and** `router.navigate('/play')`. The route reads the target on mount and runs the existing `openDrawer(...)` body. Keep the `useDeferredSheetOpen` race guard — but note the dismiss signal is now `router` unmount, not a sheet animation (see step 4). All `openPlayDrawer` call sites (climbs/[climbUuid].tsx, home/index.tsx, use-climb-actions.ts, queue/board-sheet handlers) keep calling the same context method — no change.

3. **Props → context.** `PlayDrawer` currently takes `boardConfig`, `onAngleChange`, `isAngleAdjustable`, `onOpenQueue`, `onSwitchBoard`, `onOpenClimbActions`, `boardMismatch`, `mismatchBoardLabel` as PROPS from drawer-host (drawer-host-provider.tsx ~line 601). A route can't receive these as props — add them to `DrawerHostContext` value (it already exposes `openQueueSheet`, `openClimbActions`, etc.) and have the route read them via `useDrawerHost()`. Watch the documented require-cycle reason these were props — keep PlayDrawer out of the cycle (read via the context hook, don't import drawer-host directly for types).

4. **Close = router dismiss.** Replace `runCloseAnimation()` / `progress` slide with `router.dismiss()` (or `router.back()`); the native route animates out. `handleClose` (state reset + `flushOnDismiss`) runs on route unmount (a `useEffect` cleanup or the route's `beforeRemove`). Re-verify the deferred-open race: rapid open → dismiss → open. The reset-on-unmount is equivalent to the old `handleClose` reset.

5. **Glass background.** The route content's root should fill the screen with the same edge-to-edge `GlassSurface` used in `PlayDrawerOverlay` (`glassEffectStyle="regular"`, `role="low"`, `fallbackColor` secondaryBackground, `tintColor={playDrawerMaterialTint[colorScheme]}`, no radius). Likely **delete `PlayDrawerOverlay.tsx`** (portal/slide now native) and inline the GlassSurface into the route content. Content layout (firstScreen height from window, `paddingTop: insets.top + spacing[2]`, beta peek) carries over.

6. **Remove now-dead overlay code** in `PlayDrawer.tsx`: the `mounted`/`progress` shared value, the slide `useEffect`, the drag `Gesture.Pan`/`GestureDetector` (the native route gives swipe-to-dismiss), `runCloseAnimation`. Keep `isSheetOpen` (gates board/favorites/wake-lock/deferred sections) — drive it from route focus/mount.

### The Wrinkle: QueueSheet is opened from TWO contexts

`openQueueSheet` is called from the player (`onOpenQueue`) AND from the "added to queue" snackbar (`QueueAddedSnackbar` → context `openQueueSheet`), i.e. with the player closed. It's currently one `QueueSheet` rendered in drawer-host (main window) — fine when the player is closed, but BELOW the player route when open.
Options (pick during impl):

- (a) Make `QueueSheet` ALSO a route (e.g. `app/queue.tsx`, `presentation: 'formSheet'`/`modal`) so it stacks on top of whatever's current (the player route, or the tabs). Cleanest "everything stacks naturally." Most work.
- (b) Render a second `QueueSheet` instance INSIDE the player route (used when opened from the player); keep the drawer-host one for the snackbar/closed-player case. Simpler, slightly redundant.
  Recommend trying (a) — it's the logical end-state (the play-drawer ecosystem becomes stacked modal routes) and removes the dual-instance hazard.

## Validation

- `vp run typecheck:mobile`, `vp run test:mobile`, `vp check` (changed files only — `vp check --fix <paths>`; bare `vp check --fix` reformats the whole repo).
- Update any test mock for PlayDrawer if added (no test renders the full PlayDrawer today).
- **Device/sim QA matrix** (the whole point): open the player → open EACH of beta, queue, share, angle, climb-actions (long-press), tick → confirm each stacks ABOVE the player and dismisses cleanly (no freeze). Then change-between-climbs while open; Reduce-Transparency; Android Material.

## Environment notes (this arm64 Mac)

- **iOS device deploy** (iPhone 17 Pro `3573AA37-0E25-5AFE-B58F-80CE29FE88E9`, paired): JS-only changes ride Metro — just restart `CI=1 REACT_NATIVE_PACKAGER_HOSTNAME=192.168.0.83 vp run dev:mobile` and reload. Native changes need a rebuild: `xcodebuild build -workspace packages/mobile/ios/Boardsesh.xcworkspace -scheme Boardsesh -configuration Debug -destination 'platform=iOS,id=<udid>' -derivedDataPath packages/mobile/ios/build-device -allowProvisioningUpdates DEVELOPMENT_TEAM=9L3HKPZBH3`, then `xcrun devicectl device install app --device <udid> <app>` + `process launch`. (build-device/ was deleted to free disk — it rebuilds.)
- **Android emulator** (this arm64 Mac): `vp run mobile:android-shots` is BROKEN here (downloads x86_64 image + linux JDK). Use the manual path that worked: arm64 AVD `boardsesh-android16` (or `Boardsesh_API_35`); build with `JAVA_HOME=/opt/homebrew/opt/openjdk@21 node_modules/.bin/expo prebuild -p android --no-install` then `cd android && ./gradlew assembleDebug -PreactNativeArchitectures=arm64-v8a --no-daemon`; `adb install -r` (uninstall the higher-version `com.boardsesh.app` first); `adb reverse tcp:8081 tcp:8081`; Metro `CI=1 EXPO_PUBLIC_SCREENSHOT_MODE=1 EXPO_PUBLIC_SCREENSHOT_USER_EMAIL=test@boardsesh.com EXPO_PUBLIC_SCREENSHOT_USER_PASSWORD=test vp run dev:mobile`; launch via `am start -a android.intent.action.VIEW -d "com.boardsesh.app://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081"` (uninstall `com.boardsesh.app.dev` first or you get a scheme chooser). Screenshot deep links: `com.boardsesh.app://climbs?screenshotOpenFirst=1` (player), `?screenshotOpenBoardSheet=1` (BoardSheet).
- **Disk** ran out mid-Android-build once; iOS DerivedData trees are ~4GB each.

## Key files

- `packages/mobile/src/components/play-drawer/PlayDrawer.tsx` — the player (props→context, overlay→route content, open/close→router).
- `packages/mobile/src/components/play-drawer/PlayDrawerOverlay.tsx` — likely delete (keep GlassSurface recipe).
- `packages/mobile/src/components/play-drawer/use-deferred-sheet-open.ts` / `sheet-open-serializer.ts` — race guard (presentation-agnostic; rewire dismiss signal to route unmount).
- `packages/mobile/src/providers/drawer-host-provider.tsx` — PlayDrawer mount/props (~601), `openPlayDrawer` (~245), context value (~105-125, ~560), QueueSheet (~652).
- `packages/mobile/app/_layout.tsx` — Stack screens / presentation (~385-415).
- Sub-drawers (already inside PlayDrawer, stay): `LogAscentSheet`, `play-drawer/AngleSelectorSheet`, `ClimbActionsSheet`, `AddBetaVideoSheet`.
- Prior plan (overlay approach, superseded): `~/.claude/plans/lets-run-the-playdrawer-abstract-sparrow.md`.
