package com.boardsesh.liveactivity

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.os.Looper
import android.os.SystemClock
import android.widget.Chronometer
import android.widget.FrameLayout
import android.widget.TextView
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import androidx.test.core.app.ApplicationProvider
import io.mockk.every
import io.mockk.just
import io.mockk.mockkStatic
import io.mockk.Runs
import io.mockk.slot
import io.mockk.unmockkStatic
import io.mockk.verify
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.GraphicsMode
import org.robolectric.annotation.Config
import java.util.concurrent.Executor

/**
 * The startInForeground retry path: a connectedDevice FGS promotes with the typed
 * call, and on API < 34 falls back to an untyped promotion if the typed one fails;
 * on API 34+ there is no untyped fallback (the module gates the start on
 * BLUETOOTH_CONNECT instead). ServiceCompat.startForeground is statically mocked so
 * each type's outcome is controllable without a real foreground promotion.
 */
@RunWith(RobolectricTestRunner::class)
class BoardSessionServiceTest {

    @Test
    @Config(sdk = [30])
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun `mirror flips thumbnail pixels and leaves source bitmap unchanged`() {
        val bitmap = Bitmap.createBitmap(2, 1, Bitmap.Config.ARGB_8888)
        bitmap.setPixel(0, 0, android.graphics.Color.RED)
        bitmap.setPixel(1, 0, android.graphics.Color.BLUE)
        val mirrored = BoardSessionService.orientThumbnail(bitmap, true)
        assertEquals(android.graphics.Color.BLUE, mirrored.getPixel(0, 0))
        assertEquals(android.graphics.Color.RED, mirrored.getPixel(1, 0))
        assertEquals(android.graphics.Color.RED, bitmap.getPixel(0, 0))
        assertSame(bitmap, BoardSessionService.orientThumbnail(bitmap, false))
    }

    @Test
    @Config(sdk = [31])
    fun `mirror content button requires supported board and ownership and retains navigation`() {
        val captured = slot<Notification>()
        every { ServiceCompat.startForeground(any(), any(), capture(captured), any()) } just Runs
        val service = startService()
        fun update(connection: String, supported: Boolean, mirrored: Boolean = false) {
            service.onStartCommand(updateIntent(connection, hasPrevious = true, hasNext = true).apply {
                putExtra(BoardSessionService.EXTRA_SESSION_ID, "session")
                putExtra(BoardSessionService.EXTRA_QUEUE_ITEM_UUID, "queue-item")
                putExtra(BoardSessionService.EXTRA_SUPPORTS_MIRRORING, supported)
                putExtra(BoardSessionService.EXTRA_MIRRORED, mirrored)
            }, 0, 2)
        }
        for (layout in listOf(R.layout.notification_session_collapsed, R.layout.notification_session_expanded)) {
            update("connectedByMe", true, true)
            val content = service.buildContentView(layout).apply(context, FrameLayout(context))
            val button = content.findViewById<android.widget.ImageButton>(R.id.session_mirror)
            assertEquals(android.view.View.VISIBLE, button.visibility)
            assertEquals("Unmirror climb", button.contentDescription)
            assertEquals(listOf("Previous", "Relight wall", "Next"), actionTitles(captured.captured))
            update("heldByPeer", true)
            assertEquals(android.view.View.GONE, service.buildContentView(layout)
                .apply(context, FrameLayout(context)).findViewById<android.view.View>(R.id.session_mirror).visibility)
            update("connectedByMe", false)
            assertEquals(android.view.View.GONE, service.buildContentView(layout)
                .apply(context, FrameLayout(context)).findViewById<android.view.View>(R.id.session_mirror).visibility)
        }
    }

    private val connectedDevice = ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE

    private val context: Context get() = ApplicationProvider.getApplicationContext()

    @Before
    fun setUp() {
        mockkStatic(ServiceCompat::class)
        // stopForeground is invoked on the teardown path; stub so the static mock
        // doesn't reject the unstubbed call.
        every { ServiceCompat.stopForeground(any(), any<Int>()) } just Runs
        // The thumbnail cache + in-flight set are process-static; reset so one
        // test's warmed bitmap can't turn another's expected fetch into a hit.
        BoardSessionService.resetImageStateForTest()
        context.getSystemService(NotificationManager::class.java).cancelAll()
    }

    @After
    fun tearDown() {
        unmockkStatic(ServiceCompat::class)
    }

    private fun startService(action: String = BoardSessionService.ACTION_START): BoardSessionService {
        val intent = Intent(ApplicationProvider.getApplicationContext(), BoardSessionService::class.java)
            .apply { this.action = action }
        return Robolectric.buildService(BoardSessionService::class.java, intent).create().startCommand(0, 1).get()
    }

    // Starts a service wiring the image seams to run on the calling thread
    // (deterministic async) with an injectable composer.
    private fun startWithImageSeams(
        imageComposer: (String, List<String>) -> Bitmap?,
        executor: Executor = Executor { it.run() },
    ): BoardSessionService {
        val intent = Intent(context, BoardSessionService::class.java).apply {
            action = BoardSessionService.ACTION_START
        }
        val controller = Robolectric.buildService(BoardSessionService::class.java, intent).create()
        val service = controller.get()
        service.imageExecutor = executor
        service.postToMain = { it.run() }
        service.imageComposer = imageComposer
        controller.startCommand(0, 1)
        return service
    }

    private fun updateIntent(
        connection: String,
        hasPrevious: Boolean = false,
        hasNext: Boolean = false,
        holderName: String? = null,
        overlayPath: String? = null,
        backgroundPaths: List<String> = emptyList(),
    ): Intent = Intent(context, BoardSessionService::class.java).apply {
        action = BoardSessionService.ACTION_UPDATE
        putExtra(BoardSessionService.EXTRA_CLIMB_NAME, "Test Climb")
        putExtra(BoardSessionService.EXTRA_SUBTITLE, "V5 · 40°")
        putExtra(BoardSessionService.EXTRA_HAS_PREVIOUS, hasPrevious)
        putExtra(BoardSessionService.EXTRA_HAS_NEXT, hasNext)
        putExtra(BoardSessionService.EXTRA_CURRENT_INDEX, 1)
        putExtra(BoardSessionService.EXTRA_TOTAL_CLIMBS, 3)
        putExtra(BoardSessionService.EXTRA_BOARD_CONNECTION, connection)
        holderName?.let { putExtra(BoardSessionService.EXTRA_HOLDER_NAME, it) }
        overlayPath?.let { putExtra(BoardSessionService.EXTRA_OVERLAY_PATH, it) }
        if (backgroundPaths.isNotEmpty()) {
            putStringArrayListExtra(BoardSessionService.EXTRA_BACKGROUND_PATHS, ArrayList(backgroundPaths))
        }
    }

    private fun actionTitles(notification: Notification): List<String> =
        notification.actions?.map { it.title.toString() } ?: emptyList()

    @Test
    @Config(sdk = [31])
    fun `falls back to an untyped promotion when the typed start fails below API 34`() {
        every { ServiceCompat.startForeground(any(), any(), any(), eq(connectedDevice)) } throws
            IllegalStateException("typed start not allowed")
        every { ServiceCompat.startForeground(any(), any(), any(), eq(0)) } just Runs

        val service = startService()

        verify(exactly = 1) { ServiceCompat.startForeground(any(), any(), any(), eq(connectedDevice)) }
        verify(exactly = 1) { ServiceCompat.startForeground(any(), any(), any(), eq(0)) }
        // Promotion ultimately succeeded, so the service keeps running.
        assertFalse(shadowOf(service).isStoppedBySelf)
    }

    @Test
    @Config(sdk = [31])
    fun `a successful typed promotion skips the untyped fallback`() {
        every { ServiceCompat.startForeground(any(), any(), any(), eq(connectedDevice)) } just Runs
        every { ServiceCompat.startForeground(any(), any(), any(), eq(0)) } just Runs

        val service = startService()

        verify(exactly = 1) { ServiceCompat.startForeground(any(), any(), any(), eq(connectedDevice)) }
        verify(exactly = 0) { ServiceCompat.startForeground(any(), any(), any(), eq(0)) }
        assertFalse(shadowOf(service).isStoppedBySelf)
    }

    @Test
    @Config(sdk = [34])
    fun `does not fall back to an untyped promotion on API 34 and stops on failure`() {
        every { ServiceCompat.startForeground(any(), any(), any(), eq(connectedDevice)) } throws
            IllegalStateException("typed start not allowed")
        every { ServiceCompat.startForeground(any(), any(), any(), eq(0)) } just Runs

        val service = startService()

        verify(exactly = 1) { ServiceCompat.startForeground(any(), any(), any(), eq(connectedDevice)) }
        // Type-0 on a typed service throws MissingForegroundServiceTypeException on
        // API 34+, so the retry must not be attempted.
        verify(exactly = 0) { ServiceCompat.startForeground(any(), any(), any(), eq(0)) }
        // Failed promotion tears the service down rather than risk
        // ForegroundServiceDidNotStartInTimeException.
        assertTrue(shadowOf(service).isStoppedBySelf)
    }

    @Test
    @Config(sdk = [31])
    fun `ACTION_STOP tears the service down after promoting`() {
        every { ServiceCompat.startForeground(any(), any(), any(), any()) } just Runs

        val service = startService(BoardSessionService.ACTION_STOP)

        assertTrue(shadowOf(service).isStoppedBySelf)
    }

    @Test
    @Config(sdk = [30])
    fun `connectedByMe shows Previous, the lit lightbulb, and Next`() {
        val captured = slot<Notification>()
        every { ServiceCompat.startForeground(any(), any(), capture(captured), any()) } just Runs

        val intent = Intent(context, BoardSessionService::class.java).apply { action = BoardSessionService.ACTION_START }
        val controller = Robolectric.buildService(BoardSessionService::class.java, intent).create()
        val service = controller.get()
        controller.startCommand(0, 1)

        service.onStartCommand(updateIntent("connectedByMe", hasPrevious = true, hasNext = true), 0, 2)

        // Driver gets the full transport: Previous, the (relight) lightbulb, Next.
        assertEquals(listOf("Previous", "Relight wall", "Next"), actionTitles(captured.captured))
    }

    @Test
    @Config(sdk = [30])
    fun `connectedByMe shows only the available nav button alongside the lit lightbulb`() {
        val captured = slot<Notification>()
        every { ServiceCompat.startForeground(any(), any(), capture(captured), any()) } just Runs

        val intent = Intent(context, BoardSessionService::class.java).apply { action = BoardSessionService.ACTION_START }
        val controller = Robolectric.buildService(BoardSessionService::class.java, intent).create()
        val service = controller.get()
        controller.startCommand(0, 1)

        // First climb in the queue: only Next (+ the lit bulb), no Previous.
        service.onStartCommand(updateIntent("connectedByMe", hasPrevious = false, hasNext = true), 0, 2)
        assertEquals(listOf("Relight wall", "Next"), actionTitles(captured.captured))

        // Last climb: only Previous (+ the lit bulb), no Next.
        service.onStartCommand(updateIntent("connectedByMe", hasPrevious = true, hasNext = false), 0, 3)
        assertEquals(listOf("Previous", "Relight wall"), actionTitles(captured.captured))
    }

    @Test
    @Config(sdk = [30])
    fun `heldByPeer hides Previous and Next, leaving only the reconnect lightbulb`() {
        val captured = slot<Notification>()
        every { ServiceCompat.startForeground(any(), any(), capture(captured), any()) } just Runs

        val intent = Intent(context, BoardSessionService::class.java).apply { action = BoardSessionService.ACTION_START }
        val controller = Robolectric.buildService(BoardSessionService::class.java, intent).create()
        val service = controller.get()
        controller.startCommand(0, 1)

        // Even with hasNext/hasPrevious true, a non-driver only sees the bulb.
        service.onStartCommand(updateIntent("heldByPeer", hasPrevious = true, hasNext = true, holderName = "Alex"), 0, 2)

        assertEquals(listOf("Connect to board"), actionTitles(captured.captured))
    }

    @Test
    @Config(sdk = [30])
    fun `disconnected leaves only the reconnect lightbulb`() {
        val captured = slot<Notification>()
        every { ServiceCompat.startForeground(any(), any(), capture(captured), any()) } just Runs

        val intent = Intent(context, BoardSessionService::class.java).apply { action = BoardSessionService.ACTION_START }
        val controller = Robolectric.buildService(BoardSessionService::class.java, intent).create()
        val service = controller.get()
        controller.startCommand(0, 1)

        service.onStartCommand(updateIntent("disconnected", hasPrevious = true, hasNext = true), 0, 2)

        assertEquals(listOf("Connect to board"), actionTitles(captured.captured))
    }

    @Test
    @Config(sdk = [30])
    fun `Previous and Next carry the target index, not the current one`() {
        val captured = slot<Notification>()
        every { ServiceCompat.startForeground(any(), any(), capture(captured), any()) } just Runs

        val intent = Intent(context, BoardSessionService::class.java).apply { action = BoardSessionService.ACTION_START }
        val controller = Robolectric.buildService(BoardSessionService::class.java, intent).create()
        val service = controller.get()
        controller.startCommand(0, 1)

        // updateIntent sets currentIndex = 1; the bridge navigates to the absolute
        // queue[index], so Previous must target 0 and Next must target 2.
        service.onStartCommand(updateIntent("connectedByMe", hasPrevious = true, hasNext = true), 0, 2)

        val actions = captured.captured.actions
        val previous = actions.first { it.title.toString() == "Previous" }
        val next = actions.first { it.title.toString() == "Next" }
        assertEquals(0, shadowOf(previous.actionIntent).savedIntent.getIntExtra(BoardSessionService.EXTRA_CURRENT_INDEX, -1))
        assertEquals(2, shadowOf(next.actionIntent).savedIntent.getIntExtra(BoardSessionService.EXTRA_CURRENT_INDEX, -1))
    }

    @Test
    @Config(sdk = [30])
    fun `the lightbulb action carries the current board connection so the receiver picks reassert vs reconnect`() {
        val captured = slot<Notification>()
        every { ServiceCompat.startForeground(any(), any(), capture(captured), any()) } just Runs

        val intent = Intent(context, BoardSessionService::class.java).apply { action = BoardSessionService.ACTION_START }
        val controller = Robolectric.buildService(BoardSessionService::class.java, intent).create()
        val service = controller.get()
        controller.startCommand(0, 1)

        service.onStartCommand(updateIntent("connectedByMe", hasPrevious = true, hasNext = true), 0, 2)

        val bulb = captured.captured.actions.first { it.title.toString() == "Relight wall" }
        val savedIntent = shadowOf(bulb.actionIntent).savedIntent
        assertEquals(BoardSessionService.ACTION_BULB, savedIntent.action)
        assertEquals("connectedByMe", savedIntent.getStringExtra(BoardSessionService.EXTRA_BOARD_CONNECTION))
    }

    @Test
    @Config(sdk = [30])
    fun `the lightbulb action's connection extra updates after a handoff`() {
        val captured = slot<Notification>()
        every { ServiceCompat.startForeground(any(), any(), capture(captured), any()) } just Runs

        val intent = Intent(context, BoardSessionService::class.java).apply { action = BoardSessionService.ACTION_START }
        val controller = Robolectric.buildService(BoardSessionService::class.java, intent).create()
        val service = controller.get()
        controller.startCommand(0, 1)

        // This device drives: the lit bulb carries connectedByMe (→ reassert).
        service.onStartCommand(updateIntent("connectedByMe"), 0, 2)
        val litBulb = captured.captured.actions.first { it.title.toString() == "Relight wall" }
        assertEquals(
            "connectedByMe",
            shadowOf(litBulb.actionIntent).savedIntent.getStringExtra(BoardSessionService.EXTRA_BOARD_CONNECTION),
        )

        // A peer takes over: FLAG_UPDATE_CURRENT must refresh the extra so the
        // outline bulb dispatches reconnect, not a stale reassert (the Android
        // PendingIntent footgun).
        service.onStartCommand(updateIntent("heldByPeer", holderName = "Alex"), 0, 3)
        val outlineBulb = captured.captured.actions.first { it.title.toString() == "Connect to board" }
        assertEquals(
            "heldByPeer",
            shadowOf(outlineBulb.actionIntent).savedIntent.getStringExtra(BoardSessionService.EXTRA_BOARD_CONNECTION),
        )
    }

    @Test
    @Config(sdk = [30])
    fun `the on-the-wall holder line shows for heldByPeer and clears when this device takes the board`() {
        every { ServiceCompat.startForeground(any(), any(), any(), any()) } just Runs
        val intent = Intent(context, BoardSessionService::class.java).apply { action = BoardSessionService.ACTION_START }
        val controller = Robolectric.buildService(BoardSessionService::class.java, intent).create()
        val service = controller.get()
        controller.startCommand(0, 1)

        // A peer holds the board: the expanded card shows "<name> is on the wall".
        service.onStartCommand(updateIntent("heldByPeer", holderName = "Alex"), 0, 2)
        val heldHolder = service.buildContentView(R.layout.notification_session_expanded)
            .apply(context, FrameLayout(context))
            .findViewById<TextView>(R.id.session_holder)
        assertEquals(android.view.View.VISIBLE, heldHolder.visibility)
        assertEquals("Alex is on the wall", heldHolder.text.toString())

        // This device takes the board back. The connectedByMe update simply omits
        // EXTRA_HOLDER_NAME, so the line must clear — not linger from the prior hold.
        service.onStartCommand(updateIntent("connectedByMe"), 0, 3)
        val mineHolder = service.buildContentView(R.layout.notification_session_expanded)
            .apply(context, FrameLayout(context))
            .findViewById<TextView>(R.id.session_holder)
        assertEquals(android.view.View.GONE, mineHolder.visibility)
    }

    @Test
    @Config(sdk = [30])
    fun `composites the on-device thumbnail and re-posts on the async path`() {
        every { ServiceCompat.startForeground(any(), any(), any(), any()) } just Runs
        val composed = mutableListOf<Pair<String, List<String>>>()
        val stub = Bitmap.createBitmap(4, 5, Bitmap.Config.ARGB_8888)

        val service = startWithImageSeams(imageComposer = { overlay, backgrounds ->
            composed.add(overlay to backgrounds)
            stub
        })
        // START carried no climb; nothing to compose yet.
        assertTrue(composed.isEmpty())

        service.onStartCommand(
            updateIntent(
                "connectedByMe",
                overlayPath = "file:///cache/overlay-c1.png",
                backgroundPaths = listOf("/assets/kilter-bg.png"),
            ),
            0,
            2,
        )

        // Composited from the on-device overlay + bundled backgrounds — no network.
        assertEquals(1, composed.size)
        assertEquals("file:///cache/overlay-c1.png", composed.single().first)
        assertEquals(listOf("/assets/kilter-bg.png"), composed.single().second)
        // The composited bitmap is applied via a NotificationManager.notify re-post
        // (not startForeground, which is mocked).
        val manager = context.getSystemService(NotificationManager::class.java)
        assertNotNull(shadowOf(manager).getNotification(BoardSessionService.NOTIFICATION_ID))
    }

    @Test
    @Config(sdk = [30])
    fun `drops a stale thumbnail when the climb moved on before the compose finished`() {
        every { ServiceCompat.startForeground(any(), any(), any(), any()) } just Runs
        val tasks = mutableListOf<Runnable>()
        val stub = Bitmap.createBitmap(4, 5, Bitmap.Config.ARGB_8888)

        // Defer composes so we can run them out of order relative to the climb change.
        val service = startWithImageSeams(imageComposer = { _, _ -> stub }, executor = Executor { tasks.add(it) })

        // Move to climb A (queues compose A), then to climb B (queues compose B; B
        // is now the current image key).
        service.onStartCommand(updateIntent("connectedByMe", overlayPath = "file:///cache/A.png"), 0, 2)
        service.onStartCommand(updateIntent("connectedByMe", overlayPath = "file:///cache/B.png"), 0, 3)
        assertEquals(2, tasks.size)

        val manager = context.getSystemService(NotificationManager::class.java)

        // Running the stale compose (A) must NOT re-post — the current climb is B.
        tasks[0].run()
        assertNull(shadowOf(manager).getNotification(BoardSessionService.NOTIFICATION_ID))

        // The current compose (B) re-posts.
        tasks[1].run()
        assertNotNull(shadowOf(manager).getNotification(BoardSessionService.NOTIFICATION_ID))
    }

    @Test
    @Config(sdk = [30])
    fun `recomposes when the backgrounds resolve late for the same overlay`() {
        every { ServiceCompat.startForeground(any(), any(), any(), any()) } just Runs
        val composed = mutableListOf<Pair<String, List<String>>>()
        val stub = Bitmap.createBitmap(4, 5, Bitmap.Config.ARGB_8888)

        val service = startWithImageSeams(imageComposer = { overlay, backgrounds ->
            composed.add(overlay to backgrounds)
            stub
        })

        // Update 1: the overlay is known but the bundled board backgrounds aren't
        // cached yet, so JS sends an empty list -> composites a holds-only thumbnail.
        service.onStartCommand(updateIntent("connectedByMe", overlayPath = "file:///cache/o1.png"), 0, 2)
        // Update 2: SAME overlay, backgrounds now resolved (the use-live-activity
        // backgroundsKey effect re-fires). The service must RE-composite with the
        // board photo, not serve the cached holds-only composite — the cache key folds
        // in the backgrounds, so the second update is a miss.
        service.onStartCommand(
            updateIntent(
                "connectedByMe",
                overlayPath = "file:///cache/o1.png",
                backgroundPaths = listOf("/assets/kilter-bg.png"),
            ),
            0,
            3,
        )

        assertEquals(2, composed.size)
        assertEquals(emptyList<String>(), composed[0].second)
        assertEquals(listOf("/assets/kilter-bg.png"), composed[1].second)
    }

    @Test
    @Config(sdk = [30])
    fun `downscale caps the thumbnail long side so the RemoteViews stays under the Binder limit`() {
        val service = Robolectric.buildService(BoardSessionService::class.java).create().get()

        // A larger-than-target render is capped to MAX_IMAGE_DIMEN (256) on its long
        // side — the guarantee that keeps the bitmap (duplicated across the collapsed
        // + expanded views) well under the ~1 MB Binder transaction limit.
        val large = Bitmap.createBitmap(400, 500, Bitmap.Config.ARGB_8888)
        val scaled = service.downscale(large)
        assertEquals(256, maxOf(scaled.width, scaled.height))

        // An already-small render is returned untouched (no needless re-alloc).
        val small = Bitmap.createBitmap(100, 120, Bitmap.Config.ARGB_8888)
        assertSame(small, service.downscale(small))
    }

    @Test
    @Config(sdk = [30])
    fun `start migrates the legacy LOW channel to a silent DEFAULT-importance channel`() {
        every { ServiceCompat.startForeground(any(), any(), any(), any()) } just Runs
        val manager = context.getSystemService(NotificationManager::class.java)
        // Simulate an install that still has the old LOW channel.
        manager.createNotificationChannel(
            NotificationChannel("boardsesh_session", "Active climbing session", NotificationManager.IMPORTANCE_LOW),
        )

        startService(BoardSessionService.ACTION_START)

        // The legacy channel is deleted and replaced by the new DEFAULT one (importance
        // can't be raised in place, so the bump needs a fresh id).
        assertNull(manager.getNotificationChannel("boardsesh_session"))
        val migrated = manager.getNotificationChannel(BoardSessionService.CHANNEL_ID)
        assertEquals(NotificationManager.IMPORTANCE_DEFAULT, migrated.importance)
        // DEFAULT lifts it above the "Silent" group, but it must stay silent — no
        // sound or vibration on session start (the regression this guards).
        assertNull(migrated.sound)
        assertFalse(migrated.shouldVibrate())
    }

    // --- Rest countdown ---

    private val restNowMs = 1_700_000_000_000L

    private val restSessionId = "rest-session"

    private fun restIntent(
        status: String,
        sessionId: String? = restSessionId,
        startMs: Long? = null,
        deadlineMs: Long? = null,
        periodSeconds: Long? = null,
        frozenSignedSeconds: Long? = null,
        caption: String? = null,
        overCaption: String? = null,
        clear: Boolean = false,
    ): Intent = Intent(context, BoardSessionService::class.java).apply {
        action = BoardSessionService.ACTION_REST_TIMER
        sessionId?.let { putExtra(BoardSessionService.EXTRA_SESSION_ID, it) }
        if (clear) {
            putExtra(BoardSessionService.EXTRA_REST_CLEAR, true)
        } else {
            putExtra(BoardSessionService.EXTRA_REST_STATUS, status)
        }
        startMs?.let { putExtra(BoardSessionService.EXTRA_REST_START_MS, it) }
        deadlineMs?.let { putExtra(BoardSessionService.EXTRA_REST_DEADLINE_MS, it) }
        periodSeconds?.let { putExtra(BoardSessionService.EXTRA_REST_PERIOD_SECONDS, it) }
        frozenSignedSeconds?.let { putExtra(BoardSessionService.EXTRA_REST_FROZEN_SECONDS, it) }
        caption?.let { putExtra(BoardSessionService.EXTRA_REST_CAPTION, it) }
        overCaption?.let { putExtra(BoardSessionService.EXTRA_REST_OVER_CAPTION, it) }
    }

    // A started service with "now" pinned to restNowMs and the Chronometer's
    // elapsedRealtime timebase left on Robolectric's (frozen) shadow clock, so a
    // rendered Chronometer's text is exactly deadline - now.
    private fun startRestService(
        scheduled: MutableList<Pair<Runnable, Long>> = mutableListOf(),
    ): BoardSessionService {
        every { ServiceCompat.startForeground(any(), any(), any(), any()) } just Runs
        val start = Intent(context, BoardSessionService::class.java).apply {
            action = BoardSessionService.ACTION_START
            putExtra(BoardSessionService.EXTRA_SESSION_ID, restSessionId)
        }
        val service = Robolectric.buildService(BoardSessionService::class.java, start).create().startCommand(0, 1).get()
        service.wallClockMs = { restNowMs }
        service.elapsedRealtimeMs = { SystemClock.elapsedRealtime() }
        service.scheduleOnMain = { task, delayMs -> scheduled.add(task to delayMs) }
        service.cancelOnMain = { task -> scheduled.removeAll { it.first === task } }
        return service
    }

    private fun renderRest(service: BoardSessionService, layout: Int): android.view.View =
        service.buildContentView(layout).apply(context, FrameLayout(context))

    @Test
    @Config(sdk = [30])
    fun `resolveRestDisplay counts an after-tick rest down, then marks it over`() {
        val rest = RestTimerSnapshot("running", startMs = 0, deadlineMs = 90_000, periodSeconds = null,
            frozenSignedSeconds = null, caption = null)

        assertEquals(RestDisplay.Countdown(90_000, over = false, nextTransitionMs = 90_000),
            BoardSessionService.resolveRestDisplay(rest, nowMs = 30_000))
        assertEquals(RestDisplay.Countdown(90_000, over = true, nextTransitionMs = null),
            BoardSessionService.resolveRestDisplay(rest, nowMs = 90_000))
    }

    @Test
    @Config(sdk = [30])
    fun `resolveRestDisplay rolls an on-the-minute beat forward instead of going over`() {
        val rest = RestTimerSnapshot("running", startMs = 0, deadlineMs = 60_000, periodSeconds = 60,
            frozenSignedSeconds = null, caption = null)

        assertEquals(RestDisplay.Countdown(60_000, over = false, nextTransitionMs = 60_000),
            BoardSessionService.resolveRestDisplay(rest, nowMs = 10_000))
        // On the boundary itself the next beat starts.
        assertEquals(RestDisplay.Countdown(120_000, over = false, nextTransitionMs = 120_000),
            BoardSessionService.resolveRestDisplay(rest, nowMs = 60_000))
        // Several beats missed (the phone slept): lands on the next one, never behind now.
        assertEquals(RestDisplay.Countdown(240_000, over = false, nextTransitionMs = 240_000),
            BoardSessionService.resolveRestDisplay(rest, nowMs = 185_000))
    }

    @Test
    @Config(sdk = [30])
    fun `resolveRestDisplay covers count-up, the frozen states and incomplete snapshots`() {
        fun snapshot(status: String, startMs: Long? = null, deadlineMs: Long? = null, frozen: Long? = null) =
            RestTimerSnapshot(status, startMs, deadlineMs, null, frozen, null)

        assertEquals(RestDisplay.CountUp(5_000), BoardSessionService.resolveRestDisplay(snapshot("countUp", startMs = 5_000), 9_000))
        assertEquals(RestDisplay.Frozen("−00:12", over = true),
            BoardSessionService.resolveRestDisplay(snapshot("paused", frozen = -12), 0))
        assertEquals(RestDisplay.Frozen("01:30", over = false),
            BoardSessionService.resolveRestDisplay(snapshot("waiting", frozen = 90), 0))
        assertEquals(RestDisplay.Frozen(null, over = false),
            BoardSessionService.resolveRestDisplay(snapshot("queueEnded"), 0))
        assertNull(BoardSessionService.resolveRestDisplay(snapshot("running"), 0))
        assertNull(BoardSessionService.resolveRestDisplay(snapshot("countUp"), 0))
        assertNull(BoardSessionService.resolveRestDisplay(snapshot("someFutureStatus", startMs = 1), 0))
    }

    @Test
    @Config(sdk = [30])
    fun `resolveRestDisplay keeps a queue-ended rest live and muted`() {
        fun queueEnded(startMs: Long? = null, deadlineMs: Long? = null, periodSeconds: Long? = null) =
            RestTimerSnapshot("queueEnded", startMs, deadlineMs, periodSeconds, frozenSignedSeconds = null, caption = null)

        // After a tick: counts down, then on past zero, muted and with no re-post at the deadline.
        assertEquals(RestDisplay.Countdown(90_000, over = false, nextTransitionMs = null, muted = true),
            BoardSessionService.resolveRestDisplay(queueEnded(startMs = 0, deadlineMs = 90_000), nowMs = 30_000))
        assertEquals(RestDisplay.Countdown(90_000, over = true, nextTransitionMs = null, muted = true),
            BoardSessionService.resolveRestDisplay(queueEnded(startMs = 0, deadlineMs = 90_000), nowMs = 120_000))
        // On the minute: still rolls beat to beat, like the app's pill.
        assertEquals(RestDisplay.Countdown(120_000, over = false, nextTransitionMs = 120_000, muted = true),
            BoardSessionService.resolveRestDisplay(queueEnded(startMs = 0, deadlineMs = 60_000, periodSeconds = 60), nowMs = 70_000))
        // No rest length: counts up.
        assertEquals(RestDisplay.CountUp(5_000, muted = true),
            BoardSessionService.resolveRestDisplay(queueEnded(startMs = 5_000), nowMs = 9_000))
    }

    @Test
    @Config(sdk = [30])
    fun `no rest timer keeps the rest block hidden in both layouts`() {
        val service = startRestService()
        for (layout in listOf(R.layout.notification_session_collapsed, R.layout.notification_session_expanded)) {
            assertEquals(android.view.View.GONE, renderRest(service, layout).findViewById<android.view.View>(R.id.session_rest).visibility)
        }
    }

    @Test
    @Config(sdk = [30])
    fun `a running rest renders a ticking countdown to the deadline with its caption`() {
        val service = startRestService()
        service.onStartCommand(
            restIntent("running", startMs = restNowMs - 30_000, deadlineMs = restNowMs + 90_000, caption = "Rest"),
            0,
            2,
        )

        for (layout in listOf(R.layout.notification_session_collapsed, R.layout.notification_session_expanded)) {
            val content = renderRest(service, layout)
            assertEquals(android.view.View.VISIBLE, content.findViewById<android.view.View>(R.id.session_rest).visibility)
            val clock = content.findViewById<Chronometer>(R.id.session_rest_clock)
            assertEquals(android.view.View.VISIBLE, clock.visibility)
            assertTrue(clock.isCountDown)
            assertEquals(SystemClock.elapsedRealtime() + 90_000, clock.base)
            assertEquals("01:30", clock.text.toString())
            assertEquals(android.view.View.GONE, content.findViewById<android.view.View>(R.id.session_rest_static).visibility)
            assertEquals("Rest", content.findViewById<TextView>(R.id.session_rest_caption).text.toString())
        }
    }

    @Test
    @Config(sdk = [30])
    fun `a rest past its deadline runs negative in the over colour`() {
        val service = startRestService()
        service.onStartCommand(restIntent("running", startMs = restNowMs - 102_000, deadlineMs = restNowMs - 12_000), 0, 2)

        val content = renderRest(service, R.layout.notification_session_expanded)
        assertEquals(android.view.View.GONE, content.findViewById<android.view.View>(R.id.session_rest_clock).visibility)
        val clock = content.findViewById<Chronometer>(R.id.session_rest_clock_over)
        assertEquals(android.view.View.VISIBLE, clock.visibility)
        assertTrue(clock.isCountDown)
        assertEquals("−00:12", clock.text.toString())
        assertEquals(ContextCompat.getColor(context, R.color.session_rest_over), clock.currentTextColor)
    }

    @Test
    @Config(sdk = [30])
    fun `an after-tick rest swaps to its over caption past the deadline`() {
        val service = startRestService()
        service.onStartCommand(
            restIntent("running", startMs = restNowMs - 30_000, deadlineMs = restNowMs + 90_000,
                caption = "1:30 rest", overCaption = "Over your rest"),
            0,
            2,
        )
        assertEquals("1:30 rest",
            renderRest(service, R.layout.notification_session_collapsed).findViewById<TextView>(R.id.session_rest_caption).text.toString())

        // The service's own deadline re-post renders with "now" past the deadline.
        service.wallClockMs = { restNowMs + 120_000 }
        assertEquals("Over your rest",
            renderRest(service, R.layout.notification_session_collapsed).findViewById<TextView>(R.id.session_rest_caption).text.toString())
    }

    @Test
    @Config(sdk = [30])
    fun `a queue-ended rest keeps counting past zero in the muted colour`() {
        val service = startRestService()
        service.onStartCommand(
            restIntent("queueEnded", startMs = restNowMs - 102_000, deadlineMs = restNowMs - 12_000,
                caption = "Queue's empty", overCaption = "Over your rest"),
            0,
            2,
        )

        for (layout in listOf(R.layout.notification_session_collapsed, R.layout.notification_session_expanded)) {
            val content = renderRest(service, layout)
            assertEquals(android.view.View.GONE, content.findViewById<android.view.View>(R.id.session_rest_clock).visibility)
            assertEquals(android.view.View.GONE, content.findViewById<android.view.View>(R.id.session_rest_clock_over).visibility)
            assertEquals(android.view.View.GONE, content.findViewById<android.view.View>(R.id.session_rest_static).visibility)
            val clock = content.findViewById<Chronometer>(R.id.session_rest_clock_muted)
            assertEquals(android.view.View.VISIBLE, clock.visibility)
            assertTrue(clock.isCountDown)
            assertEquals("−00:12", clock.text.toString())
            assertEquals(ContextCompat.getColor(context, R.color.session_rest_muted), clock.currentTextColor)
            // Queue ended keeps its own caption; the over caption is only for a running rest.
            assertEquals("Queue's empty", content.findViewById<TextView>(R.id.session_rest_caption).text.toString())
        }
    }

    @Test
    @Config(sdk = [30])
    fun `a new rest after an over one shows the normal clock again when SystemUI reapplies the views`() {
        val service = startRestService()
        service.onStartCommand(restIntent("running", startMs = restNowMs - 102_000, deadlineMs = restNowMs - 12_000), 0, 2)
        val shown = renderRest(service, R.layout.notification_session_collapsed)

        service.onStartCommand(restIntent("running", startMs = restNowMs, deadlineMs = restNowMs + 60_000), 0, 3)
        service.buildContentView(R.layout.notification_session_collapsed).reapply(context, shown)

        assertEquals(android.view.View.VISIBLE, shown.findViewById<android.view.View>(R.id.session_rest_clock).visibility)
        assertEquals(android.view.View.GONE, shown.findViewById<android.view.View>(R.id.session_rest_clock_over).visibility)
        assertEquals("01:00", shown.findViewById<Chronometer>(R.id.session_rest_clock).text.toString())
    }

    @Test
    @Config(sdk = [30])
    fun `a rest with no length counts up from the last climb`() {
        val service = startRestService()
        service.onStartCommand(restIntent("countUp", startMs = restNowMs - 75_000), 0, 2)

        val clock = renderRest(service, R.layout.notification_session_collapsed).findViewById<Chronometer>(R.id.session_rest_clock)
        assertFalse(clock.isCountDown)
        assertEquals("01:15", clock.text.toString())
    }

    @Test
    @Config(sdk = [30])
    fun `a paused rest shows the frozen value instead of a ticking clock`() {
        val service = startRestService()
        service.onStartCommand(restIntent("paused", frozenSignedSeconds = -12, caption = "Paused"), 0, 2)

        val content = renderRest(service, R.layout.notification_session_expanded)
        assertEquals(android.view.View.GONE, content.findViewById<android.view.View>(R.id.session_rest_clock).visibility)
        assertEquals(android.view.View.GONE, content.findViewById<android.view.View>(R.id.session_rest_static).visibility)
        val frozen = content.findViewById<TextView>(R.id.session_rest_static_over)
        assertEquals(android.view.View.VISIBLE, frozen.visibility)
        assertEquals("−00:12", frozen.text.toString())
        assertEquals(ContextCompat.getColor(context, R.color.session_rest_over), frozen.currentTextColor)
        assertEquals("Paused", content.findViewById<TextView>(R.id.session_rest_caption).text.toString())
    }

    @Test
    @Config(sdk = [30])
    fun `clearing the rest timer hides the block again`() {
        val service = startRestService()
        service.onStartCommand(restIntent("running", startMs = restNowMs, deadlineMs = restNowMs + 60_000), 0, 2)

        service.onStartCommand(restIntent("running", clear = true), 0, 3)

        assertEquals(android.view.View.GONE,
            renderRest(service, R.layout.notification_session_collapsed).findViewById<android.view.View>(R.id.session_rest).visibility)
    }

    @Test
    @Config(sdk = [30])
    fun `a service with no session yet takes no rest timer`() {
        // The system can restart the service without its START extras.
        every { ServiceCompat.startForeground(any(), any(), any(), any()) } just Runs
        val service = startService()
        service.wallClockMs = { restNowMs }

        service.onStartCommand(restIntent("running", startMs = restNowMs, deadlineMs = restNowMs + 60_000), 0, 2)
        service.onStartCommand(restIntent("running", sessionId = null, startMs = restNowMs, deadlineMs = restNowMs + 60_000), 0, 3)
        assertEquals(android.view.View.GONE,
            renderRest(service, R.layout.notification_session_collapsed).findViewById<android.view.View>(R.id.session_rest).visibility)
    }

    @Test
    @Config(sdk = [30])
    fun `a rest timer for another session is ignored and a new session starts without one`() {
        every { ServiceCompat.startForeground(any(), any(), any(), any()) } just Runs
        val start = Intent(context, BoardSessionService::class.java).apply {
            action = BoardSessionService.ACTION_START
            putExtra(BoardSessionService.EXTRA_SESSION_ID, "session-1")
        }
        val service = Robolectric.buildService(BoardSessionService::class.java, start).create().startCommand(0, 1).get()
        service.wallClockMs = { restNowMs }

        service.onStartCommand(restIntent("running", sessionId = "session-0", startMs = restNowMs, deadlineMs = restNowMs + 60_000), 0, 2)
        assertEquals(android.view.View.GONE,
            renderRest(service, R.layout.notification_session_collapsed).findViewById<android.view.View>(R.id.session_rest).visibility)

        service.onStartCommand(restIntent("running", sessionId = "session-1", startMs = restNowMs, deadlineMs = restNowMs + 60_000), 0, 3)
        assertEquals(android.view.View.VISIBLE,
            renderRest(service, R.layout.notification_session_collapsed).findViewById<android.view.View>(R.id.session_rest).visibility)

        service.onStartCommand(start, 0, 4)
        assertEquals(android.view.View.GONE,
            renderRest(service, R.layout.notification_session_collapsed).findViewById<android.view.View>(R.id.session_rest).visibility)
    }

    @Test
    @Config(sdk = [30])
    fun `the deadline re-post turns an after-tick rest over and arms nothing further`() {
        val scheduled = mutableListOf<Pair<Runnable, Long>>()
        var nowMs = restNowMs
        val service = startRestService(scheduled)
        service.wallClockMs = { nowMs }
        service.onStartCommand(restIntent("running", startMs = nowMs - 30_000, deadlineMs = nowMs + 90_000), 0, 2)

        val (transition, delayMs) = scheduled.single()
        assertEquals(90_000 + BoardSessionService.REST_TRANSITION_SLACK_MS, delayMs)

        nowMs += delayMs
        transition.run()

        val manager = context.getSystemService(NotificationManager::class.java)
        assertNotNull(shadowOf(manager).getNotification(BoardSessionService.NOTIFICATION_ID))
        assertTrue(scheduled.isEmpty())
    }

    @Test
    @Config(sdk = [30])
    fun `an on-the-minute beat re-posts at every boundary with the next beat`() {
        val scheduled = mutableListOf<Pair<Runnable, Long>>()
        var nowMs = restNowMs
        val service = startRestService(scheduled)
        service.wallClockMs = { nowMs }
        service.onStartCommand(
            restIntent("running", startMs = nowMs - 20_000, deadlineMs = nowMs + 40_000, periodSeconds = 60),
            0,
            2,
        )
        assertEquals(40_000 + BoardSessionService.REST_TRANSITION_SLACK_MS, scheduled.single().second)

        nowMs += scheduled.single().second
        scheduled.single().first.run()

        // Re-armed for the beat after: 60 s after the old deadline, minus the slack already spent.
        assertEquals(60_000L, scheduled.single().second)
        val clock = renderRest(service, R.layout.notification_session_collapsed).findViewById<Chronometer>(R.id.session_rest_clock)
        assertEquals(SystemClock.elapsedRealtime() + (restNowMs + 100_000 - nowMs), clock.base)
    }

    // Deep sleep pauses the uptime-based re-post while wall and elapsed time move
    // on. Turning the screen on must reconcile at once, not when the leftover
    // awake-time delay finally runs out.
    @Test
    @Config(sdk = [30])
    fun `turning the screen on re-renders a rest that ended while the phone slept`() {
        val scheduled = mutableListOf<Pair<Runnable, Long>>()
        var nowMs = restNowMs
        val service = startRestService(scheduled)
        service.wallClockMs = { nowMs }
        service.onStartCommand(
            restIntent("running", startMs = nowMs - 30_000, deadlineMs = nowMs + 90_000,
                caption = "1:30 rest", overCaption = "Over your rest"),
            0,
            2,
        )
        // The deadline re-post is armed but never ran: the phone slept through it.
        assertEquals(1, scheduled.size)
        nowMs += 120_000

        context.sendBroadcast(Intent(Intent.ACTION_SCREEN_ON))
        shadowOf(Looper.getMainLooper()).idle()

        val manager = context.getSystemService(NotificationManager::class.java)
        assertNotNull(shadowOf(manager).getNotification(BoardSessionService.NOTIFICATION_ID))
        // The stale re-post is cancelled and nothing more is armed: the rest is over.
        assertTrue(scheduled.isEmpty())
        assertEquals("Over your rest",
            renderRest(service, R.layout.notification_session_collapsed).findViewById<TextView>(R.id.session_rest_caption).text.toString())
    }

    @Test
    @Config(sdk = [30])
    fun `turning the screen on rolls a fixed window the phone slept through to the current one`() {
        val scheduled = mutableListOf<Pair<Runnable, Long>>()
        var nowMs = restNowMs
        val service = startRestService(scheduled)
        service.wallClockMs = { nowMs }
        service.onStartCommand(
            restIntent("running", startMs = nowMs - 20_000, deadlineMs = nowMs + 40_000, periodSeconds = 60),
            0,
            2,
        )
        // Window ends at +40 s, +100 s, +160 s, +220 s; the phone wakes at +185 s.
        nowMs += 185_000

        context.sendBroadcast(Intent(Intent.ACTION_SCREEN_ON))
        shadowOf(Looper.getMainLooper()).idle()

        val manager = context.getSystemService(NotificationManager::class.java)
        assertNotNull(shadowOf(manager).getNotification(BoardSessionService.NOTIFICATION_ID))
        // Re-armed from now for the window ending at +220 s.
        assertEquals(35_000 + BoardSessionService.REST_TRANSITION_SLACK_MS, scheduled.single().second)
        val clock = renderRest(service, R.layout.notification_session_collapsed).findViewById<Chronometer>(R.id.session_rest_clock)
        assertEquals(SystemClock.elapsedRealtime() + (restNowMs + 220_000 - nowMs), clock.base)
    }

    @Test
    @Config(sdk = [31])
    fun `ACTION_STOP cancels a pending rest re-post`() {
        val scheduled = mutableListOf<Pair<Runnable, Long>>()
        val service = startRestService(scheduled)
        service.onStartCommand(restIntent("running", startMs = restNowMs, deadlineMs = restNowMs + 60_000), 0, 2)
        assertEquals(1, scheduled.size)

        service.onStartCommand(Intent(context, BoardSessionService::class.java).apply {
            action = BoardSessionService.ACTION_STOP
        }, 0, 3)

        assertTrue(scheduled.isEmpty())
    }

    @Test
    @Config(sdk = [30])
    fun `formatSignedSeconds matches the Chronometer's own format`() {
        assertEquals("01:30", BoardSessionService.formatSignedSeconds(90))
        assertEquals("00:00", BoardSessionService.formatSignedSeconds(0))
        assertEquals("−00:12", BoardSessionService.formatSignedSeconds(-12))
    }
}
