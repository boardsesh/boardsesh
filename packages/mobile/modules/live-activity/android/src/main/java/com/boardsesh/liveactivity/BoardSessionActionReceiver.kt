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
 */
class BoardSessionActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val correlationId = intent.getStringExtra(BoardSessionService.EXTRA_CORRELATION_ID) ?: ""
        when (intent.action) {
            BoardSessionService.ACTION_NAV_PREVIOUS ->
                SessionPresenceModule.dispatchQueueNavigate(
                    "previous",
                    intent.getIntExtra(BoardSessionService.EXTRA_CURRENT_INDEX, 0),
                    correlationId,
                )
            BoardSessionService.ACTION_NAV_NEXT ->
                SessionPresenceModule.dispatchQueueNavigate(
                    "next",
                    intent.getIntExtra(BoardSessionService.EXTRA_CURRENT_INDEX, 0),
                    correlationId,
                )
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
}
