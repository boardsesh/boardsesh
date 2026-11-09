package com.boardsesh.liveactivity

import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.drawable.BitmapDrawable
import android.os.Looper
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.TextView
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.test.core.app.ApplicationProvider
import io.mockk.Runs
import io.mockk.every
import io.mockk.just
import io.mockk.mockkStatic
import io.mockk.unmockkStatic
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.util.concurrent.Executor

/** The lock screen card (#7327): when it shows, which tone, and how it degrades. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class BoardSessionCardTest {

    private val context: Context get() = ApplicationProvider.getApplicationContext()
    private val session = "card-session"
    private val startMs = 1_800_000_000_000L
    private var nowMs = startMs

    private val cardJson = """
        {"expanded":[{"x":40,"y":110,"r":40,"peak":0.9,"color":"#00FF00"}],
         "collapsed":[{"x":40,"y":20,"r":40,"peak":0.9,"color":"#00FF00"}],
         "gradeLabel":"V5","gradeColor":"#FF7043","angleLabel":"40°"}
    """.trimIndent()

    // Widths tell the four panels apart without comparing pixels.
    private fun bitmap(width: Int, height: Int = 3) = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    private val art = CardArt(CardPanels(bitmap(11), bitmap(12)), CardPanels(bitmap(21), bitmap(22)))
    private val colourCollapsed = 12
    private val greyCollapsed = 22

    private val notifications = mutableListOf<Notification>()
    private val scheduled = mutableListOf<Pair<Runnable, Long>>()
    private var composes = 0
    private var screenOn = true
    private val latest: Notification get() = notifications.last()

    @Before
    fun setUp() {
        mockkStatic(ServiceCompat::class)
        every { ServiceCompat.stopForeground(any(), any<Int>()) } just Runs
        every { ServiceCompat.startForeground(any(), any(), any(), any()) } answers {
            notifications.add(arg(2))
            Unit
        }
        BoardSessionService.resetImageStateForTest()
        SessionPresenceModule.clearPendingForTest()
        context.getSystemService(NotificationManager::class.java).cancelAll()
    }

    @After
    fun tearDown() {
        unmockkStatic(ServiceCompat::class)
    }

    private fun startCard(
        composer: (CardPayload) -> CardArt? = { art },
        executor: Executor = Executor { it.run() },
    ): BoardSessionService {
        val start = Intent(context, BoardSessionService::class.java).apply {
            action = BoardSessionService.ACTION_START
            putExtra(BoardSessionService.EXTRA_SESSION_ID, session)
            putExtra(BoardSessionService.EXTRA_STOP_DRIVING_LABEL, "Stop driving")
        }
        val controller = Robolectric.buildService(BoardSessionService::class.java, start).create()
        val service = controller.get()
        service.imageExecutor = executor
        service.postToMain = { it.run() }
        service.notificationPoster = { notifications.add(it) }
        service.imageComposer = { _, _ -> bitmap(4, 5) }
        service.cardArtComposer = { payload ->
            composes += 1
            composer(payload)
        }
        service.wallClockMs = { nowMs }
        service.screenInteractive = { screenOn }
        service.scheduleOnMain = { task, delayMs -> scheduled.add(task to delayMs) }
        service.cancelOnMain = { task -> scheduled.removeAll { it.first === task } }
        controller.startCommand(0, 1)
        return service
    }

    private fun update(
        connection: String = "connectedByMe",
        json: String? = cardJson,
        hasPrevious: Boolean = true,
        hasNext: Boolean = true,
        holder: String? = null,
        overlay: String? = null,
    ) = Intent(context, BoardSessionService::class.java).apply {
        action = BoardSessionService.ACTION_UPDATE
        putExtra(BoardSessionService.EXTRA_SESSION_ID, session)
        putExtra(BoardSessionService.EXTRA_CLIMB_NAME, "Young and Beautiful")
        putExtra(BoardSessionService.EXTRA_SUBTITLE, "5b/V1 · 40°")
        putExtra(BoardSessionService.EXTRA_HAS_PREVIOUS, hasPrevious)
        putExtra(BoardSessionService.EXTRA_HAS_NEXT, hasNext)
        putExtra(BoardSessionService.EXTRA_CURRENT_INDEX, 10)
        putExtra(BoardSessionService.EXTRA_TOTAL_CLIMBS, 13)
        putExtra(BoardSessionService.EXTRA_BOARD_CONNECTION, connection)
        holder?.let { putExtra(BoardSessionService.EXTRA_HOLDER_NAME, it) }
        overlay?.let { putExtra(BoardSessionService.EXTRA_OVERLAY_PATH, it) }
        json?.let { putExtra(BoardSessionService.EXTRA_CARD_JSON, it) }
    }

    private fun lighting(state: String, endMs: Long? = null) = Intent(context, BoardSessionService::class.java).apply {
        action = BoardSessionService.ACTION_LIGHTING
        putExtra(BoardSessionService.EXTRA_SESSION_ID, session)
        putExtra(BoardSessionService.EXTRA_LIGHT_STATE, state)
        endMs?.let { putExtra(BoardSessionService.EXTRA_LIGHT_WINDOW_END_MS, it) }
    }

    private fun BoardSessionService.send(intent: Intent) = onStartCommand(intent, 0, 2)

    private fun collapsed(notification: Notification = latest): View =
        notification.contentView.apply(context, FrameLayout(context))

    private fun expanded(notification: Notification = latest): View =
        notification.bigContentView.apply(context, FrameLayout(context))

    private fun artWidth(view: View): Int? {
        val image = view.findViewById<ImageView>(R.id.session_card_art)
        return (image.drawable as? BitmapDrawable)?.bitmap?.width
    }

    private fun text(view: View, id: Int): String = view.findViewById<TextView>(id).text.toString()

    private fun visibility(view: View, id: Int): Int = view.findViewById<View>(id).visibility

    // --- Which card ---

    @Test
    fun `a payload gets the card with its controls in the content and actions for a watch`() {
        val service = startCard()
        service.send(update())

        assertEquals(R.layout.notification_card_collapsed, latest.contentView.layoutId)
        assertEquals(R.layout.notification_card_expanded, latest.bigContentView.layoutId)
        assertNull(latest.actions)
        assertEquals(
            listOf("Previous", "Relight wall", "Next"),
            NotificationCompat.WearableExtender(latest).actions.map { it.title.toString() },
        )
        assertTrue(latest.extras.getBoolean(Notification.EXTRA_COLORIZED))
    }

    @Test
    fun `no payload keeps the classic card and composes nothing`() {
        val service = startCard()
        service.send(update(json = null))

        assertEquals(R.layout.notification_session_collapsed, latest.contentView.layoutId)
        assertEquals(listOf("Previous", "Relight wall", "Next"), latest.actions.map { it.title.toString() })
        assertEquals(0, composes)
    }

    @Test
    fun `the kill switch dropping the payload returns to the classic card`() {
        val service = startCard()
        service.send(update())
        service.send(update(json = null))

        assertEquals(R.layout.notification_session_collapsed, latest.contentView.layoutId)
    }

    @Test
    fun `a malformed payload keeps the classic card`() {
        val service = startCard()
        service.send(update(json = "{not json"))

        assertEquals(R.layout.notification_session_collapsed, latest.contentView.layoutId)
        assertEquals(0, composes)
    }

    // --- Which tone ---

    @Test
    fun `holding the board without driving is grey and driving is colour`() {
        val service = startCard()
        service.send(update())
        assertEquals(greyCollapsed, artWidth(collapsed()))

        service.send(lighting(BoardSessionService.LIGHT_STATE_DRIVING))
        assertEquals(colourCollapsed, artWidth(collapsed()))
    }

    @Test
    fun `losing the board greys the card at once, even mid-drive`() {
        val service = startCard()
        service.send(update())
        service.send(lighting(BoardSessionService.LIGHT_STATE_DRIVING))

        service.send(update(connection = "heldByPeer", holder = "Alex"))

        assertEquals(greyCollapsed, artWidth(collapsed()))
    }

    @Test
    fun `a timed drive ending with JS paused greys the card with no compose`() {
        val service = startCard()
        service.send(update())
        service.send(lighting(BoardSessionService.LIGHT_STATE_WINDOW, endMs = startMs + 45_000))
        assertEquals(colourCollapsed, artWidth(collapsed()))
        val composesBefore = composes

        val (transition, delayMs) = scheduled.maxBy { it.second }
        nowMs += delayMs
        transition.run()

        assertEquals(greyCollapsed, artWidth(collapsed()))
        assertEquals(composesBefore, composes)
    }

    @Test
    fun `turning the screen on greys a drive the phone slept through`() {
        val service = startCard()
        service.send(update())
        service.send(lighting(BoardSessionService.LIGHT_STATE_WINDOW, endMs = startMs + 45_000))
        nowMs += 120_000

        context.sendBroadcast(Intent(Intent.ACTION_SCREEN_ON))
        shadowOf(Looper.getMainLooper()).idle()

        assertEquals(greyCollapsed, artWidth(collapsed()))
    }

    private fun bulbLevel(): Int = collapsed().findViewById<ImageButton>(R.id.session_bulb).drawable.level

    @Test
    fun `the ring drains from full as a timed drive runs out`() {
        val service = startCard()
        service.send(update())
        service.send(lighting(BoardSessionService.LIGHT_STATE_WINDOW, endMs = startMs + 40_000))
        assertEquals(10_000, bulbLevel())

        val (tick, delayMs) = scheduled.minBy { it.second }
        assertEquals(1_000L, delayMs)
        nowMs += 20_000
        tick.run()

        assertTrue(bulbLevel() in 4_900..5_100)
    }

    @Test
    fun `a renewed drive refills the ring`() {
        val service = startCard()
        service.send(update())
        service.send(lighting(BoardSessionService.LIGHT_STATE_WINDOW, endMs = startMs + 40_000))
        nowMs += 20_000
        service.send(lighting(BoardSessionService.LIGHT_STATE_WINDOW, endMs = nowMs + 40_000))

        assertEquals(10_000, bulbLevel())
    }

    @Test
    fun `the ring stops ticking with the screen off and resumes on screen on`() {
        val service = startCard()
        service.send(update())
        service.send(lighting(BoardSessionService.LIGHT_STATE_WINDOW, endMs = startMs + 40_000))
        screenOn = false
        val postsBefore = notifications.size
        scheduled.minBy { it.second }.first.run()

        assertEquals(postsBefore + 1, notifications.size)
        assertEquals(1, scheduled.size)

        screenOn = true
        context.sendBroadcast(Intent(Intent.ACTION_SCREEN_ON))
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(2, scheduled.size)
    }

    @Test
    fun `an open-ended drive has nothing to tick`() {
        val service = startCard()
        service.send(update())
        service.send(lighting(BoardSessionService.LIGHT_STATE_DRIVING))

        assertTrue(scheduled.isEmpty())
    }

    @Test
    fun `the classic card never ticks`() {
        val service = startCard()
        service.send(update(json = null))
        service.send(lighting(BoardSessionService.LIGHT_STATE_WINDOW, endMs = startMs + 40_000))

        assertEquals(1, scheduled.size)
    }

    // --- Budget and failure ---

    @Test
    fun `art over the budget drops the bokeh first and keeps the board`() {
        // 256 KB thumbnail twice plus a 400 KB panel is over the 700 KB ceiling.
        val heavy = CardArt(CardPanels(bitmap(500, 200), bitmap(10)), CardPanels(bitmap(500, 200), bitmap(10)))
        val service = startCard(composer = { heavy })
        service.imageComposer = { _, _ -> bitmap(256, 256) }
        service.send(update(overlay = "file:///cache/a.png"))

        assertNull(artWidth(collapsed()))
        assertEquals(View.GONE, visibility(collapsed(), R.id.session_card_art))
        assertEquals(View.VISIBLE, visibility(collapsed(), R.id.session_image))
    }

    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun `the largest real board and the real panels fit the budget`() {
        val service = startCard(composer = SessionCardPainter::compose)
        service.imageComposer = { _, _ -> bitmap(256, 256) }
        service.send(update(overlay = "file:///cache/a.png"))

        assertEquals(View.VISIBLE, visibility(collapsed(), R.id.session_card_art))
        assertTrue(SessionPresenceModule.pendingEventsSnapshotForTest().isEmpty())
    }

    @Test
    fun `a bokeh that fails to paint keeps the card and the board`() {
        val service = startCard(composer = { throw OutOfMemoryError("no room") })
        service.send(update(overlay = "file:///cache/a.png"))

        assertEquals(R.layout.notification_card_collapsed, latest.contentView.layoutId)
        assertEquals(View.GONE, visibility(collapsed(), R.id.session_card_art))
        assertEquals(View.VISIBLE, visibility(collapsed(), R.id.session_image))
    }

    @Test
    fun `a board that fails to compose keeps the bokeh`() {
        val service = startCard()
        service.imageComposer = { _, _ -> null }
        service.send(update(overlay = "file:///cache/a.png"))

        assertEquals(greyCollapsed, artWidth(collapsed()))
        assertEquals(View.GONE, visibility(collapsed(), R.id.session_image))
    }

    @Test
    fun `the next climb's card holds the last art until its own lands`() {
        val tasks = mutableListOf<Runnable>()
        val service = startCard(executor = Executor { tasks.add(it) })
        service.send(update())
        tasks.removeAt(0).run()
        assertEquals(greyCollapsed, artWidth(collapsed()))

        service.send(update(json = cardJson.replace("#00FF00", "#FF00FF")))

        assertEquals(greyCollapsed, artWidth(collapsed()))
        assertEquals(1, tasks.size)
    }

    // --- What it says ---

    @Test
    fun `the collapsed line leads with the grade and the expanded grade has its own slot`() {
        val service = startCard()
        service.send(update())

        assertEquals("V5 · 11 / 13 · 40°", text(collapsed(), R.id.session_subtitle))
        assertEquals("11 / 13 · 40°", text(expanded(), R.id.session_subtitle))
        assertEquals("V5", text(expanded(), R.id.session_card_grade))
        assertEquals(0xFFFF7043.toInt(), expanded().findViewById<TextView>(R.id.session_card_grade).currentTextColor)
    }

    @Test
    fun `a button with nowhere to go keeps its slot but does nothing`() {
        val service = startCard()
        service.send(update(hasPrevious = false, hasNext = true))

        val previous = expanded().findViewById<ImageButton>(R.id.session_previous)
        val next = expanded().findViewById<ImageButton>(R.id.session_next)
        assertEquals(View.VISIBLE, previous.visibility)
        assertFalse(previous.isEnabled)
        assertFalse(previous.hasOnClickListeners())
        assertTrue(next.isEnabled)
        assertTrue(next.hasOnClickListeners())
        assertEquals("Next", next.contentDescription)
    }

    @Test
    fun `a peer holding the wall hides navigation and names them`() {
        val service = startCard()
        service.send(update(connection = "heldByPeer", holder = "Alex"))

        assertEquals(View.GONE, visibility(expanded(), R.id.session_previous))
        assertEquals(View.GONE, visibility(expanded(), R.id.session_next))
        assertEquals(View.GONE, visibility(collapsed(), R.id.session_next))
        assertEquals("Alex is on the wall", text(expanded(), R.id.session_card_status))
        assertEquals("V5 · Alex is on the wall · 40°", text(collapsed(), R.id.session_subtitle))
        assertEquals("Connect to board", expanded().findViewById<ImageButton>(R.id.session_bulb).contentDescription)
    }

    @Test
    fun `the bulb stops a drive and otherwise relights`() {
        val service = startCard()
        service.send(update())
        assertEquals("Relight wall", collapsed().findViewById<ImageButton>(R.id.session_bulb).contentDescription)

        service.send(lighting(BoardSessionService.LIGHT_STATE_DRIVING))
        assertEquals("Stop driving", collapsed().findViewById<ImageButton>(R.id.session_bulb).contentDescription)
    }

    @Test
    fun `a rest clock replaces the grade and clears Next from the collapsed strip`() {
        val service = startCard()
        service.send(update())
        service.send(
            Intent(context, BoardSessionService::class.java).apply {
                action = BoardSessionService.ACTION_REST_TIMER
                putExtra(BoardSessionService.EXTRA_SESSION_ID, session)
                putExtra(BoardSessionService.EXTRA_REST_STATUS, "running")
                putExtra(BoardSessionService.EXTRA_REST_START_MS, startMs)
                putExtra(BoardSessionService.EXTRA_REST_DEADLINE_MS, startMs + 90_000)
                putExtra(BoardSessionService.EXTRA_REST_PERIOD_SECONDS, 90L)
            },
        )

        assertEquals(View.VISIBLE, visibility(expanded(), R.id.session_rest))
        assertEquals(View.GONE, visibility(expanded(), R.id.session_card_grade))
        assertEquals("V5 · 11 / 13 · 40°", text(expanded(), R.id.session_subtitle))
        assertEquals(View.GONE, visibility(collapsed(), R.id.session_next))
        assertEquals(View.VISIBLE, visibility(collapsed(), R.id.session_bulb))
        assertEquals(View.VISIBLE, visibility(collapsed(), R.id.session_card_rest_scrim))
        assertEquals(View.VISIBLE, visibility(expanded(), R.id.session_card_rest_scrim))
    }
}
