# Create climb design review

These are real browser renders of the production view components with the
bundled `spray-liz` photo fixture, at 390 × 844 CSS pixels and DPR 2. Before and
after use the same empty dark and painted light scenes. Native modal placement,
platform gestures, and OS Dynamic Type still need device QA.

Before renders use the prior header, action bar and form views; the former
inline Add holds block is lifted unchanged into the preview adapter. After
renders use the new `CreateClimb.stories.tsx`. Both captures wait for the story's
explicit photo/overlay readiness, clear incidental keyboard focus, and wait two
animation frames. Fixture scenes do not exercise accounts, persistence, or BLE.

| Appearance | Before | After |
| --- | --- | --- |
| Dark, empty climb | [Before](before-dark.png) | [After](after-dark.png) |
| Light, painted climb | [Before](before-light.png) | [After](after-light.png) |

[Grouped metadata and publication settings](after-settings.png).

The secondary Add holds row follows the primary painting controls and is excluded
from wall sizing. [Small-viewport measurements](wall-sizing.json) verify that the
375 × 667 preview renders a 332.8 px wall in idle, opening, and failure states.
Hiding the row or increasing its minimum height to 240 px leaves the wall height
unchanged. The measured wall matches its maximum available size to pixel rounding.
