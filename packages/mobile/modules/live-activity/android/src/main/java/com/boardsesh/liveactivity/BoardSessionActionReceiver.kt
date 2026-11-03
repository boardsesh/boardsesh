package com.boardsesh.liveactivity

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Receives the Previous/Next/lightbulb taps from the ongoing session notification
 * and forwards them to SessionPresenceModule. Previous/Next become `queueNavigate`
 * events (the same { action, currentIndex, correlationId } shape the iOS widget's
 * Darwin-notification → JS bridge uses, so live-activity-bridge.tsx handles both
 * platforms with no branching); the lightbulb becomes a `boardControl` event.
 *
 * Previous / Next light the wall through JS (its auto-sender writes the new
 * climb as the event lands), so the press starts or renews Put on board's
 * timed drive (2.7, Stop driving after) there too, at the wall's lit confirm
 * (`armNotificationPressDrive` in lock-screen-lighting.ts), and JS sends it
 * back through `updateLightingWindow`. Nothing is written here: a press the
 * party server turns down, or whose write fails, never shows a drive. (iOS
 * differs: its intent lights the wall itself, so it records the drive after
 * its own write succeeds.)
 */
class BoardSessionActionReceiver : BroadcastReceiver() {
    companion object {
        /**
         * The `boardControl` action for a lightbulb tap, or null for none.
         *
         * Relay mode (#7220): a relaying phone's bulb stops its relayed drive
         * or relays the climb (`relay`); a phone blocked by the holder of a
         * Relay mode board never reconnects (the notification draws no bulb
         * then, so only a stale one lands here). Neither ever reconnects.
         */
        internal fun bulbAction(intent: Intent): String? {
            val connectedByMe =
                intent.getStringExtra(BoardSessionService.EXTRA_BOARD_CONNECTION) ==
                    BoardSessionService.CONNECTION_CONNECTED_BY_ME
            val stopsDrive = intent.getBooleanExtra(BoardSessionService.EXTRA_STOPS_DRIVE, false)
            if (!connectedByMe) {
                return when (BoardSessionService.relayFrom(intent)) {
                    BoardSessionService.RELAY_RELAYING -> if (stopsDrive) "stopDriving" else "relay"
                    BoardSessionService.RELAY_BLOCKED -> null
                    else -> "reconnect"
                }
            }
            return if (stopsDrive) "stopDriving" else "reassert"
        }
    }

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
                SessionPresenceModule.dispatchQueueNavigate(
                    "previous",
                    intent.getIntExtra(BoardSessionService.EXTRA_CURRENT_INDEX, 0),
                    correlationId,
                )
            }
            BoardSessionService.ACTION_NAV_NEXT -> {
                SessionPresenceModule.dispatchQueueNavigate(
                    "next",
                    intent.getIntExtra(BoardSessionService.EXTRA_CURRENT_INDEX, 0),
                    correlationId,
                )
            }
            // Lightbulb tap: the action depends on who held the board when the
            // notification was last built (carried on the PendingIntent extra).
            // connectedByMe → stop driving when the bulb was drawn as Stop
            // driving (JS checks the drive is still on), else re-light the
            // current climb; otherwise reconnect (taking the board back from a
            // peer / reconnecting after a drop).
            BoardSessionService.ACTION_BULB -> {
                bulbAction(intent)?.let { SessionPresenceModule.dispatchBoardControl(it, correlationId) }
            }
        }
    }
}
