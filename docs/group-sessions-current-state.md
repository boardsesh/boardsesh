# Group Sessions: Current Product Model

This document explains how group sessions work now in Boardsesh. It is intended for PM and design readers who need the user-facing model, the important UX states, and the language that maps to the current implementation.

For the lower-level WebSocket, GraphQL, Redis, and recovery details, see [WebSocket Implementation for Party Sessions](./websocket-implementation.md).

## Core Mental Model

A group session is a shared climbing room tied to a board setup. Everyone in the session sees the same participants, shared queue data, and board state in real time.

The important shift in the current branch is that **browsing a climb is no longer always the same as changing the wall**. Group sessions now separate five concepts:

| Concept        | Meaning                                                                                  |
| -------------- | ---------------------------------------------------------------------------------------- |
| Session        | The live room people join, share, leave, and explicitly end.                             |
| On the board   | The one climb currently shown on the LEDs or controller.                                 |
| My pick        | A participant's personal selected climb. Each person can have a different pick.          |
| Active climber | The participant whose pick controls what is on the board.                                |
| Sent to board  | A history of climbs that actually reached the wall, separate from future queue planning. |

In older language, many surfaces treated a climb as "active" as soon as someone selected it. The current model is closer to: **pick first, then take or hand off the wall when it is time to climb**.

## What Users Experience

### Starting and Joining

- A climber starts a session from the queue bar and can share a link or QR code.
- If they already have climbs queued locally, the new session starts with that queue so they do not lose their plan.
- People who join an existing session receive the current shared state instead of overwriting it with their own local queue.
- The session remains tied to the board configuration. Navigating between list, play, create, climb detail, or board angle changes does not by itself create a new session.

### Browsing Without Taking Over

- Selecting a climb in the list or play view sets **my pick**.
- If someone else is the active climber, my pick changes only my own browsing state. The LEDs stay on the active climber's climb.
- The climb list highlights my pick during a group session, not necessarily the climb on the wall.
- In play view, non-active climbers can spectate the wall climb or switch back to editing their own pick.

This means several people can browse and prepare different climbs at the same time without fighting over the controller.

### Taking the Wall

- The lightbulb action makes a participant's current pick the board climb.
- When a climber claims the wall, they become the active climber and their pick is mirrored to the LEDs.
- If the active climber swipes or chooses another climb, the wall follows them.
- If the active climber claims the wall again on the same climb, the app re-sends the climb to the board. This helps recover LEDs or controller state.

### Handing Off

- The expanded participant area shows each participant and their current pick.
- The active climber is visually marked with a lightbulb.
- Tapping a participant who has a pick hands the wall to that participant's pick.
- Participants without a pick show as "No pick yet" and cannot be handed the wall until they choose one.

The person initiating the handoff is recorded as the person who sent the climb to the board, while the target participant is recorded as the active climber.

### Planning Ahead

- The queue drawer now starts with **Sent to board** history. This is the list of climbs that actually reached the wall.
- The **Plan ahead** control reveals future queue planning.
- Queue planning can be scoped to "My queue", "All", or another participant.
- Participants can remove or reorder only queue items they added.
- Choosing a row in plan-ahead mode updates the user's pick instead of immediately changing the board.

The product distinction is intentional: history answers "what did we put on the wall?", while plan ahead answers "what might we climb next?".

### Logging Ticks

- Opening the inline tick bar freezes queue-bar navigation for the climb being logged.
- The bar can still receive live session updates, but it keeps the tick target stable until the tick UI closes.
- This prevents a peer changing the board while someone is mid-log and accidentally saving the tick against the wrong climb.

## Offline and Reconnection Behavior

Short disconnects should feel recoverable rather than destructive.

- Clients reconnect automatically and rejoin the same session.
- Recent session state is kept warm so refreshes and brief network drops can restore quickly.
- A session is not ended just because everyone disconnects. It only ends when someone explicitly ends it.
- While disconnected, local queue additions can continue and are reconciled after reconnect.
- Personal pick browsing can update locally while disconnected, but the server state wins after reconnect.
- Wall ownership actions such as taking or handing off the wall require an active connection, because they affect everyone.

## What Changed on This Branch

- "Set active" behavior in group sessions is now "pick this climb" unless the user is already controlling the wall.
- Non-active climbers can browse independently without changing the LEDs.
- The active climber's pick is the only personal pick mirrored to the board.
- The app records a separate sent-to-board history whenever a climb is actually sent to the wall.
- The queue drawer distinguishes sent history from future planning.
- Participants can filter future queue planning by owner.
- Queue item removal and reordering are ownership-limited to the participant who added the item.
- The persistent queue bar is restored as the primary control surface, with the previous minimised FAB path disabled on this branch.

## Useful Design Language

Recommended labels and concepts:

- **Pick this climb** for choosing what I want to browse or climb next.
- **My pick** for my personal selected climb.
- **On the board** for the climb currently shown on the LEDs.
- **Active climber** for the person currently controlling the wall.
- **Take the wall** or the lightbulb action for making my pick control the LEDs.
- **Sent to board** for wall history.
- **Plan ahead** for future queue planning.

Avoid using "active climb" as the only product term in group sessions. It is ambiguous because a user's active browsing selection may differ from the wall's active climb.

## Open UX Edges to Watch

- The current lightbulb action is powerful but may need clearer empty, disabled, and confirmation states for first-time users.
- "Sent to board" and "Plan ahead" are distinct but visually close in the queue drawer, so copy and hierarchy matter.
- Participant handoff depends on each person having a pick; the "No pick yet" state should stay visible and understandable.
- Offline browsing is optimistic and temporary. If a user changes their pick while disconnected, reconnect may restore the server's latest state.
