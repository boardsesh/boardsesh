# Physical board QA flow fragments

These flows use normal signed-in screens and real Bluetooth. Run them through
`vp run qa:boards`; they are separate from the screenshot/replay flows and CI.
The host owns the two-phone phase ordering, fixture lease, exact decoded-payload
checks, backend subscriptions, and baseline-relative history assertions.

Supply the app ID and normal named-wall URLs through the host configuration.
`CLIMB_LABEL_PATTERN`, `BOARD_HISTORY_LABEL`, and `SESSION_EXIT_LABEL` must match
the selected locale; the last two are native accessibility labels. Device
selection uses the resolved saved-board UUID, never the first discovered row.

`connect.yaml` and `put.yaml` initiate real UI actions. The host then distinguishes
a remembered-device success from an actual picker, selecting only the exact
saved board. Physical takeover uses this same connection path; the busy-wall
question belongs to a different crew browsing conflict and is rejected here.
An unexpected state fails the scenario; recovery is a separate phase.

`wait-app-ready.yaml` observes the real Home/Climbs screen and navigation labels
after an Android restart or simulator binding, before account or invite links.
Its bounded wait never treats native activity startup alone as app readiness.

Account inspection reads `account-user-<user ID>` and
`app-runtime-<metro|release>-<runtime version|none>-<update ID|embedded>` from
existing visible UI containers. Metro does not claim a launched OTA revision.
The host must additionally verify its actual source revision.

The host refuses text-entry flows on recorded Android runs: sign in manually
before starting that platform. Maestro's own command/debug artifacts can retain
typed values, so redacting its console output alone does not protect a password.
The iPhone driver records action names only. It must not capture the login form.
No flow clears app state or keychain,
changes analytics consent, signs out another account, or deletes climbing data.
Ending a session is permitted only after its ID matches the session created by
the current run.
