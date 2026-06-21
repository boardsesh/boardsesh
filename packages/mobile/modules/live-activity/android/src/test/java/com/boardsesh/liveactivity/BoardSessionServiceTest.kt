package com.boardsesh.liveactivity

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.widget.FrameLayout
import android.widget.TextView
import androidx.core.app.ServiceCompat
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
}
