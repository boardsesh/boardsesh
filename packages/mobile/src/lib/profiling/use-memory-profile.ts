import { applyMemoryBrowseControl } from './memory-control';
import { useSegments } from 'expo-router';
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { parseMemoryCommand, type MemoryCommand } from './memory-collector';
import { MEMORY_PROFILING_ENABLED, memoryProfile, memoryRunId, registerMemoryExportWake } from './memory-profile';
import { getOverlayIndexSize } from '../overlay-index';
import { getRenderSchedulerCounts } from '../board-render/render-scheduler';

/** Opt-in local, fixed-size command/export mailbox; no routes or remote endpoint. */
export function useMemoryProfile(): void {
  const segments = useSegments();
  const route = segments.join('/');
  useEffect(() => {
    memoryProfile.route(route);
  }, [route]);
  useEffect(() => {
    if (!MEMORY_PROFILING_ENABLED) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastCommandId = '';
    let pending: {
      command: MemoryCommand;
      started: number;
      drainedSince: number | null;
      actionApplied: boolean;
    } | null = null;
    memoryProfile.appState(AppState.currentState);
    const subscription = AppState.addEventListener('change', (state) => {
      memoryProfile.appState(state);
      wake();
    });
    let polling = false;
    let wakeRequested = false;
    function wake() {
      if (stopped) return;
      if (polling) {
        wakeRequested = true;
        return;
      }
      if (timer) clearTimeout(timer);
      void poll();
    }
    const unregisterWake = registerMemoryExportWake(wake);
    async function poll() {
      if (polling || stopped) return;
      polling = true;
      try {
        const { Directory, File, Paths } = await import('expo-file-system');
        if (stopped) return;
        const directory = new Directory(Paths.document, 'boardsesh-profile');
        directory.create({ intermediates: true, idempotent: true });
        const commandFile = new File(directory, 'memory-command.json');
        if (commandFile.exists && commandFile.size <= 64 * 1024) {
          const command = parseMemoryCommand(JSON.parse(await commandFile.text()));
          if (stopped) return;
          if (command && command.commandId !== lastCommandId) {
            if (pending) memoryProfile.invalidate('checkpoint-overwritten');
            lastCommandId = command.commandId;
            if (command.action === 'begin') memoryProfile.begin(command);
            pending = { command, started: Date.now(), drainedSince: null, actionApplied: false };
          }
        }
        if (pending) {
          if (
            (pending.command.action === 'scroll' || pending.command.action === 'open') &&
            !pending.actionApplied &&
            pending.command.runId === memoryRunId &&
            memoryProfile.isArmed(pending.command)
          ) {
            const { action, targetUuid, targetIndex } = pending.command;
            const result = applyMemoryBrowseControl({
              commandId: pending.command.commandId,
              action,
              targetUuid: targetUuid!,
              targetIndex: targetIndex!,
            });
            if (result === 'mismatch') {
              memoryProfile.invalidate('target-uuid-mismatch');
              pending.actionApplied = true;
            }
            if (result === 'complete') pending.actionApplied = true;
          }
          const actionReady =
            pending.command.action === 'checkpoint' || pending.command.action === 'begin' || pending.actionApplied;
          const counters = { overlayIndexSize: getOverlayIndexSize(), ...getRenderSchedulerCounts() };
          const observed = memoryProfile.snapshot(pending.command, counters);
          const ready = actionReady && observed.valid && counters.pendingRenders === 0;
          if (ready) pending.drainedSince ??= Date.now();
          else pending.drainedSince = null;
          const timedOut = Date.now() - pending.started >= 30_000;
          if (
            timedOut ||
            (ready && pending.command.phase === 'background') ||
            (pending.drainedSince !== null && Date.now() - pending.drainedSince >= 500)
          ) {
            const captured = memoryProfile.snapshot(pending.command, counters, timedOut);
            // Synchronous write, same JS turn as collection. Host validates commandId/runId.
            new File(directory, 'memory-latest.json').write(JSON.stringify(captured));
            pending = null;
          }
        }
      } catch {
        // A partial host write can be retried; never interfere with production rendering.
      } finally {
        polling = false;
        if (!stopped) {
          const delay = wakeRequested ? 0 : 250;
          wakeRequested = false;
          timer = setTimeout(() => {
            void poll();
          }, delay);
        }
      }
    }
    void poll();
    return () => {
      stopped = true;
      unregisterWake();
      if (timer) clearTimeout(timer);
      subscription.remove();
    };
  }, []);
}

export function MemoryProfileObserver() {
  useMemoryProfile();
  return null;
}
