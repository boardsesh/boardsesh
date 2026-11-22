# Hold-editor rendering checks

Real production view components with the bundled `spray-liz` photo and its
296 hold outlines. Captured from the isolated `spray-editor--setting` story,
Material browser variant, device pixel ratio 2.

- [Phone, dark, 390 × 844](phone-dark.jpg)
- [Tablet, light, 820 × 1180](tablet-light.jpg)
- [Readiness, canvas dimensions and runtime-error results](browser-preview.json)

Both previews reached explicit story readiness with zero browser runtime errors.
The committed and live SVG roots have identical view boxes and rendered sizes.
These captures verify layout and alignment only: no native Pencil gestures,
iPad frame timing, peak memory, or OS-termination behavior were measured.
