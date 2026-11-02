package com.boardsesh.liveactivity

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.content.ContextCompat

/**
 * Receives the Previous/Next/lightbulb taps from the ongoing session notification
 * and forwards them to SessionPresenceModule. Previous/Next become `queueNavigate`
 * events (the same { action, currentIndex, correlationId } shape the iOS widget's
 * Darwin-notification → JS bridge uses, so live-activity-bridge.tsx handles both
 * platforms with no branching); the lightbulb becomes a `boardControl` event.
 *
 * Previous / Next light the wall (JS writes the new climb as the event lands),
 * so each press also opens or renews Put on board's keep-lighting window (2.7)
 * here, from the settings JS mirrored ([LightingWindowStore]), and shows it on
 * the notification at once. JS adopts that window when it handles the press,
 * or when the app next comes to the foreground.
 */
class BoardSessionActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val correlationId = intent.getStringExtra(BoardSessionService.EXTRA_CORRELATION_ID) ?: ""
        when (intent.action) {
            BoardSessionService.ACTION_MIRROR -> {
                val sessionId = intent.getStringExtra(BoardSessionService.EXTRA_SESSION_ID) ?: return
                val queueItemUuid = intent.getStringExtra(BoardSessionService.EXTRA_QUEUE_ITEM_UUID) ?: return
                if (sessionId.isBlank() || queueItemUuid.isBlank() || !intent.hasExtra(BoardSessionService.EXTRA_MIRRORED)) return
                SessionPresenceModule.dispatchMirror(sessionId, queueItemUuid, intent.getBooleanExtra(BoardSessionService.EXTRA_MIRRORED, false))
            }
            BoardSessionService.ACTION_NAV_PREVIOUS -> {
                renewLightingWindow(context, intent)
                SessionPresenceModule.dispatchQueueNavigate(
                    "previous",
                    intent.getIntExtra(BoardSessionService.EXTRA_CURRENT_INDEX, 0),
                    correlationId,
                )
            }
            BoardSessionService.ACTION_NAV_NEXT -> {
                renewLightingWindow(context, intent)
                SessionPresenceModule.dispatchQueueNavigate(
                    "next",
                    intent.getIntExtra(BoardSessionService.EXTRA_CURRENT_INDEX, 0),
                    correlationId,
                )
            }
            // Lightbulb tap: the action depends on who held the board when the
            // notification was last built (carried on the PendingIntent extra).
            // connectedByMe → re-light the current climb; otherwise reconnect
            // (taking the board back from a peer / reconnecting after a drop).
            BoardSessionService.ACTION_BULB -> {
                val connectedByMe =
                    intent.getStringExtra(BoardSessionService.EXTRA_BOARD_CONNECTION) ==
                        BoardSessionService.CONNECTION_CONNECTED_BY_ME
                SessionPresenceModule.dispatchBoardControl(if (connectedByMe) "reassert" else "reconnect", correlationId)
            }
        }
    }

    // Written before the event is dispatched, so JS finds the window when it
    // handles the press. A PendingIntent from an older notification carries no
    // session and opens nothing. The service is already in the foreground, so
    // this start only re-delivers; a failure costs the header its clock until
    // JS sends the same window.
    private fun renewLightingWindow(context: Context, intent: Intent) {
        val sessionId = intent.getStringExtra(BoardSessionService.EXTRA_SESSION_ID)?.takeIf { it.isNotBlank() } ?: return
        val snapshot = LightingWindowStore.recordPress(context, sessionId, wallClockMs()) ?: return
        try {
            ContextCompat.startForegroundService(context, BoardSessionService.lightingIntent(context, sessionId, snapshot))
        } catch (error: Exception) {
            Log.w(TAG, "lighting window re-delivery failed: ${error.message}")
        }
    }

    companion object {
        private const val TAG = "BoardSession"

        /** The clock a press is stamped with; a test pins it. */
        internal var wallClockMs: () -> Long = { System.currentTimeMillis() }
    }
}
