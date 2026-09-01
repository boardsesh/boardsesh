// Boardsesh render-mode capability state (issue #2202) — split out of
// use-native-climb-render.ts (which re-exports every name here for its own
// call sites and existing test seams; nothing about its public API changes).
//
// The reason this lives in its own file: use-native-climb-render.ts's OTHER
// top-level imports (board-details, background-image-cache) eagerly import
// `expo-asset`, which crashes outright in any test environment that hasn't
// mocked it. This module has none of that — it's plain, dependency-free
// module state — so a caller that only needs to READ "can the installed
// binary draw the Boardsesh mode" (queue-provider.tsx, for the board-render
// A/B telemetry) can import just this, without pulling the whole native
// render graph into a provider that mounts near the app root.
//
// `null` is "not answered yet" and reads as unavailable: RenderConfig has no
// `deny_unknown_fields`, so a library that predates the mode accepts a
// Boardsesh config, ignores every field, and hands back a classic render
// silently. The first render must never go out on an unverified library.
let boardseshRendererSupport: boolean | null = null;
const boardseshSupportListeners = new Set<() => void>();
let boardseshSupportRevision = 0;
/** The in-flight probe promise, if any — owned by `ensureBoardseshSupportProbed`
 *  in use-native-climb-render.ts (it needs the native module getter that lives
 *  there), which reads/writes it through the two accessors below. */
let boardseshSupportProbe: Promise<void> | null = null;

export function setBoardseshRendererSupport(supported: boolean): void {
  if (boardseshRendererSupport === supported) return;
  boardseshRendererSupport = supported;
  boardseshSupportRevision += 1;
  for (const listener of boardseshSupportListeners) listener();
}

export function subscribeToBoardseshSupport(onStoreChange: () => void): () => void {
  boardseshSupportListeners.add(onStoreChange);
  return () => {
    boardseshSupportListeners.delete(onStoreChange);
  };
}

export function getBoardseshSupportRevision(): number {
  return boardseshSupportRevision;
}

/** `null` until the probe answers — read as unavailable everywhere. */
export function getBoardseshRendererSupport(): boolean | null {
  return boardseshRendererSupport;
}

export function getBoardseshSupportProbe(): Promise<void> | null {
  return boardseshSupportProbe;
}

export function setBoardseshSupportProbe(probe: Promise<void> | null): void {
  boardseshSupportProbe = probe;
}

/** Test-only handles for the Boardsesh capability latch. */
export function _resetBoardseshSupportForTests(): void {
  boardseshRendererSupport = null;
  boardseshSupportProbe = null;
  boardseshSupportRevision += 1;
  for (const listener of boardseshSupportListeners) listener();
}

export const _getBoardseshSupportForTests = getBoardseshRendererSupport;
