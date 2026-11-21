# Mobile climb authoring

`packages/mobile/app/(tabs)/climbs/create.tsx` resolves the editor's board and
mounts `packages/mobile/src/components/create-climb/CreateClimbScreen.tsx`.
The task includes the board, hold-role controls, metadata form, drafts, and
publish action. Long-press role selection presents above the editor.

The route supports new climbs, editing by `editClimbUuid`, and remix input such as
frames, name, description, characteristics, and parent UUID. Replacing editor
parameters starts a fresh editing session without dismissing and presenting the
whole task again. Successful publication dismisses the editor and returns feedback
to the climbs list.

Validate the board with its shared capabilities before authoring. Woods validates
its supported layout, size, and angles; an empty set string is valid for Woods and
spray walls. Unknown board names fall back to the active board without retaining
untrusted geometry. See [Woods rules](../../boards/woods-climb-rules.md).

Spray wall holds are runtime data. Wait for the wall and its version token rather
than treating a cold registry as an unsupported board. An updated hold generation
must not keep drawing or autosaving against the prior generation. Read
[spray walls](../../product/spray-walls.md) for publication, archival, and missing-hold rules.

Use the existing unsaved-work and player-dismissal handling when navigating into
or out of the task. Presentation follows [sheets versus routes](../mobile-sheets-vs-routes.md).
