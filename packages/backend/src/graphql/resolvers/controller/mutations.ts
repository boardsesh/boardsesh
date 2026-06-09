import type {
  ConnectionContext,
  ControllerRegistration,
  RegisterControllerInput,
  LedCommand,
  ClimbMatchResult,
  ClimbQueueItem,
  BoardName,
  SendDeviceLogsInput,
  SendDeviceLogsResponse,
} from '@boardsesh/shared-schema';
import { logger } from '../../../utils/logger';
import { findClimbIndex } from './navigation-helpers';
import { db } from '../../../db/client';
import { esp32Controllers } from '@boardsesh/db/schema/app';
import { eq, and } from 'drizzle-orm';
import {
  requireAuthenticated,
  applyRateLimit,
  requireControllerAuth,
  requireControllerAuthorizedForSession,
} from '../shared/helpers';
import { randomBytes, randomUUID } from 'crypto';
import { matchClimbByFrames, getClimbByUuid } from '../../../db/queries/climbs';
import { roomManager } from '../../../services/room-manager';
import { pubsub } from '../../../pubsub';
import { buildFramesString } from '@boardsesh/board-constants/led-placements';
import { forwardLogs, type DeviceLog } from '../../../services/axiom';

/**
 * Generate a secure random API key
 */
function generateApiKey(): string {
  return randomBytes(32).toString('hex');
}

export const controllerMutations = {
  /**
   * Register a new ESP32 controller
   * Generates a unique API key for the controller
   * Requires authentication
   */
  registerController: async (
    _: unknown,
    { input }: { input: RegisterControllerInput },
    ctx: ConnectionContext,
  ): Promise<ControllerRegistration> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 10); // Lower limit for controller registration

    if (!ctx.userId) {
      throw new Error('User ID not available');
    }

    const apiKey = generateApiKey();

    const [controller] = await db
      .insert(esp32Controllers)
      .values({
        userId: ctx.userId,
        apiKey,
        name: input.name ?? null,
        boardName: input.boardName,
        layoutId: input.layoutId,
        sizeId: input.sizeId,
        setIds: input.setIds,
      })
      .returning();

    return {
      apiKey,
      controllerId: controller.id,
    };
  },

  /**
   * Delete a registered controller
   * Only the owner can delete their controller
   * Requires authentication
   */
  deleteController: async (
    _: unknown,
    { controllerId }: { controllerId: string },
    ctx: ConnectionContext,
  ): Promise<boolean> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx);

    if (!ctx.userId) {
      throw new Error('User ID not available');
    }

    await db
      .delete(esp32Controllers)
      .where(and(eq(esp32Controllers.id, controllerId), eq(esp32Controllers.userId, ctx.userId)));

    return true;
  },

  /**
   * ESP32 controller sends frames string (or LED positions) received from official app Bluetooth
   * Backend attempts to match against known climbs and sets as current climb if found
   * Uses controller API key authentication via connectionParams
   *
   * @param frames - Pre-built frames string from ESP32 (preferred method)
   * @param positions - Legacy LED positions array (for backwards compatibility)
   */
  setClimbFromLedPositions: async (
    _: unknown,
    {
      sessionId,
      frames,
      positions,
    }: {
      sessionId: string;
      frames?: string;
      positions?: LedCommand[];
    },
    ctx: ConnectionContext,
  ): Promise<ClimbMatchResult> => {
    await applyRateLimit(ctx, 30); // Moderate limit for LED position updates

    // Verify controller is authenticated and authorized for this session
    const { controllerId } = await requireControllerAuthorizedForSession(ctx, sessionId);

    // Get controller details
    const [controller] = await db.select().from(esp32Controllers).where(eq(esp32Controllers.id, controllerId)).limit(1);

    if (!controller) {
      throw new Error('Controller not found');
    }

    // Update lastSeenAt
    await db.update(esp32Controllers).set({ lastSeenAt: new Date() }).where(eq(esp32Controllers.id, controller.id));

    // Require either frames or positions
    if (!frames && (!positions || positions.length === 0)) {
      logger.info(`[Controller] No frames or positions provided for session ${sessionId}`);
      return {
        matched: false,
        climbUuid: null,
        climbName: null,
      };
    }

    // Get current session state to determine angle from current climb
    const currentState = await roomManager.getQueueState(sessionId);
    const angle = currentState.currentClimbQueueItem?.climb?.angle ?? 40;

    logger.info(
      `[Controller] Matching climb for session ${sessionId} at angle ${angle}, frames: ${frames ? 'provided' : 'not provided'}, positions: ${positions?.length ?? 0}`,
    );

    // Build frames string from positions if not provided directly
    let framesString = frames;
    if (!framesString && positions && positions.length > 0) {
      framesString = buildFramesString(
        positions.map((p) => ({
          position: p.position,
          r: p.r,
          g: p.g,
          b: p.b,
          role: p.role,
        })),
        controller.boardName as BoardName,
        controller.layoutId,
        controller.sizeId,
      );
      logger.info(`[Controller] Built frames string from ${positions.length} positions: ${framesString}`);
    }

    if (!framesString) {
      logger.info(`[Controller] Could not build frames string for session ${sessionId}`);
      return {
        matched: false,
        climbUuid: null,
        climbName: null,
      };
    }

    // Find matching climb by frames string
    const match = await matchClimbByFrames(controller.boardName as BoardName, controller.layoutId, framesString, angle);

    if (!match) {
      logger.info(`[Controller] No climb found matching frames for session ${sessionId}`);

      // Publish event so ESP32 display shows "Unknown Climb" with ability to navigate back
      // Use controllerMac as clientId so ESP32 can compare with its own MAC address
      const clientIdForEvent = ctx.controllerMac || controllerId;
      logger.info(`[Controller] Publishing CurrentClimbChanged (no match) with clientId: ${clientIdForEvent}`);
      pubsub.publishQueueEvent(sessionId, {
        __typename: 'CurrentClimbChanged',
        sequence: currentState.sequence,
        stateHash: currentState.stateHash,
        item: null, // No queue item for unknown climb
        frames: framesString,
        clientId: clientIdForEvent, // ESP32 compares this with its MAC
        correlationId: null,
      });

      return {
        matched: false,
        climbUuid: null,
        climbName: null,
      };
    }

    // Get full climb data
    const climb = await getClimbByUuid({
      board_name: controller.boardName as BoardName,
      layout_id: controller.layoutId,
      size_id: controller.sizeId,
      angle,
      climb_uuid: match.uuid,
    });

    if (!climb) {
      logger.info(`[Controller] Climb data not found for matched UUID: ${match.uuid}`);
      return {
        matched: false,
        climbUuid: null,
        climbName: null,
      };
    }

    // Create queue item and set as current climb
    const queueItem: ClimbQueueItem = {
      uuid: randomUUID(),
      climb,
      suggested: true,
    };

    // Insert the new climb after the current climb in the queue (matching double-click behavior)
    const currentIndex = currentState.currentClimbQueueItem
      ? currentState.queue.findIndex(({ uuid }) => uuid === currentState.currentClimbQueueItem?.uuid)
      : -1;

    // Insert after current climb, or at end if no current climb
    const updatedQueue =
      currentIndex === -1
        ? [...currentState.queue, queueItem]
        : [...currentState.queue.slice(0, currentIndex + 1), queueItem, ...currentState.queue.slice(currentIndex + 1)];

    const { sequence, stateHash } = await roomManager.updateQueueState(sessionId, updatedQueue, queueItem);

    // Publish a FullSync for clients because one mutation changed both queue
    // membership and current climb. The controller-specific CurrentClimbChanged
    // follows so ESP32 clients still receive the originating clientId.
    pubsub.publishQueueEvent(sessionId, {
      __typename: 'FullSync',
      sequence,
      state: {
        sequence,
        stateHash,
        queue: updatedQueue,
        currentClimbQueueItem: queueItem,
      },
    });

    // Publish CurrentClimbChanged event with controllerMac as clientId
    // ESP32 compares this with its own MAC address to decide whether to disconnect BLE client
    const matchClientId = ctx.controllerMac || controllerId;
    logger.info(`[Controller] Publishing CurrentClimbChanged with clientId: ${matchClientId}`);
    pubsub.publishQueueEvent(sessionId, {
      __typename: 'CurrentClimbChanged',
      sequence,
      stateHash,
      item: queueItem,
      clientId: matchClientId,
      correlationId: null,
    });

    logger.info(`[Controller] Matched climb: ${match.name} (${match.uuid})`);
    return {
      matched: true,
      climbUuid: match.uuid,
      climbName: match.name,
    };
  },

  /**
   * ESP32 controller heartbeat to update lastSeenAt
   * Uses API key authentication via connectionParams
   */
  controllerHeartbeat: async (
    _: unknown,
    { sessionId: _sessionId }: { sessionId: string },
    ctx: ConnectionContext,
  ): Promise<boolean> => {
    await applyRateLimit(ctx, 120); // Allow frequent heartbeats

    // Validate API key authentication via context
    const { controllerApiKey } = requireControllerAuth(ctx);

    // Update lastSeenAt
    await db
      .update(esp32Controllers)
      .set({ lastSeenAt: new Date() })
      .where(eq(esp32Controllers.apiKey, controllerApiKey));

    return true;
  },

  /**
   * Authorize a controller for a specific session
   * This allows the controller to subscribe to events and send LED data for this session
   * Requires user authentication - only the controller owner can authorize it
   */
  authorizeControllerForSession: async (
    _: unknown,
    { controllerId, sessionId }: { controllerId: string; sessionId: string },
    ctx: ConnectionContext,
  ): Promise<boolean> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx);

    if (!ctx.userId) {
      throw new Error('User ID not available');
    }

    // Verify the user owns this controller
    const [controller] = await db
      .select()
      .from(esp32Controllers)
      .where(and(eq(esp32Controllers.id, controllerId), eq(esp32Controllers.userId, ctx.userId)))
      .limit(1);

    if (!controller) {
      throw new Error('Controller not found or not owned by user');
    }

    // Update the controller's authorized session
    await db
      .update(esp32Controllers)
      .set({ authorizedSessionId: sessionId })
      .where(eq(esp32Controllers.id, controllerId));

    logger.info(`[Controller] Controller ${controllerId} authorized for session ${sessionId}`);
    return true;
  },

  /**
   * Navigate to the previous or next climb in the queue
   * Used by ESP32 controller to browse the queue via hardware buttons
   *
   * @param sessionId - Session ID to navigate within
   * @param direction - "next" or "previous" (fallback if queueItemUuid not provided)
   * @param currentClimbUuid - DEPRECATED: UUID of climb currently displayed (unreliable with duplicates)
   * @param queueItemUuid - Directly navigate to this queue item (preferred, unique per position)
   * @returns The new current climb, or null if navigation failed
   */
  navigateQueue: async (
    _: unknown,
    {
      sessionId,
      direction,
      currentClimbUuid,
      queueItemUuid,
    }: { sessionId: string; direction: string; currentClimbUuid?: string; queueItemUuid?: string },
    ctx: ConnectionContext,
  ): Promise<ClimbQueueItem | null> => {
    await applyRateLimit(ctx, 30);

    // Verify controller is authenticated and authorized for this session
    await requireControllerAuthorizedForSession(ctx, sessionId);

    // Get current queue state
    const currentState = await roomManager.getQueueState(sessionId);
    const { queue, currentClimbQueueItem } = currentState;

    if (queue.length === 0) {
      logger.info(`[Controller] Navigate: queue is empty`);
      return null;
    }

    let newCurrentClimb: ClimbQueueItem;
    let targetIndex: number;

    // If queueItemUuid is provided, navigate directly to that item (preferred method)
    if (queueItemUuid) {
      targetIndex = queue.findIndex((item) => item.uuid === queueItemUuid);
      if (targetIndex === -1) {
        logger.info(`[Controller] Navigate: queueItemUuid ${queueItemUuid} not found in queue`);
        // Fall back to direction-based navigation
      } else {
        newCurrentClimb = queue[targetIndex];
        logger.info(
          `[Controller] Navigate: direct to queueItemUuid ${queueItemUuid}, index ${targetIndex}, climb: ${newCurrentClimb.climb.name}`,
        );

        // Update queue state
        const { sequence, stateHash } = await roomManager.updateQueueState(sessionId, queue, newCurrentClimb);

        // Publish CurrentClimbChanged event
        pubsub.publishQueueEvent(sessionId, {
          __typename: 'CurrentClimbChanged',
          sequence,
          stateHash,
          item: newCurrentClimb,
          clientId: null,
          correlationId: null,
        });

        return newCurrentClimb;
      }
    }

    // Validate direction for fallback navigation
    if (direction !== 'next' && direction !== 'previous') {
      throw new Error('Invalid direction. Must be "next" or "previous".');
    }

    // Find current position in queue using queue item UUID or climb UUID
    const referenceUuid = currentClimbUuid || currentClimbQueueItem?.uuid;
    const currentIndex = findClimbIndex(queue, referenceUuid);

    logger.info(
      `[Controller] Navigate ${direction}: using referenceUuid=${referenceUuid} (from ESP32: ${!!currentClimbUuid}), found at index ${currentIndex}`,
    );

    // Calculate target index based on direction
    if (direction === 'next') {
      // Move forward in queue
      if (currentIndex === -1) {
        // No current climb, start at beginning
        targetIndex = 0;
      } else if (currentIndex >= queue.length - 1) {
        // Already at end, stay there
        logger.info(`[Controller] Navigate next: already at end of queue`);
        return queue[currentIndex]; // Return the climb at current index
      } else {
        targetIndex = currentIndex + 1;
      }
    } else {
      // Move backward in queue (previous)
      if (currentIndex === -1) {
        // No current climb, start at end
        targetIndex = queue.length - 1;
      } else if (currentIndex <= 0) {
        // Already at beginning, stay there
        logger.info(`[Controller] Navigate previous: already at start of queue`);
        return queue[currentIndex]; // Return the climb at current index
      } else {
        targetIndex = currentIndex - 1;
      }
    }

    // Get the new current climb
    newCurrentClimb = queue[targetIndex];

    logger.info(
      `[Controller] Navigate ${direction}: index ${currentIndex} -> ${targetIndex}, climb: ${newCurrentClimb.climb.name} (queueItem uuid: ${newCurrentClimb.uuid})`,
    );
    logger.info(`[Controller] Queue has ${queue.length} items, updating current to index ${targetIndex}`);

    // Update queue state (keep the same queue, just change current climb)
    const { sequence, stateHash } = await roomManager.updateQueueState(sessionId, queue, newCurrentClimb);

    // Publish CurrentClimbChanged event WITHOUT clientId
    // Unlike setClimbFromLedPositions (where we skip because ESP32 already has LEDs from BLE),
    // navigation NEEDS to send LedUpdate back to the ESP32 since it's moving to a different climb
    pubsub.publishQueueEvent(sessionId, {
      __typename: 'CurrentClimbChanged',
      sequence,
      stateHash,
      item: newCurrentClimb,
      clientId: null, // Don't skip - ESP32 needs the new climb data
      correlationId: null,
    });

    return newCurrentClimb;
  },

  /**
   * Receive device logs from ESP32 controller and forward to Axiom
   * Uses API key authentication via connectionParams
   */
  sendDeviceLogs: async (
    _: unknown,
    { input }: { input: SendDeviceLogsInput },
    ctx: ConnectionContext,
  ): Promise<SendDeviceLogsResponse> => {
    await applyRateLimit(ctx, 100); // Allow frequent log batches

    const { controllerId } = requireControllerAuth(ctx);

    // Enrich logs with controller ID and convert to Axiom format
    const enrichedLogs: DeviceLog[] = input.logs.map((log) => {
      let metadata: Record<string, unknown> = {};
      if (log.metadata) {
        try {
          metadata = JSON.parse(log.metadata);
        } catch {
          // Invalid JSON in metadata, ignore
        }
      }

      return {
        _time: new Date(log.ts).toISOString(),
        controller_id: controllerId,
        level: log.level,
        component: log.component,
        message: log.message,
        ...metadata,
      };
    });

    const success = await forwardLogs(enrichedLogs);

    return {
      success,
      accepted: input.logs.length,
    };
  },
};
