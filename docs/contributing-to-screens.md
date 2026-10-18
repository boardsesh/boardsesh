# Contributing to existing screens

This page is for anyone who wants to improve a screen that already exists in the Boardsesh app: the queue, the climb view, the play drawer, search, settings. It is a map. The rules and runbooks live in the docs it links to, so read those instead of looking for copies here.

## Start here

Contributions are welcome. We do not assign volunteers by default. Comment on the issue you want to work on, say what you plan to change, and start once nobody has objected. If there is no issue yet, open one first.

Good entry points right now:

- [#6230](https://github.com/boardsesh/boardsesh/issues/6230): queue, playlist and search model.
- [#6229](https://github.com/boardsesh/boardsesh/issues/6229): the order of sections on the climb view.
- [#6291](https://github.com/boardsesh/boardsesh/issues/6291): Boardz workouts.
- Anything open under the [`epic:climbing-experience`](https://github.com/boardsesh/boardsesh/labels/epic%3Aclimbing-experience) label.

Questions go in the issue, or on [Discord](https://discord.gg/YXA8GsXfQK).

## What we accept

- Changes to existing screens, in the native iOS and Android look, with phone and tablet layouts.
- Choices a climber can make inside the app they already have.

We do not take a second layout mode, a switch between two versions of a screen, or a parallel app that ships next to this one. One app, one set of screens, with settings where a climber would want them.

## Propose it first

Put this in the issue or the PR description:

1. Real screenshots from the iOS simulator or Android emulator, before and after. No AI-generated images. How to capture them: [docs/ios-simulator-screenshots.md](./ios-simulator-screenshots.md), [docs/android-emulator-screenshots.md](./android-emulator-screenshots.md).
2. What the climber gets, in one sentence.
3. Which tab, route or sheet changes, and how a climber gets there.

## Where code lives

- Screens: `packages/mobile/app/` (Expo Router).
- Components: `packages/mobile/src/components/`.
- Logic that web and mobile could both use: `packages/shared/*`, as pure TypeScript. A `*-react` package is only for hooks that both sides share. See "Shared Packages" in [CLAUDE.md](../CLAUDE.md).
- Backend and GraphQL: `packages/backend`.
- Bottom sheet or route: [docs/mobile-sheets-vs-routes.md](./mobile-sheets-vs-routes.md).
- Colours, type, spacing: [docs/ai-design-guidelines.md](./ai-design-guidelines.md).

## Make it configurable

When you change a screen, ask what the climber should be able to show, hide, reorder or pick. Keep today's look as the default, and always give a way back to it. Two screens already do this.

### Example A: play drawer sections (#6279)

- `packages/mobile/src/lib/play-drawer-sections-preference.ts` holds the section ids, the defaults and the stored value.
- `packages/mobile/src/components/play-drawer/PlayDrawerSectionsSheet.tsx` is the sheet, with Show all, Hide all, ↑/↓ per section and Restore defaults.
- `packages/mobile/src/components/settings/use-play-drawer-section-controls.ts` feeds the sheet and Settings → Climbs & grades → Climb view (`packages/mobile/src/components/settings/climb-view/ClimbViewSettingsScreen.tsx`).
- A hidden section, or one below the fold the climber has not scrolled to, starts no queries.

The shared pieces for "ordered sections with visibility" landed with #6229. Build a new list on them rather than inventing a pattern: `packages/mobile/src/lib/section-layout.ts` (pure order and visibility rules), `packages/mobile/src/lib/section-layout-store.ts` (the same layout in the synchronous settings store) and `packages/mobile/src/components/section-layout/SectionLayoutList.tsx` (switch rows with ↑/↓). The player's Buttons tab uses all three; [docs/climb-view-options.md](./climb-view-options.md) has the steps.

### Example B: climb list rows (#6369)

- `packages/mobile/src/lib/climb-row-display.ts` is the registry of switches.
- Presets sit on top of the switches. A manual mix reads Custom.
- `climb-row-display-preference.ts` keeps a synchronous snapshot, so rows do not wait on storage.
- Steps for adding a switch: [docs/climb-list-rows.md](./climb-list-rows.md).
- The climb list's options menu (`packages/mobile/src/components/chrome/ClimbListBoardActions.tsx`) shows how a screen links to its settings from the place the climber is already looking.

### Checklist for a new preference

1. A stable id that never changes meaning.
2. A default equal to today's behaviour.
3. A versioned stored shape that ignores keys it does not know.
4. A load that retries after a failure. It must not cache the default as if it were the saved value.
   `getPreference` in `packages/mobile/src/lib/preference-store.ts` does not swallow rejections, so a failed read reaches your code.
5. A control that restores the defaults.
6. No fetches for things that are hidden.
7. Tests next to the code, in `__tests__/`.

A display preference never changes who can see what. Privacy follows [docs/privacy.md](./privacy.md) regardless of how a screen is laid out.

## Text and translations

Every visible string goes in every locale: en-US, es, fr and de. Catalogs live in `packages/shared/i18n/locales/`. Follow the glossaries: [Spanish](./i18n-spanish-glossary.md), [French](./i18n-french-glossary.md), [German](./i18n-german-glossary.md). Don't hardcode strings. See "Internationalisation" in [CLAUDE.md](../CLAUDE.md).

## JS or native

JS-only changes go to `main` and reach climbers by OTA. A change that moves the native fingerprint (a new native module, an Expo plugin, an SDK bump) goes to `release/next`. If you are not sure, open the PR against `main` as JS-only. The OTA compatibility comment on the PR tells you if it is wrong. Details: "JS changes land on `main`, native changes on `release/next`" in [CONTRIBUTING.md](../CONTRIBUTING.md) and [docs/mobile-store-release.md](./mobile-store-release.md).

## Test it

Run `vp check`, `vp run typecheck:mobile`, `vp run test:mobile`, `vp run check:mobile-bundle` and `vp run check:mobile-simulator` (macOS only; it skips elsewhere).

Then look at it:

- iOS and Android.
- Phone and tablet.
- A 375 pt wide screen.
- Large text, from font scale 1.3 up.
- Light and dark.
- The browser build, if the screen exists there.

To try your branch on a store build without building anything, use the `pr-<number>` branch (Path A in [CONTRIBUTING.md](../CONTRIBUTING.md)).

## Open the PR

Open it as a draft against the right branch. The description needs:

- Release Notes in climber voice, or tick "No release note needed".
- A Test plan of 1 to 5 steps, 12 words or fewer each: one tap, then what the tester sees.
- A `Risk: N/5` line with the reason.

Format and the tester loop: [docs/crowdsourced-qa.md](./crowdsourced-qa.md). Changes under `packages/shared/ble-protocol/`, `packages/mobile/src/lib/ble/` or `packages/mobile/modules/live-activity/ios/` also need a Bluetooth review by Fable or Astra before merge. Ask a maintainer to arrange it; a normal maintainer review does not cover it.

## Getting reviewed

- CI is green and there are no merge conflicts.
- The PR is small and about one thing.
- Before and after screenshots are in the description.
- A maintainer looks at drafts that are ready and CI-green. One maintainer review is needed to merge.

## Forks and the hosted service

You can fork the code and run your own copy. It is Apache 2.0. Using Boardsesh's accounts, data or servers as the backend of an app you distribute needs our written permission, and we do not currently grant it. The policy text is in [LEGAL.md](../LEGAL.md#hosted-service--api-access); this page does not add to it.
