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

The editable header uses normal title contrast, with a separate accessible name.
Brush controls keep hold colors in their swatches; the active brush also has a
checkmark, selection fill, and border. Larger text wraps the controls into wider
rows, and the measured action-bar height contributes to the board's vertical
budget. Status text may wrap without covering the board.

On an editable Spraywall, Add holds is one full-width navigation row below the
painting controls, including its hint, opening state and inline failure. The
whole row is one target. This secondary action is outside the wall-height budget:
showing it, opening it, or displaying longer copy never takes space from the wall.
Only save-blocking missing-hold guidance stays in the measured primary controls. Description, climb
rules and publication controls remain below the tools; rule switches share an
inset group, with Save as draft in its own group.

Component previews are available as `create-climb--spraywall`, `--empty`,
`--long-title`, `--loading`, and `--error` in the isolated story harness. They use
the real prop-driven views and bundled photo fixture. They do not establish
backend/persistence behavior or native modal placement; test the actual route
on device for those contracts.

[Before and after design captures](images/create-climb-design/README.md) document
the component-level visual review and its device-testing limits.
