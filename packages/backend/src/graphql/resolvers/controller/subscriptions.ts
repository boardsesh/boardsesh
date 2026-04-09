import type { ConnectionContext, ControllerEvent, LedUpdate, LedCommand, BoardName, QueueNavigationContext, ControllerQueueItem, ControllerQueueSync, ClimbQueueItem } from '@boardsesh/shared-schema';

import type { RequestDbInstance } from '@boardsesh/db/client';
import { createRequestDb } from '@boardsesh/db/client';
import { esp32Controllers } from '@boardsesh/db/schema/app';
import { eq } from 'drizzle-orm';
import { pubsub } from '../../../pubsub/index';
import { roomManager } from '../../../services/room-manager';
import { createAsyncIterator } from '../shared/async-iterators';
import { getLedPlacements } from '@boardsesh/board-constants/led-placements';
import { convertLitUpHoldsStringToMap } from '../../../db/queries/util/hold-state';
import { requireControllerAuth } from '../shared/helpers';
import { getGradeColor } from './grade-colors';
import { buildNavigationContext, findClimbIndex } from './navigation-helpers';

const db = createRequestDb();

// LED color mapping for hold states (matches web app colors)
const HOLD_STATE_COLORS: Record<string, { r: number; g: number; b: number }> = {
  STARTING: { r: 0, g: 255, b: 0 },     // Green
  FINISH: { r: 255, g: 0, b: 255 },     // Magenta/Pink
  HAND: { r: 0, g: 255, b: 255 },       // Cyan
  FOOT: { r: 255, g: 170, b: 0 },       // Orange
  OFF: { r: 0, g: 0, b: 0 },            // Off
};

/**
 * Build a minimal ControllerQueueItem from a full ClimbQueueItem
 */
function buildControllerQueueItem(item: ClimbQueueItem): ControllerQueueItem {
  return {
    uuid: item.uuid,
    climbUuid: item.climb.uuid,
    name: item.climb.name,
    grade: item.climb.difficulty,
    gradeColor: getGradeColor(item.climb.difficulty),
  };
}

/**
 * Build a ControllerQueueSync event from current queue state
 */
function buildControllerQueueSync(queue: ClimbQueueItem[], currentItemUuid: string | undefined): ControllerQueueSync {
  const currentIndex = currentItemUuid
    ? queue.findIndex((item) => item.uuid === currentItemUuid)
    : -1;

  return {
    __typename: 'ControllerQueueSync',
    queue: queue.map(buildControllerQueueItem),
    currentIndex,
  };
}

/**
 * Convert a climb's frames string to LED commands using LED placements data.
 * Derives the litUpHoldsMap from the compact frames string on-the-fly.
 */
function climbToLedCommands(
  climb: { frames: string },
  boardName: BoardName,
  ledPlacements: Record<number, number>
): LedCommand[] {
  const litUpHoldsMap = convertLitUpHoldsStringToMap(climb.frames || '', boardName)[0] || {};
  const commands: LedCommand[] = [];

  for (const [placementIdStr, holdInfo] of Object.entries(litUpHoldsMap)) {
    const placementId = parseInt(placementIdStr, 10);
    const ledPosition = ledPlacements[placementId];

    if (ledPosition === undefined) {
      // This placement doesn't have an LED in this board configuration
      continue;
    }

    const color = HOLD_STATE_COLORS[holdInfo.state] || HOLD_STATE_COLORS.HAND;

    commands.push({
      position: ledPosition,
      r: color.r,
      g: color.g,
      b: color.b,
    });
  }

  console.log(`[Controller] Converted ${Object.keys(litUpHoldsMap).length} holds to ${commands.length} LED commands`);
  return commands;
}

export const controllerSubscriptions = {
  /**
   * ESP32 controller subscribes to receive LED commands
   * Uses API key authentication via connectionParams
   *
   * Flow:
   * 1. Validate API key from connectionParams and verify session authorization
   * 2. Subscribe to session's current climb changes
   * 3. When climb changes, convert to LED commands and send to controller
   * 4. Send periodic pings to keep connection alive
   */
  controllerEvents: {
    subscribe: async function* (
      _: unknown,
      { sessionId }: { sessionId: string },
      ctx: ConnectionContext
    ): AsyncGenerator<{ controllerEvents: ControllerEvent }> {
      // Validate API key from context
      const { controllerId } = requireControllerAuth(ctx);

      // Single DB query: fetch controller and update lastSeenAt + authorizedSessionId
      const [controller] = await db
        .update(esp32Controllers)
        .set({ lastSeenAt: new Date(), authorizedSessionId: sessionId })
        .where(eq(esp32Controllers.id, controllerId))
        .returning();

      if (!controller) {
        throw new Error('Controller not registered. Register via web UI first.');
      }

      // Build numeric boardPath from controller's registered config
      // Format: "board_name/layout_id/size_id/set_ids" (e.g., "kilter/8/17/26,27")
      // This is used by the ESP32 display to look up the board image config
      const boardPath = `${controller.boardName}/${controller.layoutId}/${controller.sizeId}/${controller.setIds}`;

      console.log(
        `[Controller] Controller ${controller.id} subscribed to session ${sessionId} (boardPath: ${boardPath})`
      );

      // Helper to build LedUpdate with navigation context
      const buildLedUpdateWithNavigation = async (
        climb: { uuid: string; name: string; difficulty: string; angle: number; frames: string } | null | undefined,
        currentItemUuid?: string,
        clientId?: string | null
      ): Promise<LedUpdate> => {
        // Get LED placements for this controller's configuration
        const ledPlacements = getLedPlacements(
          controller.boardName as BoardName,
          controller.layoutId,
          controller.sizeId
        );

        if (!climb) {
          // No current climb - could be clearing or unknown climb from BLE
          // Get queue state for navigation context so ESP32 can navigate back
          const queueState = await roomManager.getQueueState(sessionId);
          const navigation = buildNavigationContext(queueState.queue, -1);

          return {
            __typename: 'LedUpdate',
            commands: [],
            boardPath,
            clientId,
            // If clientId matches controller, this is an unknown BLE climb - show "Unknown Climb"
            climbName: clientId ? 'Unknown Climb' : undefined,
            climbGrade: clientId ? '?' : undefined,
            gradeColor: clientId ? '#888888' : undefined,
            navigation,
          };
        }

        const commands = climbToLedCommands(climb, controller.boardName as BoardName, ledPlacements);

        // Get queue state for navigation context
        const queueState = await roomManager.getQueueState(sessionId);
        const currentIndex = findClimbIndex(queueState.queue, currentItemUuid);
        const navigation = buildNavigationContext(queueState.queue, currentIndex);

        return {
          __typename: 'LedUpdate',
          commands,
          queueItemUuid: currentItemUuid,
          climbUuid: climb.uuid,
          climbName: climb.name,
          climbGrade: climb.difficulty,
          gradeColor: getGradeColor(climb.difficulty),
          boardPath,
          angle: climb.angle,
          navigation,
          clientId,
        };
      };

      // Create subscription to queue events
      const asyncIterator = await createAsyncIterator<ControllerEvent>((push) => {
        // Event queue to ensure events are processed and sent in order
        // This prevents race conditions where QueueSync and LedUpdate arrive out of order
        let eventQueue: Promise<void> = Promise.resolve();

        // Subscribe to queue updates for this session
        return pubsub.subscribeQueue(sessionId, (queueEvent) => {

          // Handle queue modification events - send ControllerQueueSync
          if (queueEvent.__typename === 'QueueItemAdded' ||
              queueEvent.__typename === 'QueueItemRemoved' ||
              queueEvent.__typename === 'QueueReordered') {
            // Queue the async work to ensure ordering
            eventQueue = eventQueue.then(async () => {
              try {
                const queueState = await roomManager.getQueueState(sessionId);
                const queueSync = buildControllerQueueSync(
                  queueState.queue,
                  queueState.currentClimbQueueItem?.uuid
                );
                push(queueSync);
              } catch (error) {
                console.error(`[Controller] Error building queue sync:`, error);
              }
            });
            return;
          }

          // Handle current climb changes and full sync
          // Always send LedUpdate with clientId - ESP32 uses clientId to decide whether to disconnect BLE client
          if (queueEvent.__typename === 'CurrentClimbChanged' || queueEvent.__typename === 'FullSync') {
            // Extract clientId from the event (null for FullSync or system-initiated changes)
            const eventClientId = queueEvent.__typename === 'CurrentClimbChanged'
              ? queueEvent.clientId
              : null;

            const currentItem = queueEvent.__typename === 'CurrentClimbChanged'
              ? queueEvent.item
              : queueEvent.state.currentClimbQueueItem;
            const climb = currentItem?.climb;

            // Queue the async work to ensure ordering
            eventQueue = eventQueue.then(async () => {
              try {
                if (climb) {
                  const ledUpdate = await buildLedUpdateWithNavigation(climb, currentItem?.uuid, eventClientId);
                  push(ledUpdate);
                } else {
                  // No climb - could be clearing or unknown climb
                  const ledUpdate = await buildLedUpdateWithNavigation(null, undefined, eventClientId);
                  push(ledUpdate);
                }
              } catch (error) {
                console.error(`[Controller] Error building LED update:`, error);
              }
            });
          }
        });
      });

      // Send initial queue sync first (so ESP32 has queue state before LED update)
      const initialQueueState = await roomManager.getQueueState(sessionId);
      const initialQueueSync = buildControllerQueueSync(
        initialQueueState.queue,
        initialQueueState.currentClimbQueueItem?.uuid
      );
      yield { controllerEvents: initialQueueSync };

      // Send initial LED state
      const initialClimb = initialQueueState.currentClimbQueueItem?.climb;
      const initialLedUpdate = await buildLedUpdateWithNavigation(
        initialClimb,
        initialQueueState.currentClimbQueueItem?.uuid
      );
      yield { controllerEvents: initialLedUpdate };

      // Yield events from subscription
      // Throttle lastSeenAt updates to once per minute (non-blocking)
      let lastSeenUpdate = Date.now();
      const LAST_SEEN_INTERVAL_MS = 60_000;

      for await (const event of asyncIterator) {
        // Update lastSeenAt periodically (fire-and-forget, non-blocking)
        const now = Date.now();
        if (now - lastSeenUpdate > LAST_SEEN_INTERVAL_MS) {
          lastSeenUpdate = now;
          db.update(esp32Controllers)
            .set({ lastSeenAt: new Date() })
            .where(eq(esp32Controllers.id, controller.id))
            .catch((err) => console.error('[Controller] lastSeenAt update failed:', err));
        }

        yield { controllerEvents: event };
      }
    },
  },
};

/**
 * Type resolver for ControllerEvent union
 */
export const controllerEventResolver = {
  __resolveType(obj: ControllerEvent) {
    if ('commands' in obj) {
      return 'LedUpdate';
    }
    if ('timestamp' in obj) {
      return 'ControllerPing';
    }
    if ('queue' in obj && 'currentIndex' in obj) {
      return 'ControllerQueueSync';
    }
    return null;
  },
};
