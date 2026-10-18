package com.boardsesh.liveactivity

import android.Manifest
import android.app.Application
import android.content.Intent
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * Lifecycle of the logical `sessionActive` flag — the source of the
 * "notification freezes mid-session" and "JS thinks the session started when it
 * didn't" bugs. The controller takes an injectable startForegroundService seam so
 * the ForegroundServiceStartNotAllowedException path is drivable without a live
 * service.
 */
@RunWith(RobolectricTestRunner::class)
class SessionPresenceControllerTest {

    private val application: Application = ApplicationProvider.getApplicationContext()

    private fun recordingController(): Pair<SessionPresenceController, MutableList<Intent>> {
        val launchedIntents = mutableListOf<Intent>()
        val controller = SessionPresenceController(application) { _, intent -> launchedIntents.add(intent) }
        return controller to launchedIntents
    }

    // Stands in for ForegroundServiceStartNotAllowedException (API 31+); launchService
    // catches plain Exception, so the type doesn't matter for the flag logic.
    private fun fgsNotAllowed(): Exception = IllegalStateException("ForegroundServiceStartNotAllowedException")

    private fun updateOptions(): SessionUpdateOptions = SessionUpdateOptions().apply {
        climbName = "Test Climb"
        climbDifficulty = "V5"
        angle = 40
    }

    @Test
    @Config(sdk = [30])
    fun `startSession activates and dispatches a START intent`() {
        val (controller, launchedIntents) = recordingController()

        controller.startSession(null)

        assertTrue(controller.sessionActive)
        assertEquals(1, launchedIntents.size)
        assertEquals(BoardSessionService.ACTION_START, launchedIntents.single().action)
    }

    @Test
    @Config(sdk = [34])
    fun `startSession without BLUETOOTH_CONNECT on API 34 throws and stays inactive`() {
        shadowOf(application).denyPermissions(Manifest.permission.BLUETOOTH_CONNECT)
        val (controller, launchedIntents) = recordingController()

        assertThrows(MissingBluetoothPermissionException::class.java) {
            controller.startSession(null)
        }

        assertFalse(controller.sessionActive)
        assertTrue(launchedIntents.isEmpty())
    }

    @Test
    @Config(sdk = [34])
    fun `startSession with BLUETOOTH_CONNECT on API 34 activates`() {
        shadowOf(application).grantPermissions(Manifest.permission.BLUETOOTH_CONNECT)
        val (controller, launchedIntents) = recordingController()

        controller.startSession(null)

        assertTrue(controller.sessionActive)
        assertEquals(1, launchedIntents.size)
    }

    @Test
    @Config(sdk = [31])
    fun `startup-path launch failure clears sessionActive and rejects startSession`() {
        val startupFailure = fgsNotAllowed()
        val controller = SessionPresenceController(application) { _, _ -> throw startupFailure }

        val thrown = assertThrows(SessionForegroundServiceStartException::class.java) {
            controller.startSession(null)
        }

        // The initial promotion never landed, so later updates must not keep
        // retrying a service that never started. JS also needs the rejection so
        // its active ref resets and a later foregrounded start can retry.
        assertFalse(controller.sessionActive)
        assertSame(startupFailure, thrown.cause)
    }

    @Test
    @Config(sdk = [31])
    fun `update-path launch failure keeps sessionActive`() {
        var failNextLaunch = false
        val launchedIntents = mutableListOf<Intent>()
        val controller = SessionPresenceController(application) { _, intent ->
            if (failNextLaunch) throw fgsNotAllowed()
            launchedIntents.add(intent)
        }

        controller.startSession(null)
        assertTrue(controller.sessionActive)

        // App briefly backgrounds: the UPDATE re-delivery throws, but the service
        // is already running — the session must stay active (the regression this
        // PR fixes; clearing here permanently froze the notification).
        failNextLaunch = true
        controller.updateActivity(updateOptions())
        assertTrue(controller.sessionActive)

        // Back in the foreground, a later update refreshes the notification.
        failNextLaunch = false
        controller.updateActivity(updateOptions())
        assertEquals(BoardSessionService.ACTION_UPDATE, launchedIntents.last().action)
    }

    @Test
    @Config(sdk = [30])
    fun `updateActivity includes flat board angle in the subtitle`() {
        val (controller, launchedIntents) = recordingController()
        controller.startSession(null)

        controller.updateActivity(updateOptions().apply { angle = 0 })

        val updateIntent = launchedIntents.last()
        assertEquals(BoardSessionService.ACTION_UPDATE, updateIntent.action)
        assertEquals("V5 · 0°", updateIntent.getStringExtra(BoardSessionService.EXTRA_SUBTITLE))
    }

    @Test
    @Config(sdk = [30])
    fun `updateActivity omits the degree marker for a negative sentinel angle`() {
        val (controller, launchedIntents) = recordingController()
        controller.startSession(null)

        // The explicit "no angle" sentinel, so the subtitle is the difficulty
        // alone even though other negative values can be real. Referenced by
        // name: this test is the only thing that pins the convention.
        controller.updateActivity(updateOptions().apply { angle = SessionPresenceController.NO_ANGLE })

        assertEquals("V5", launchedIntents.last().getStringExtra(BoardSessionService.EXTRA_SUBTITLE))
    }

    @Test
    @Config(sdk = [30])
    fun `updateActivity includes Grasshopper slab angle in the subtitle`() {
        val (controller, launchedIntents) = recordingController()
        controller.startSession(null)

        controller.updateActivity(updateOptions().apply { angle = -5 })

        assertEquals("V5 · -5°", launchedIntents.last().getStringExtra(BoardSessionService.EXTRA_SUBTITLE))
    }

    @Test
    @Config(sdk = [30])
    fun `startSession forwards the initial board connection and holder`() {
        val (controller, launchedIntents) = recordingController()

        controller.startSession(
            StartSessionOptions().apply {
                boardConnection = "heldByPeer"
                holderDisplayName = "Alex"
            },
        )

        val start = launchedIntents.single()
        assertEquals(BoardSessionService.ACTION_START, start.action)
        assertEquals("heldByPeer", start.getStringExtra(BoardSessionService.EXTRA_BOARD_CONNECTION))
        assertEquals("Alex", start.getStringExtra(BoardSessionService.EXTRA_HOLDER_NAME))
    }

    @Test
    @Config(sdk = [30])
    fun `updateActivity forwards ownership and the on-device thumbnail paths`() {
        val (controller, launchedIntents) = recordingController()
        controller.startSession(null)

        controller.updateActivity(
            updateOptions().apply {
                currentIndex = 1
                totalClimbs = 3
                boardConnection = "heldByPeer"
                holderDisplayName = "Sam"
                androidThumbnailOverlayPath = "file:///cache/overlay.png"
                androidThumbnailBackgroundPaths = listOf("/assets/kilter-bg.png", "/assets/kilter-holds.png")
            },
        )

        val update = launchedIntents.last()
        assertEquals(BoardSessionService.ACTION_UPDATE, update.action)
        assertEquals(3, update.getIntExtra(BoardSessionService.EXTRA_TOTAL_CLIMBS, -1))
        assertEquals("heldByPeer", update.getStringExtra(BoardSessionService.EXTRA_BOARD_CONNECTION))
        assertEquals("Sam", update.getStringExtra(BoardSessionService.EXTRA_HOLDER_NAME))
        assertEquals("file:///cache/overlay.png", update.getStringExtra(BoardSessionService.EXTRA_OVERLAY_PATH))
        assertEquals(
            arrayListOf("/assets/kilter-bg.png", "/assets/kilter-holds.png"),
            update.getStringArrayListExtra(BoardSessionService.EXTRA_BACKGROUND_PATHS),
        )
    }

    @Test
    @Config(sdk = [30])
    fun `updateActivity before a session starts is a no-op`() {
        val (controller, launchedIntents) = recordingController()

        controller.updateActivity(updateOptions())

        assertFalse(controller.sessionActive)
        assertTrue(launchedIntents.isEmpty())
    }

    @Test
    @Config(sdk = [30])
    fun `endSession deactivates and tears down via ACTION_STOP`() {
        val (controller, launchedIntents) = recordingController()
        controller.startSession(null)

        controller.endSession()

        // Teardown must go through the service's promote-then-stop ACTION_STOP
        // path (not stopService): a start token from startSession may still be
        // pending, and bypassing onStartCommand leaves it dangling — the
        // ForegroundServiceDidNotStartInTimeException kill on Android 12-14.
        assertFalse(controller.sessionActive)
        assertEquals(BoardSessionService.ACTION_STOP, launchedIntents.last().action)
    }

    @Test
    @Config(sdk = [31])
    fun `endSession falls back to stopService when ACTION_STOP delivery throws`() {
        var failNextLaunch = false
        val controller = SessionPresenceController(application) { _, _ ->
            if (failNextLaunch) throw fgsNotAllowed()
        }
        controller.startSession(null)

        // Service already gone and app backgrounded: the ACTION_STOP delivery
        // throws, but the session must still end locally without rethrowing.
        failNextLaunch = true
        controller.endSession()

        assertFalse(controller.sessionActive)
    }

    @Test
    @Config(sdk = [30])
    fun `endSession without an active session skips the foreground start`() {
        val (controller, launchedIntents) = recordingController()

        // No session window means no pending start token; ACTION_STOP via
        // startForegroundService would briefly promote a fresh service just to
        // stop it (a notification flash), so this path must stay stopService.
        controller.endSession()

        assertFalse(controller.sessionActive)
        assertTrue(launchedIntents.isEmpty())
    }

    private fun restOptions(sessionId: String = "session-1"): RestTimerOptions = RestTimerOptions().apply {
        this.sessionId = sessionId
        status = BoardSessionService.REST_STATUS_RUNNING
        startMs = 1_000_000.0
        deadlineMs = 1_090_000.0
        targetSeconds = 90.0
        androidCaption = "Rest"
        androidOverCaption = "Over your rest"
    }

    private fun startedController(sessionId: String = "session-1"): Pair<SessionPresenceController, MutableList<Intent>> {
        val (controller, launchedIntents) = recordingController()
        controller.startSession(StartSessionOptions().apply { this.sessionId = sessionId })
        launchedIntents.clear()
        return controller to launchedIntents
    }

    @Test
    @Config(sdk = [30])
    fun `updateRestTimer forwards the countdown to the service as a REST_TIMER intent`() {
        val (controller, launchedIntents) = startedController()

        controller.updateRestTimer(restOptions())

        val intent = launchedIntents.single()
        assertEquals(BoardSessionService.ACTION_REST_TIMER, intent.action)
        assertEquals("session-1", intent.getStringExtra(BoardSessionService.EXTRA_SESSION_ID))
        assertEquals("running", intent.getStringExtra(BoardSessionService.EXTRA_REST_STATUS))
        assertEquals(1_000_000L, intent.getLongExtra(BoardSessionService.EXTRA_REST_START_MS, -1))
        assertEquals(1_090_000L, intent.getLongExtra(BoardSessionService.EXTRA_REST_DEADLINE_MS, -1))
        assertFalse(intent.hasExtra(BoardSessionService.EXTRA_REST_PERIOD_SECONDS))
        assertFalse(intent.hasExtra(BoardSessionService.EXTRA_REST_FROZEN_SECONDS))
        assertEquals("Rest", intent.getStringExtra(BoardSessionService.EXTRA_REST_CAPTION))
        assertEquals("Over your rest", intent.getStringExtra(BoardSessionService.EXTRA_REST_OVER_CAPTION))
        assertFalse(intent.getBooleanExtra(BoardSessionService.EXTRA_REST_CLEAR, false))
        assertEquals("session-1", controller.restTimer?.sessionId)
    }

    @Test
    @Config(sdk = [30])
    fun `updateRestTimer with null clears the countdown`() {
        val (controller, launchedIntents) = startedController()
        controller.updateRestTimer(restOptions())

        controller.updateRestTimer(null)

        val clear = launchedIntents.last()
        assertEquals(BoardSessionService.ACTION_REST_TIMER, clear.action)
        assertTrue(clear.getBooleanExtra(BoardSessionService.EXTRA_REST_CLEAR, false))
        assertEquals(null, controller.restTimer)
    }

    @Test
    @Config(sdk = [30])
    fun `updateRestTimer ignores a countdown for another session`() {
        val (controller, launchedIntents) = startedController(sessionId = "session-1")

        controller.updateRestTimer(restOptions(sessionId = "session-0"))

        assertTrue(launchedIntents.isEmpty())
        assertEquals(null, controller.restTimer)
    }

    @Test
    @Config(sdk = [30])
    fun `updateRestTimer before a session starts is a no-op`() {
        val (controller, launchedIntents) = recordingController()

        controller.updateRestTimer(restOptions())

        assertTrue(launchedIntents.isEmpty())
        assertEquals(null, controller.restTimer)
    }

    @Test
    @Config(sdk = [30])
    fun `updateRestTimer drops non-finite numbers instead of sending zero`() {
        val (controller, launchedIntents) = startedController()

        controller.updateRestTimer(restOptions().apply {
            deadlineMs = Double.NaN
            frozenSignedSeconds = -12.6
        })

        val intent = launchedIntents.single()
        assertFalse(intent.hasExtra(BoardSessionService.EXTRA_REST_DEADLINE_MS))
        // Truncates toward zero, matching the app's formatRestTimerSigned.
        assertEquals(-12L, intent.getLongExtra(BoardSessionService.EXTRA_REST_FROZEN_SECONDS, 0))
    }

    @Test
    @Config(sdk = [30])
    fun `ending or restarting a session forgets the countdown`() {
        val (controller, _) = startedController(sessionId = "session-1")
        controller.updateRestTimer(restOptions())

        controller.endSession()
        assertEquals(null, controller.restTimer)

        controller.startSession(StartSessionOptions().apply { sessionId = "session-2" })
        controller.updateRestTimer(restOptions(sessionId = "session-1"))
        assertEquals(null, controller.restTimer)
    }
}
