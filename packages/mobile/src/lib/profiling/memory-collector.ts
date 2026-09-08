/** Scalar-only diagnostics. Nothing here may retain a climb, render closure, or image. */
export const MEMORY_LIMITS = { identifiers: 4096, identifierLength: 512, surfaces: 512, reasons: 24 } as const;
export type MemorySurface = 'list' | 'carousel' | 'idle';
export type MemoryBoardContext = { name: string; layoutId: number; sizeId: number; setIds: string; angle: number };
export type MemoryPhase = 'settled' | 'browsed' | 'background' | 'home';
export type MemoryCommand = {
  schemaVersion: 1;
  commandId: string;
  runId?: string;
  cycle: number;
  surface: MemorySurface;
  phase: MemoryPhase;
  action: 'begin' | 'checkpoint' | 'scroll' | 'open';
  targetUuid?: string;
  targetIndex?: number;
  expectedUuids?: string[];
};
export function parseMemoryCommand(input: unknown): MemoryCommand | null {
  if (!input || typeof input !== 'object') return null;
  const command = input as Record<string, unknown>;
  const identifier = (candidate: unknown) =>
    typeof candidate === 'string' && candidate.length > 0 && candidate.length <= MEMORY_LIMITS.identifierLength;
  if (
    command.schemaVersion !== 1 ||
    !identifier(command.commandId) ||
    (command.runId !== undefined && !identifier(command.runId)) ||
    !Number.isSafeInteger(command.cycle) ||
    (command.cycle as number) < -2 ||
    (command.cycle as number) > 20 ||
    !['list', 'carousel', 'idle'].includes(command.surface as string) ||
    !['settled', 'browsed', 'background', 'home'].includes(command.phase as string) ||
    !['begin', 'checkpoint', 'scroll', 'open'].includes(command.action as string)
  )
    return null;
  if (
    command.expectedUuids !== undefined &&
    (!Array.isArray(command.expectedUuids) ||
      command.expectedUuids.length > 400 ||
      !command.expectedUuids.every(identifier))
  )
    return null;
  if (
    (command.action === 'scroll' || command.action === 'open') &&
    (!identifier(command.targetUuid) ||
      !Number.isSafeInteger(command.targetIndex) ||
      (command.targetIndex as number) < 0 ||
      (command.targetIndex as number) >= 400)
  )
    return null;
  // Project explicitly: never retain unknown caller-owned properties.
  return {
    schemaVersion: 1,
    commandId: command.commandId as string,
    runId: command.runId as string | undefined,
    cycle: command.cycle as number,
    surface: command.surface as MemorySurface,
    phase: command.phase as MemoryPhase,
    action: command.action as MemoryCommand['action'],
    targetUuid: command.action === 'scroll' || command.action === 'open' ? (command.targetUuid as string) : undefined,
    targetIndex: command.action === 'scroll' || command.action === 'open' ? (command.targetIndex as number) : undefined,
    expectedUuids: (command.expectedUuids as string[] | undefined)?.slice(),
  };
}
export function createMemoryCollector(enabled: boolean, runId: string, now: () => number = Date.now) {
  let command: MemoryCommand | null = null;
  let sequence = 0;
  const visited = new Set<string>();
  const renderKeys = new Set<string>();
  const incidentalUuids = new Set<string>();
  let route = 'unknown';
  let board: MemoryBoardContext | null = null;
  let accountId: string | null = null;
  const renderModes = new Set<string>();
  const mountedRenderModes = new Map<string, string>();
  const current = new Map<string, { surface: MemorySurface; uuids: string[] }>();
  const images = new Map<string, number>();
  const mountedRenderKeys = new Map<string, string>();
  const mountedClimbIds = new Map<string, string>();
  const reasons = new Set<string>();
  let overflow = false;
  let appState = 'unknown';
  let backgroundGeneration = 0;
  let clearStartedGeneration = -1;
  let clearCompletedGeneration = -1;
  let clearPending = 0;
  function invalidate(reason: string) {
    if (!enabled) return;
    if (reasons.size < MEMORY_LIMITS.reasons) reasons.add(reason.slice(0, MEMORY_LIMITS.identifierLength));
    else overflow = true;
  }
  function addIdentifier(target: Set<string>, identifier: string) {
    if (
      !identifier ||
      identifier.length > MEMORY_LIMITS.identifierLength ||
      (!target.has(identifier) && target.size >= MEMORY_LIMITS.identifiers)
    ) {
      overflow = true;
      return;
    }
    target.add(identifier);
  }
  function observeCurrent() {
    for (const observation of current.values())
      if (observation.surface === command?.surface) {
        for (const uuid of observation.uuids) addIdentifier(visited, uuid);
      }
  }
  return {
    invalidate,
    isArmed(next: MemoryCommand) {
      return enabled && command?.cycle === next.cycle && command.surface === next.surface && next.runId === runId;
    },
    begin(next: MemoryCommand) {
      if (!enabled || (next.runId !== undefined && next.runId !== runId)) return;
      command = parseMemoryCommand(next);
      if (!command) {
        invalidate('invalid-command');
        return;
      }
      visited.clear();
      renderKeys.clear();
      renderModes.clear();
      incidentalUuids.clear();
      reasons.clear();
      // Overflow is sticky for the process: dropping bookkeeping cannot restore trust.
      observeCurrent();
      for (const key of mountedRenderKeys.values()) addIdentifier(renderKeys, key);
      for (const mode of mountedRenderModes.values()) addIdentifier(renderModes, mode);
      for (const uuid of mountedClimbIds.values()) addIdentifier(incidentalUuids, uuid);
    },
    visible(owner: string, surface: MemorySurface, uuids: string[]) {
      if (!enabled) return;
      if (uuids.length === 0) {
        current.delete(owner);
        return;
      }
      if (
        (!current.has(owner) && current.size >= MEMORY_LIMITS.surfaces) ||
        uuids.length > 100 ||
        owner.length > MEMORY_LIMITS.identifierLength ||
        uuids.some((uuid) => !uuid || uuid.length > MEMORY_LIMITS.identifierLength)
      ) {
        overflow = true;
        return;
      }
      current.set(owner, { surface, uuids: uuids.slice() });
      if (command?.surface === surface) for (const uuid of uuids) addIdentifier(visited, uuid);
    },
    board(context: MemoryBoardContext | null) {
      if (!enabled) return;
      if (context === null) {
        board = null;
        return;
      }
      if (
        !context.name ||
        context.name.length > MEMORY_LIMITS.identifierLength ||
        context.setIds.length > MEMORY_LIMITS.identifierLength ||
        ![context.layoutId, context.sizeId, context.angle].every(Number.isFinite)
      ) {
        invalidate('invalid-board-context');
        return;
      }
      board = {
        name: context.name,
        layoutId: context.layoutId,
        sizeId: context.sizeId,
        setIds: context.setIds,
        angle: context.angle,
      };
    },
    account(identifier: string | null) {
      if (!enabled) return;
      if (identifier !== null && (!identifier || identifier.length > MEMORY_LIMITS.identifierLength)) {
        invalidate('invalid-account-context');
        return;
      }
      accountId = identifier;
    },
    route(path: string) {
      if (!enabled) return;
      if (path.length > MEMORY_LIMITS.identifierLength) {
        overflow = true;
        return;
      }
      route = path;
    },
    incidental(owner: string, uuid: string | null) {
      if (!enabled) return;
      if (uuid === null) {
        mountedClimbIds.delete(owner);
        return;
      }
      if (
        (!mountedClimbIds.has(owner) && mountedClimbIds.size >= MEMORY_LIMITS.surfaces) ||
        uuid.length > MEMORY_LIMITS.identifierLength ||
        owner.length > MEMORY_LIMITS.identifierLength
      ) {
        overflow = true;
        return;
      }
      mountedClimbIds.set(owner, uuid);
      if (command) addIdentifier(incidentalUuids, uuid);
    },
    rendered(owner: string, key: string | null, mode?: string) {
      if (!enabled) return;
      if (key === null) {
        mountedRenderKeys.delete(owner);
        mountedRenderModes.delete(owner);
        return;
      }
      if (
        (!mountedRenderKeys.has(owner) && mountedRenderKeys.size >= MEMORY_LIMITS.surfaces) ||
        key.length > MEMORY_LIMITS.identifierLength ||
        owner.length > MEMORY_LIMITS.identifierLength
      ) {
        overflow = true;
        return;
      }
      mountedRenderKeys.set(owner, key);
      if (mode !== undefined) {
        if (!mode || mode.length > MEMORY_LIMITS.identifierLength) {
          overflow = true;
          return;
        }
        mountedRenderModes.set(owner, mode);
        if (command) addIdentifier(renderModes, mode);
      }
      if (command) addIdentifier(renderKeys, key);
    },
    image(owner: string, count: number) {
      if (!enabled) return;
      if (count === 0) {
        images.delete(owner);
        return;
      }
      if (
        (!images.has(owner) && images.size >= MEMORY_LIMITS.surfaces) ||
        !Number.isSafeInteger(count) ||
        count < 0 ||
        count > 100 ||
        owner.length > MEMORY_LIMITS.identifierLength
      ) {
        overflow = true;
        return;
      }
      images.set(owner, count);
    },
    appState(state: string) {
      if (!enabled) return;
      if (state === 'background' && appState !== 'background') backgroundGeneration += 1;
      appState = state;
    },
    clearStarted() {
      if (!enabled) return -1;
      clearPending += 1;
      clearStartedGeneration = backgroundGeneration;
      return backgroundGeneration;
    },
    clearCompleted(generation: number, succeeded: boolean) {
      if (!enabled) return;
      clearPending = Math.max(0, clearPending - 1);
      if (succeeded) clearCompletedGeneration = Math.max(clearCompletedGeneration, generation);
      else invalidate('image-cache-clear-failed');
    },
    snapshot(
      next: MemoryCommand,
      counters: { overlayIndexSize: number; pendingRenders: number; queuedRenders: number; dispatchedRenders: number },
      timeout = false,
    ) {
      const invalidReasons = [...reasons];
      if (overflow) invalidReasons.push('diagnostic-overflow');
      if (next.runId && next.runId !== runId) invalidReasons.push('process-replaced');
      if (!command || command.cycle !== next.cycle || command.surface !== next.surface)
        invalidReasons.push('cycle-not-armed');
      if (timeout) invalidReasons.push('checkpoint-timeout');
      if (counters.pendingRenders > 0) invalidReasons.push('pending-renders');
      if (next.phase === 'browsed' && next.surface !== 'idle') {
        if (visited.size === 0) invalidReasons.push('missing-visible-observations');
        if (next.expectedUuids?.some((uuid) => !visited.has(uuid))) invalidReasons.push('missing-expected-uuid');
      }
      if (
        (next.action === 'scroll' || next.action === 'open') &&
        next.targetUuid &&
        ![...current.values()].some(
          (observation) =>
            observation.surface === (next.action === 'scroll' ? 'list' : 'carousel') &&
            observation.uuids.includes(next.targetUuid!),
        )
      )
        invalidReasons.push('target-not-observed');
      if (next.phase === 'home' && route !== '(tabs)/home' && route !== '(tabs)')
        invalidReasons.push('home-not-observed');
      if (
        next.phase === 'background' &&
        (appState !== 'background' ||
          backgroundGeneration === 0 ||
          clearStartedGeneration !== backgroundGeneration ||
          clearCompletedGeneration !== backgroundGeneration ||
          clearPending > 0)
      )
        invalidReasons.push('background-incomplete');
      return {
        schemaVersion: 1,
        runId,
        commandId: next.commandId,
        sequence: ++sequence,
        cycle: next.cycle,
        surface: next.surface,
        phase: next.phase,
        timestampMs: now(),
        actualVisibleUuids: [...visited],
        incidentalUuids: [...incidentalUuids],
        renderKeys: [...renderKeys],
        route,
        board: board ? { ...board } : null,
        accountId,
        renderModes: [...renderModes],
        mountedImageSurfaces: images.size,
        mountedImages: [...images.values()].reduce((sum, count) => sum + count, 0),
        appState,
        backgroundGeneration,
        clearStartedGeneration,
        clearCompletedGeneration,
        clearPending,
        ...counters,
        valid: invalidReasons.length === 0,
        invalidReasons,
      };
    },
  };
}
