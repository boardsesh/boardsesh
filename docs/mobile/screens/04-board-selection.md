# Mobile board selection and discovery

`packages/mobile/app/boards/index.tsx` hosts the board picker. Its presentation
lives under `packages/mobile/src/components/board-discovery/`; activation,
identity comparisons, follow behavior, and picker analytics live under
`packages/mobile/src/lib/boards/`. The In range slot's state (the scan, the top
it leads with, the Bluetooth asks) is `usePickerInRange` and its buttons are
`useInRangeActions`, both in board-discovery; the screen keeps the picks, Near
you and location.

## Pick an existing board

The picker combines Your boards, nearby results when location is allowed, offline
boards, and boards identified through the shared Bluetooth scan. The first-board
flow offers the gym path without requesting location merely because it opened.
A saved board's UUID identifies the wall; matching catalog geometry alone does
not make two physical boards the same.

`useActivateBoard` owns selection. A pick follows a public board when the climber
neither created nor already follows it. Activation destinations distinguish
first-board entry, an explicit return to Session, and other picker entries.
The detailed ordering, stable scan-result placement, location states, event
properties, and offline-download offers are in [navigation](01-navigation.md)
and [Bluetooth](12-bluetooth.md).

## Create and manage a board

`app/boards/create.tsx`, `edit.tsx`, and `manage.tsx` use the board-discovery
components. Keep board creation separate from selecting an existing saved wall.
Spray walls use their own photo, hold-review, and LED setup tasks; see
[spray walls](../../product/spray-walls.md) and [spray LED setup](../../boards/spray-wall-led.md).

A failed active-board restore is not an empty board list. Show loading while a
read is pending and Retry on failure; offer first-board setup only after a
successful read proves there is no selection. Account isolation and offline
availability follow [offline reads](../../data/offline-reads.md).
