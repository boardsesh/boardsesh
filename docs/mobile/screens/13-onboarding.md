# Mobile onboarding

The launch gate and replay walkthrough are distinct. A new account without an
active board opens `/boards?firstBoard=1`; the picker completes onboarding when
activation binds a board. Restoring an active board must finish before deciding
that first-board setup is required.

`packages/mobile/app/onboarding.tsx` hosts the replay flow opened from Settings:
the framing card, board choice, optional manufacturer-account link, and board-look
choice. The board step does not bypass `BoardLookStepGate`: that gate waits for a
synced climb and a successful native renderer probe before presenting a mandatory
look choice. Optional linking treats Back as declining the offer.

The route is an opaque-backed `transparentModal` over live tabs. Mandatory steps
prevent gesture dismissal and consume Android Back; each branch must retain the
same backing so underlying tabs never show through. See
[sheets versus routes](../mobile-sheets-vs-routes.md).

The reusable logic and persisted progress live under
`packages/mobile/src/lib/onboarding/`; UI and launch gates live under
`packages/mobile/src/components/onboarding/`. Targeted tips use the current mobile
anchors and presence checks. The retired web 15-step DOM tour, IndexedDB progress,
Popper overlays, and window events are not the app implementation.

Read [board selection](04-board-selection.md), [navigation](01-navigation.md), and
[mobile auth flow](../../auth/mobile-auth-flow.md) before changing entry or return behavior.
