package com.boardsesh.liveactivity

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.graphics.Matrix
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.text.SpannableString
import android.text.Spanned
import android.text.format.DateUtils
import android.text.style.ForegroundColorSpan
import android.text.style.StyleSpan
import android.util.Log
import android.util.LruCache
import android.view.View
import android.widget.RemoteViews
import androidx.annotation.VisibleForTesting
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import java.io.File
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executor
import java.util.concurrent.Executors

/**
 * Foreground service (type connectedDevice) that keeps the react-native-ble-plx
 * connection alive while Boardsesh is backgrounded, and shows an ongoing
 * Material 3 notification with the current climb's render, queue position, a
 * lightbulb, and Previous/Next controls. The Android counterpart to the iOS Live
 * Activity. Started/updated/stopped by SessionPresenceModule via intents; its
 * action buttons broadcast to BoardSessionActionReceiver.
 *
 * The notification is a [NotificationCompat.DecoratedCustomViewStyle]: custom
 * RemoteViews own the content (portrait climb thumbnail + climb info), while the
 * system renders the chrome and the Previous/lightbulb/Next action buttons (so
 * they pick up Material You theming and hiding one is just "don't add it"). The
 * lightbulb + control visibility follow the tri-state [boardConnection] —
 * connectedByMe shows the lit bulb + Previous/Next; heldByPeer/disconnected show
 * only the outline bulb (tap to reconnect) and, for heldByPeer, "<name> is on
 * the wall". While the climber rests, a Chronometer beside the climb info counts
 * the rest down (or up, with no rest length) without any further updates.
 *
 * Driving the wall (2.7) lives in the header instead: the sub-text says
 * "Driving the wall", and for Put on board's timed drive (Stop driving after)
 * the system's own countdown chronometer runs to its end, so TalkBack reads
 * the system clock and the colours follow Material You. An open-ended drive
 * (a swipe, Until I stop) shows the line with no clock. Both swap the small
 * icon for the bulb while picks light.
 */
class BoardSessionService : Service() {

    private var channelName: String = "Active climbing session"
    private var channelDescription: String = ""
    // True once ACTION_START delivered a localized channel name. Other entries
    // (UPDATE/STOP/null-intent restart on a cold process) still carry the
    // English defaults above and must never rename an existing channel.
    private var channelNameLocalized: Boolean = false
    private var contentTitleFallback: String = "Climbing session"
    private var previousLabel: String = "Previous"
    private var nextLabel: String = "Next"
    private var relightLabel: String = "Relight wall"
    private var reconnectLabel: String = "Connect to board"
    private var connectingLabel: String = "Connecting…"
    private var onWallTemplate: String = "{{name}} is on the wall"
    private var lightDrivingLabel: String = "Driving the wall"
    // The lit bulb's label while this phone drives (2.7): a tap stops driving.
    // Null from an older bundle, which has no stop to take: its lit bulb keeps
    // re-lighting.
    private var stopDrivingLabel: String? = null

    private var sessionId: String = ""
    private var queueItemUuid: String = ""
    private var supportsMirroring: Boolean = false
    private var mirrored: Boolean = false
    private var mirrorLabel: String = "Mirror climb"
    private var unmirrorLabel: String = "Unmirror climb"

    private var climbName: String? = null
    private var subtitle: String? = null
    private var hasNext: Boolean = false
    private var hasPrevious: Boolean = false
    private var currentIndex: Int = 0
    private var totalClimbs: Int = 0
    private var boardConnection: String = CONNECTION_CONNECTED_BY_ME
    private var holderDisplayName: String? = null
    // Both ride every ACTION_UPDATE and default to false when an older bundle
    // leaves them out (#7087). bulbOpensApp: no remembered board, so the outline
    // bulb opens the app rather than starting a reconnect that would need the
    // board list on a paused activity. boardConnecting: a connect is running, so
    // the outline bulb says so and a repeat tap is visibly not lost.
    private var bulbOpensApp: Boolean = false
    private var boardConnecting: Boolean = false

    // On-device climb thumbnail (the app's no-network board-art rule): the
    // BoardRenderer holds-only PNG and the bundled board background layers under it,
    // composited locally — never a backend fetch.
    private var overlayPath: String? = null
    private var backgroundPaths: List<String> = emptyList()

    // The lock screen card (#7327). Null is the classic card: an older bundle, the
    // kill switch, a service restarted with no JS, or a payload that didn't parse.
    private var cardJson: String? = null
    private var cardPayload: CardPayload? = null

    @Volatile
    private var currentCardKey: String? = null

    @Volatile
    private var failedCardKey: String? = null

    // The art last painted, kept up while the next climb's composes. Main thread only.
    private var lastCardArt: CardArt? = null

    // The rest countdown (null = hidden). Epoch-ms from JS; converted to the
    // Chronometer's elapsedRealtime timebase at build time.
    private var restTimer: RestTimerSnapshot? = null

    // Driving the wall (2.7): off, a timed drive ending at lightWindowEndMs
    // (epoch ms), or an open-ended drive. Absent extras (an
    // older bundle) mean off, so the card is today's.
    private var lightState: String = LIGHT_STATE_OFF
    private var lightWindowEndMs: Long? = null

    // How long the current timed drive ran for when it began, so the card's ring
    // can drain from full.
    private var lightWindowTotalMs: Long = 0L

    // The overlay path whose composited bitmap is currently displayed; the async
    // compose only applies its result if this still matches (stale guard).
    @Volatile
    private var currentImageKey: String? = null

    // The image key whose compose last returned no bitmap. The slot is hidden for
    // it, and a retry for the same key neither logs nor re-posts again.
    @Volatile
    private var failedImageKey: String? = null

    // The overlay path and bitmap last put in the slot, so a new variant of the
    // same climb (mirrored, or with late backgrounds) keeps showing while it
    // composes. Main thread only (buildContentView).
    private var lastShownThumbnail: Pair<String, Bitmap>? = null

    @Volatile
    private var foregrounded: Boolean = false

    private val mainHandler: Handler by lazy { Handler(Looper.getMainLooper()) }

    // Near-black thumbnail backing (matches the iOS card + the letterbox placeholder
    // in colors.xml) so a holds-only render doesn't show the notification surface
    // through the holds. Sourced from the one canonical resource per density bucket.
    private val thumbBackingColor: Int by lazy { ContextCompat.getColor(this, R.color.session_image_placeholder) }

    // Injectable seams (mirror SessionPresenceController.startForegroundService) so
    // a Robolectric test can drive the async image path on the calling thread.
    internal var imageExecutor: Executor = sharedImageExecutor
    internal var postToMain: (Runnable) -> Unit = { mainHandler.post(it) }
    internal var notificationPoster: (Notification) -> Unit = { notification ->
        getSystemService(NotificationManager::class.java)?.notify(NOTIFICATION_ID, notification)
    }
    private val reportedPostFailures = HashSet<String>()
    internal var cardArtComposer: (CardPayload) -> CardArt? = SessionCardPainter::compose
    internal var imageComposer: (String, List<String>) -> Bitmap? = { overlay, backgrounds ->
        composeThumbnail(overlay, backgrounds)
    }

    // Clock + scheduling seams for the rest countdown, so a test can pin "now" and
    // capture the deadline re-post instead of waiting on the main looper.
    internal var wallClockMs: () -> Long = { System.currentTimeMillis() }
    internal var elapsedRealtimeMs: () -> Long = { SystemClock.elapsedRealtime() }
    internal var screenInteractive: () -> Boolean = {
        getSystemService(PowerManager::class.java)?.isInteractive != false
    }
    internal var scheduleOnMain: (Runnable, Long) -> Unit = { task, delayMs -> mainHandler.postDelayed(task, delayMs) }
    internal var cancelOnMain: (Runnable) -> Unit = { mainHandler.removeCallbacks(it) }

    // Re-posts the notification when the rest crosses its deadline: an after-tick
    // rest turns "over" (red), an on-the-minute beat rolls to the next one. The
    // Chronometer itself keeps ticking between re-posts; this only refreshes what
    // a Chronometer can't change on its own (colour, the next beat's base).
    private val restTransition = Runnable { onRestTransition() }

    // Re-posts the notification just after a timed drive ends, so the
    // header drops its clock and the bulb icon even while JS is suspended.
    private val lightTransition = Runnable { onLightTransition() }
    private val lightRingTick = Runnable { onLightRingTick() }

    // The re-post above runs on the main Handler, whose clock is uptime: it stops
    // while the phone is in deep sleep. The Chronometer's base is elapsedRealtime,
    // which keeps counting through sleep. A rest that ends while the screen is off
    // would otherwise show negative digits under its old caption and colour (or a
    // fixed window running negative under "Every 1:00") until the leftover
    // awake-time delay ran out. So re-render the moment the climber can see the
    // notification again; the re-post also re-arms the next transition from now.
    // SCREEN_ON / USER_PRESENT are protected system broadcasts: no other app can
    // send them, so registering without the export flag below API 33 is safe.
    // A timed drive's end re-post has the same gap, so it is
    // reconciled here too.
    private val screenOnReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            onScreenOn()
        }
    }
    private var screenOnReceiverRegistered = false

    private fun registerScreenOnReceiver() {
        if (screenOnReceiverRegistered) return
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_ON)
            addAction(Intent.ACTION_USER_PRESENT)
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                registerReceiver(screenOnReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
            } else {
                registerReceiver(screenOnReceiver, filter)
            }
            screenOnReceiverRegistered = true
        } catch (error: Exception) {
            Log.w(TAG, "screen-on receiver registration failed: ${error.message}")
        }
    }

    private fun unregisterScreenOnReceiver() {
        if (!screenOnReceiverRegistered) return
        screenOnReceiverRegistered = false
        try {
            unregisterReceiver(screenOnReceiver)
        } catch (error: IllegalArgumentException) {
            Log.w(TAG, "screen-on receiver was not registered: ${error.message}")
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        cancelOnMain(restTransition)
        cancelOnMain(lightTransition)
        cancelOnMain(lightRingTick)
        unregisterScreenOnReceiver()
        foregrounded = false
        super.onDestroy()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Apply intent state first (cheap, can't throw) so it never eats into the
        // 5 s startForeground() deadline.
        when (intent?.action) {
            ACTION_START -> {
                intent.getStringExtra(EXTRA_CHANNEL_NAME)?.let {
                    channelName = it
                    channelNameLocalized = true
                }
                channelDescription = intent.getStringExtra(EXTRA_CHANNEL_DESC) ?: channelDescription
                sessionId = intent.getStringExtra(EXTRA_SESSION_ID) ?: ""
                mirrorLabel = intent.getStringExtra(EXTRA_MIRROR_LABEL) ?: mirrorLabel
                unmirrorLabel = intent.getStringExtra(EXTRA_UNMIRROR_LABEL) ?: unmirrorLabel
                contentTitleFallback = intent.getStringExtra(EXTRA_TITLE_FALLBACK) ?: contentTitleFallback
                previousLabel = intent.getStringExtra(EXTRA_PREV_LABEL) ?: previousLabel
                nextLabel = intent.getStringExtra(EXTRA_NEXT_LABEL) ?: nextLabel
                relightLabel = intent.getStringExtra(EXTRA_RELIGHT_LABEL) ?: relightLabel
                reconnectLabel = intent.getStringExtra(EXTRA_RECONNECT_LABEL) ?: reconnectLabel
                connectingLabel = intent.getStringExtra(EXTRA_CONNECTING_LABEL) ?: connectingLabel
                onWallTemplate = intent.getStringExtra(EXTRA_ON_WALL_TEMPLATE) ?: onWallTemplate
                lightDrivingLabel = intent.getStringExtra(EXTRA_LIGHT_DRIVING_LABEL) ?: lightDrivingLabel
                stopDrivingLabel = intent.getStringExtra(EXTRA_STOP_DRIVING_LABEL)
                boardConnection = intent.getStringExtra(EXTRA_BOARD_CONNECTION) ?: boardConnection
                holderDisplayName = intent.getStringExtra(EXTRA_HOLDER_NAME)
                // A new session window starts without a countdown or a lighting
                // window; JS sends both right after every start.
                restTimer = null
                lightState = LIGHT_STATE_OFF
                lightWindowEndMs = null
            }
            ACTION_LIGHTING -> {
                // Only for the session this service shows, like the rest timer.
                val lightSessionId = intent.getStringExtra(EXTRA_SESSION_ID) ?: ""
                if (sessionId.isNotEmpty() && lightSessionId == sessionId) {
                    lightState = intent.getStringExtra(EXTRA_LIGHT_STATE)?.takeIf { it in LIGHT_STATES } ?: LIGHT_STATE_OFF
                    val nextWindowEndMs = if (intent.hasExtra(EXTRA_LIGHT_WINDOW_END_MS)) {
                        intent.getLongExtra(EXTRA_LIGHT_WINDOW_END_MS, 0L)
                    } else {
                        null
                    }
                    // A new end is a new or renewed window. The drive's own length comes
                    // first: a service restarted mid-drive must not read what's left as
                    // the whole drive, or the ring would start full and drain too fast.
                    if (nextWindowEndMs != lightWindowEndMs) {
                        val driveMs = if (intent.hasExtra(EXTRA_LIGHT_WINDOW_SECONDS)) {
                            (intent.getDoubleExtra(EXTRA_LIGHT_WINDOW_SECONDS, 0.0) * 1000).toLong()
                        } else {
                            0L
                        }
                        lightWindowTotalMs = driveMs.takeIf { it > 0L } ?: nextWindowEndMs?.let { it - wallClockMs() } ?: 0L
                    }
                    lightWindowEndMs = nextWindowEndMs
                }
            }
            ACTION_REST_TIMER -> {
                val restSessionId = intent.getStringExtra(EXTRA_SESSION_ID) ?: ""
                // Only for the session this service is showing. A service the
                // system restarted without its START extras has no session yet,
                // so it takes no rest timer until the app starts one again.
                if (sessionId.isNotEmpty() && restSessionId == sessionId) {
                    restTimer = if (intent.getBooleanExtra(EXTRA_REST_CLEAR, false)) {
                        null
                    } else {
                        restTimerFrom(intent)
                    }
                }
            }
            ACTION_UPDATE -> {
                val updateSessionId = intent.getStringExtra(EXTRA_SESSION_ID) ?: ""
                if (sessionId.isEmpty() || updateSessionId == sessionId) {
                    sessionId = updateSessionId
                    queueItemUuid = intent.getStringExtra(EXTRA_QUEUE_ITEM_UUID) ?: ""
                    supportsMirroring = intent.getBooleanExtra(EXTRA_SUPPORTS_MIRRORING, false)
                    mirrored = intent.getBooleanExtra(EXTRA_MIRRORED, false)
                    climbName = intent.getStringExtra(EXTRA_CLIMB_NAME) ?: climbName
                    subtitle = intent.getStringExtra(EXTRA_SUBTITLE) ?: subtitle
                    hasNext = intent.getBooleanExtra(EXTRA_HAS_NEXT, hasNext)
                    hasPrevious = intent.getBooleanExtra(EXTRA_HAS_PREVIOUS, hasPrevious)
                    currentIndex = intent.getIntExtra(EXTRA_CURRENT_INDEX, currentIndex)
                    totalClimbs = intent.getIntExtra(EXTRA_TOTAL_CLIMBS, totalClimbs)
                    boardConnection = intent.getStringExtra(EXTRA_BOARD_CONNECTION) ?: boardConnection
                    // Absent extra ⇒ no peer holder ⇒ clear (the controller only sends
                    // it for heldByPeer).
                    holderDisplayName = intent.getStringExtra(EXTRA_HOLDER_NAME)
                    bulbOpensApp = intent.getBooleanExtra(EXTRA_BULB_OPENS_APP, false)
                    boardConnecting = intent.getBooleanExtra(EXTRA_BOARD_CONNECTING, false)
                    // Absent overlay ⇒ render not ready yet; keep the last one so the
                    // thumbnail doesn't flicker out between updates.
                    intent.getStringExtra(EXTRA_OVERLAY_PATH)?.let { overlayPath = it }
                    intent.getStringArrayListExtra(EXTRA_BACKGROUND_PATHS)?.let { backgroundPaths = it }
                    // Unlike the thumbnail, absent means something: an older bundle
                    // or the kill switch, and either one wants the classic card.
                    val nextCardJson = intent.getStringExtra(EXTRA_CARD_JSON)
                    if (nextCardJson != cardJson) {
                        cardJson = nextCardJson
                        cardPayload = nextCardJson?.let { CardPayload.parse(it) }
                    }
                }
            }
        }

        // Promote on EVERY entry, including ACTION_STOP and the null-intent
        // restart: the system may hold a start token from startForegroundService()
        // and crashes with ForegroundServiceDidNotStartInTimeException if we don't
        // call startForeground() in time.
        val promoted = startInForeground()

        // A lighting update that reached a service with no session (the system
        // started it fresh for a stale notification's press) has nothing to
        // show: promote, as above, then stop rather than post an empty card.
        val orphanedLighting = intent?.action == ACTION_LIGHTING && sessionId.isEmpty()
        if (intent?.action == ACTION_STOP || !promoted || orphanedLighting) {
            foregrounded = false
            cancelOnMain(restTransition)
            cancelOnMain(lightTransition)
            cancelOnMain(lightRingTick)
            unregisterScreenOnReceiver()
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }

        foregrounded = true
        registerScreenOnReceiver()
        scheduleRestTransition()
        scheduleLightTransition()
        scheduleLightRingTick()
        // Image compositing never runs before promotion: the notification was
        // already built (with the cached bitmap or a placeholder) and posted above.
        maybeComposeImage()
        maybeComposeCardArt()

        // START_NOT_STICKY: don't let the OS recreate the service in the background
        // after a kill — a null-intent restart on a frozen/cold-starting process
        // can't promote within 5 s. The JS useLiveActivity effect re-starts the
        // session when the app reopens.
        return START_NOT_STICKY
    }

    // Promotes the service to the foreground; returns true on success. Channel
    // creation is best-effort and independent of notification building so the
    // fallback notification still has a channel to post to if buildNotification()
    // throws.
    private fun startInForeground(): Boolean {
        try {
            ensureChannel()
        } catch (error: Exception) {
            Log.w(TAG, "ensureChannel failed: ${error.message}")
        }
        val notification = try {
            buildNotification()
        } catch (error: Exception) {
            Log.w(TAG, "buildNotification failed, using fallback: ${error.message}")
            buildFallbackNotification()
        }
        // connectedDevice requires API 30+; older devices get a plain FGS.
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
        } else {
            0
        }
        if (promote(notification, type)) return true
        // A failed promotion stops the service and drops the BLE keepalive, so a
        // card that only failed because of its own content (a bad bitmap, say) must
        // not cost that. Only a recovery is reported: a permission or background-
        // start refusal fails the plain card too and says nothing about the card.
        val recovered = promote(buildFallbackNotification(), type)
        if (recovered) reportPostFailure("promotion", null)
        return recovered
    }

    private fun promote(notification: Notification, type: Int): Boolean {
        if (tryStartForeground(notification, type)) return true
        // On API < 34 a typeless FGS is a valid promotion, so retry to satisfy the
        // contract. On API 34+ type 0 throws MissingForegroundServiceTypeException
        // for a typed service, so the caller gates the start on BLUETOOTH_CONNECT.
        return type != 0 && Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE &&
            tryStartForeground(notification, 0)
    }

    private fun tryStartForeground(notification: Notification, type: Int): Boolean {
        return try {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, type)
            true
        } catch (error: Exception) {
            Log.w(TAG, "startForeground(type=$type) failed: ${error.message}")
            false
        }
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java) ?: return
        // Importance can't be raised on an existing channel, so the bump from LOW
        // to DEFAULT (lift the ongoing card above the shade's "Silent" group)
        // needs a fresh channel id. Delete the legacy LOW channel so users don't
        // see two identically-named entries in system Settings — but only when it's
        // still present: ensureChannel() runs on every update, and an unconditional
        // delete would churn the manager on the hot path long after the one-time
        // migration is done.
        if (manager.getNotificationChannel(LEGACY_CHANNEL_ID) != null) {
            manager.deleteNotificationChannel(LEGACY_CHANNEL_ID)
        }
        val existing = manager.getNotificationChannel(CHANNEL_ID)
        if (existing != null) {
            // Re-create only when ACTION_START delivered a fresh localized name
            // that differs — createNotificationChannel on an existing id updates
            // name/description, so a device-locale change doesn't leave the old
            // language in system Settings forever.
            if (!channelNameLocalized || existing.name?.toString() == channelName) return
        }
        val channel = NotificationChannel(CHANNEL_ID, channelName, NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = channelDescription
            setShowBadge(false)
            // DEFAULT importance lifts the ongoing card above the shade's "Silent"
            // group, but keep it silent: an ongoing session notification must never
            // play a sound or vibrate on session start. Importance governs shade
            // placement; sound/vibration are separate channel settings, and
            // setOnlyAlertOnce only suppresses RE-alerts (not the first post), so
            // mute the channel itself here.
            setSound(null, null)
            enableVibration(false)
        }
        manager.createNotificationChannel(channel)
    }

    private fun buildNotification(withArt: Boolean = true): Notification {
        val art = planArt(withArt)
        val card = cardPayload
        val tone = cardTone()
        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_boardsesh_notification)
            .setStyle(NotificationCompat.DecoratedCustomViewStyle())
        if (card != null) {
            // Colorized so the system header matches the card and no box edge shows.
            builder
                .setCustomContentView(buildCardView(R.layout.notification_card_collapsed, card, tone, art))
                .setCustomBigContentView(buildCardView(R.layout.notification_card_expanded, card, tone, art))
                .setColor(SessionCardPainter.edgeColorFor(tone))
                .setColorized(true)
        } else {
            builder
                .setCustomContentView(buildContentView(R.layout.notification_session_collapsed, art.thumbnail))
                .setCustomBigContentView(buildContentView(R.layout.notification_session_expanded, art.thumbnail))
                .setColor(ContextCompat.getColor(this, R.color.session_accent))
        }
        builder
            .setOngoing(true)
            .setSilent(true)
            // DEFAULT-importance channel: alert once on first post so re-posting on
            // every climb/connection update doesn't re-peek the ongoing card.
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
            .setContentIntent(launchAppIntent())
        applyLighting(builder)

        val actions = sessionActions()
        if (card != null) {
            // The card draws its own controls. A watch still needs real actions, and
            // these reach it without adding a second row to the phone's card.
            builder.extend(NotificationCompat.WearableExtender().addActions(actions))
        } else {
            actions.forEach { builder.addAction(it) }
        }
        return builder.build()
    }

    // Controls follow ownership: only the driver (connectedByMe) gets
    // Previous/Next; everyone else gets just the outline bulb to (re)connect.
    private fun sessionActions(): List<NotificationCompat.Action> {
        if (boardConnection != CONNECTION_CONNECTED_BY_ME) {
            return listOf(
                NotificationCompat.Action(
                    R.drawable.ic_lightbulb_outline,
                    if (boardConnecting) connectingLabel else reconnectLabel,
                    outlineBulbPendingIntent(),
                ),
            )
        }
        val stopLabel = stopDrivingBulbLabel()
        return listOfNotNull(
            if (hasPrevious) {
                NotificationCompat.Action(R.drawable.ic_skip_previous, previousLabel, actionPendingIntent(ACTION_NAV_PREVIOUS, REQ_PREVIOUS))
            } else {
                null
            },
            NotificationCompat.Action(
                R.drawable.ic_lightbulb_filled,
                stopLabel ?: relightLabel,
                bulbPendingIntent(stopsDrive = stopLabel != null),
            ),
            if (hasNext) {
                NotificationCompat.Action(R.drawable.ic_skip_next, nextLabel, actionPendingIntent(ACTION_NAV_NEXT, REQ_NEXT))
            } else {
                null
            },
        )
    }

    // While this phone drives, the lit bulb stops driving, as the frosted button
    // does in the app. The re-post at a timed drive's end (and JS's own "off")
    // turns it back into a relight.
    private fun stopDrivingBulbLabel(): String? = stopDrivingLabel?.takeIf { currentLighting() != LightingDisplay.Off }

    private fun currentLighting(): LightingDisplay =
        resolveLighting(lightState, lightWindowEndMs, wallClockMs(), boardConnection)

    // Native owns this: a timed drive ends while Android has JS timers paused.
    private fun cardTone(): CardTone = if (currentLighting() == LightingDisplay.Off) CardTone.Grey else CardTone.Colour

    private fun currentCardArt(): CardArt? {
        val key = cardJson ?: return null
        return cardArtCache.get(key) ?: lastCardArt?.takeIf { key != failedCardKey }
    }

    // The lock screen card (#7327). Colours come from the layout or are set on every
    // build, so a RemoteViews that SystemUI reapplies can't leave a stale one behind.
    @VisibleForTesting
    internal fun buildCardView(layoutId: Int, card: CardPayload, tone: CardTone, art: ArtPlan): RemoteViews {
        val views = RemoteViews(packageName, layoutId)
        val expanded = layoutId == R.layout.notification_card_expanded
        val restShown = restTimer?.let { resolveRestDisplay(it, wallClockMs()) } != null
        val connected = boardConnection == CONNECTION_CONNECTED_BY_ME
        val holder = holderDisplayName?.takeIf { boardConnection == CONNECTION_HELD_BY_PEER && it.isNotBlank() }
        val holderLine = holder?.let { onWallTemplate.replace("{{name}}", it) }

        views.setTextViewText(R.id.session_title, climbName ?: contentTitleFallback)

        val position = if (totalClimbs > 0) "${currentIndex + 1} / $totalClimbs" else null
        val gradeInSlot = expanded && !restShown && card.gradeLabel != null
        val lead = if (expanded) position else (holderLine ?: position)
        views.setTextViewText(
            R.id.session_subtitle,
            cardMetadata(card, showGrade = !gradeInSlot, parts = listOfNotNull(lead, card.angleLabel)),
        )

        if (expanded) {
            views.setViewVisibility(R.id.session_card_grade, if (gradeInSlot) View.VISIBLE else View.GONE)
            views.setTextViewText(R.id.session_card_grade, card.gradeLabel.orEmpty())
            views.setTextColor(R.id.session_card_grade, card.gradeColor ?: ContextCompat.getColor(this, R.color.session_card_ink))
            bindMirror(views)
        }
        views.setViewVisibility(R.id.session_card_rest_scrim, if (restShown) View.VISIBLE else View.GONE)

        bindCardArt(views, expanded, tone, art.cardArt)
        bindCardControls(views, expanded, connected, restShown, holderLine)
        bindThumbnail(views, art.thumbnail)
        bindRestTimer(views)
        return views
    }

    private fun cardMetadata(card: CardPayload, showGrade: Boolean, parts: List<String>): CharSequence {
        val grade = card.gradeLabel?.takeIf { showGrade }
        val text = (listOfNotNull(grade) + parts).joinToString(" · ")
        if (grade == null) return text
        return SpannableString(text).apply {
            card.gradeColor?.let { setSpan(ForegroundColorSpan(it), 0, grade.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE) }
            setSpan(StyleSpan(Typeface.BOLD), 0, grade.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
    }

    private fun bindCardArt(views: RemoteViews, expanded: Boolean, tone: CardTone, show: Boolean) {
        val cardArt = if (show) currentCardArt() else null
        // Holds this climb's art up while the next climb's composes, so the card
        // doesn't blink to a plain surface on every Next.
        if (cardArt != null) lastCardArt = cardArt
        val panels = cardArt?.forTone(tone)
        if (panels == null) {
            views.setImageViewResource(R.id.session_card_art, 0)
            views.setViewVisibility(R.id.session_card_art, View.GONE)
            return
        }
        views.setViewVisibility(R.id.session_card_art, View.VISIBLE)
        views.setImageViewBitmap(R.id.session_card_art, if (expanded) panels.expanded else panels.collapsed)
    }

    // 10000 is a full ring: the drawable's level scale.
    private fun ringLevel(): Int {
        val window = currentLighting() as? LightingDisplay.Window ?: return RING_FULL_LEVEL
        if (lightWindowTotalMs <= 0L) return RING_FULL_LEVEL
        return ((window.endMs - wallClockMs()) * RING_FULL_LEVEL / lightWindowTotalMs).toInt().coerceIn(0, RING_FULL_LEVEL)
    }

    private fun bindCardControls(
        views: RemoteViews,
        expanded: Boolean,
        connected: Boolean,
        restShown: Boolean,
        holderLine: String?,
    ) {
        val connectLabel = if (boardConnecting) connectingLabel else reconnectLabel
        val stopLabel = if (connected) stopDrivingBulbLabel() else null
        val bulbIcon = when {
            !connected -> R.drawable.session_card_bulb_outline
            currentLighting() is LightingDisplay.Window -> R.drawable.session_card_bulb_ring
            currentLighting() == LightingDisplay.Driving -> R.drawable.session_card_bulb_disc
            else -> R.drawable.session_card_bulb_bare
        }
        views.setImageViewResource(R.id.session_bulb, bulbIcon)
        // After the resource: this is how far round the timed drive's ring is drawn.
        views.setInt(R.id.session_bulb, "setImageLevel", ringLevel())
        views.setContentDescription(R.id.session_bulb, if (connected) stopLabel ?: relightLabel else connectLabel)
        views.setOnClickPendingIntent(
            R.id.session_bulb,
            if (connected) bulbPendingIntent(stopsDrive = stopLabel != null) else outlineBulbPendingIntent(),
        )

        // The collapsed strip has no room for Next beside a rest clock.
        bindCardNav(
            views, R.id.session_next, nextLabel, hasNext, ACTION_NAV_NEXT, REQ_NEXT,
            visible = connected && (expanded || !restShown),
        )
        if (expanded) {
            bindCardNav(views, R.id.session_previous, previousLabel, hasPrevious, ACTION_NAV_PREVIOUS, REQ_PREVIOUS, visible = connected)
            views.setViewVisibility(R.id.session_card_status, if (connected) View.GONE else View.VISIBLE)
            views.setTextViewText(R.id.session_card_status, holderLine ?: connectLabel)
        }
    }

    // A button with nowhere to go keeps its slot, so the row doesn't jump between climbs.
    private fun bindCardNav(
        views: RemoteViews,
        viewId: Int,
        label: String,
        enabled: Boolean,
        navAction: String,
        requestCode: Int,
        visible: Boolean,
    ) {
        views.setViewVisibility(viewId, if (visible) View.VISIBLE else View.GONE)
        views.setContentDescription(viewId, label)
        views.setBoolean(viewId, "setEnabled", enabled)
        views.setInt(viewId, "setImageAlpha", if (enabled) 255 else DISABLED_CONTROL_ALPHA)
        views.setOnClickPendingIntent(viewId, if (visible && enabled) actionPendingIntent(navAction, requestCode) else null)
    }

    // internal so a test can inflate the result and assert the rendered holder line
    // without going through the DecoratedCustomViewStyle framework wrapper.
    @VisibleForTesting
    internal fun buildContentView(layoutId: Int, withArt: Boolean = true): RemoteViews {
        val views = RemoteViews(packageName, layoutId)
        views.setTextViewText(R.id.session_title, climbName ?: contentTitleFallback)

        val positionText = if (totalClimbs > 0) "${currentIndex + 1} / $totalClimbs" else ""
        val subtitleText = subtitle?.takeIf { it.isNotBlank() } ?: ""

        if (layoutId == R.layout.notification_session_expanded) {
            views.setTextViewText(R.id.session_subtitle, subtitleText)
            views.setTextViewText(R.id.session_position, positionText)
            val holder = holderDisplayName
            val holderLine = if (boardConnection == CONNECTION_HELD_BY_PEER && !holder.isNullOrBlank()) {
                // String.replace(String, String) is an unambiguous LITERAL, single-pass
                // substitution (no regex overload to resolve against), so a display name
                // that itself contains "{{name}}" is inserted verbatim, never re-expanded.
                onWallTemplate.replace("{{name}}", holder)
            } else {
                null
            }
            if (holderLine != null) {
                views.setViewVisibility(R.id.session_holder, android.view.View.VISIBLE)
                views.setTextViewText(R.id.session_holder, holderLine)
            } else {
                views.setViewVisibility(R.id.session_holder, android.view.View.GONE)
            }
        } else {
            // Collapsed: fold position into the subtitle line to fit one row.
            val collapsedSubtitle = listOf(subtitleText, positionText).filter { it.isNotBlank() }.joinToString(" · ")
            views.setTextViewText(R.id.session_subtitle, collapsedSubtitle)
        }

        bindMirror(views)
        bindThumbnail(views, withArt)
        bindRestTimer(views)
        return views
    }

    private fun bindMirror(views: RemoteViews) {
        val showMirror = supportsMirroring && sessionId.isNotEmpty() && queueItemUuid.isNotEmpty() &&
            boardConnection == CONNECTION_CONNECTED_BY_ME
        views.setViewVisibility(R.id.session_mirror, if (showMirror) android.view.View.VISIBLE else android.view.View.GONE)
        views.setContentDescription(R.id.session_mirror, if (mirrored) unmirrorLabel else mirrorLabel)
        views.setInt(R.id.session_mirror, "setImageAlpha", if (mirrored) 255 else 140)
        if (showMirror) views.setOnClickPendingIntent(R.id.session_mirror, mirrorPendingIntent())
    }

    private fun currentThumbnail(): Bitmap? {
        val overlay = overlayPath?.takeIf { it.isNotBlank() } ?: return null
        return bitmapCache.get(imageKey(overlay, backgroundPaths, mirrored))
            // Same climb, new variant (mirror toggled, backgrounds resolved late):
            // keep its last board up while that variant composes, rather than flash
            // the placeholder, and keep it if the variant's compose fails, since the
            // climb's own board beats a hidden slot.
            ?: lastShownThumbnail?.takeIf { it.first == overlay }?.second
    }

    // The check runs before posting because a Binder failure on the promotion path
    // may never reach our catch. The thumbnail is parcelled once per layout, and the
    // bokeh goes first: the climb's own board is the part worth keeping.
    private fun planArt(withArt: Boolean): ArtPlan {
        if (!withArt) return ArtPlan(thumbnail = false, cardArt = false)
        val thumbnailBytes = (currentThumbnail()?.byteCount ?: 0) * LAYOUTS_CARRYING_ART
        val cardBytes = if (cardPayload != null) currentCardArt()?.forTone(cardTone())?.byteCount ?: 0 else 0
        if (thumbnailBytes + cardBytes <= MAX_PARCELLED_ART_BYTES) return ArtPlan(thumbnail = true, cardArt = true)
        reportPostFailure("art-over-budget", null)
        return ArtPlan(thumbnail = thumbnailBytes <= MAX_PARCELLED_ART_BYTES, cardArt = false)
    }

    // Every branch sets both the image and the visibility. SystemUI may reapply a
    // later RemoteViews onto the view tree it already shows, so a branch that set
    // nothing would leave the previous climb's board (or a hidden slot) in place.
    private fun bindThumbnail(views: RemoteViews, withArt: Boolean) {
        val overlay = overlayPath?.takeIf { it.isNotBlank() }
        val key = overlay?.let { imageKey(it, backgroundPaths, mirrored) }
        val bitmap = if (withArt) currentThumbnail() else null
        if (overlay != null && bitmap != null) {
            lastShownThumbnail = overlay to bitmap
            views.setViewVisibility(R.id.session_image, View.VISIBLE)
            views.setImageViewBitmap(R.id.session_image, bitmap)
            return
        }
        // Resource 0 clears the drawable, leaving the dark rounded background.
        views.setImageViewResource(R.id.session_image, 0)
        // Nothing of this climb to show. The placeholder holds the slot while its
        // compose runs. With no overlay, or once the compose failed, hide it: an
        // empty black box reads as a broken picture.
        val composing = withArt && key != null && key != failedImageKey
        views.setViewVisibility(R.id.session_image, if (composing) View.VISIBLE else View.GONE)
    }

    // Every re-post goes through here. A failed post leaves the last card up, which
    // keeps showing a climb the wall has moved on from, so retry once without art:
    // art is the only part of the card large enough to fail on its own.
    private fun postNotification(stage: String) {
        try {
            notificationPoster(buildNotification())
        } catch (error: Exception) {
            reportPostFailure(stage, error)
            try {
                notificationPoster(buildNotification(withArt = false))
            } catch (retryError: Exception) {
                Log.w(TAG, "$stage re-post without art failed: ${retryError.message}")
            }
        }
    }

    // Once per stage per service, so a card that fails on every climb can't crowd
    // real taps out of the bounded event buffer. Only the error's class crosses to
    // JS: a message could carry payload values.
    private fun reportPostFailure(stage: String, error: Exception?) {
        Log.w(TAG, "notification post failed at $stage: ${error?.javaClass?.simpleName}: ${error?.message}")
        if (reportedPostFailures.add(stage)) {
            SessionPresenceModule.dispatchNotificationPostFailed(stage, error?.javaClass?.simpleName)
        }
    }

    // --- Rest countdown ---

    private fun restTimerFrom(intent: Intent): RestTimerSnapshot? {
        fun longExtra(key: String): Long? = if (intent.hasExtra(key)) intent.getLongExtra(key, 0L) else null
        val status = intent.getStringExtra(EXTRA_REST_STATUS) ?: return null
        if (status !in REST_STATUSES) return null
        return RestTimerSnapshot(
            status = status,
            startMs = longExtra(EXTRA_REST_START_MS),
            deadlineMs = longExtra(EXTRA_REST_DEADLINE_MS),
            periodSeconds = longExtra(EXTRA_REST_PERIOD_SECONDS),
            frozenSignedSeconds = longExtra(EXTRA_REST_FROZEN_SECONDS),
            caption = intent.getStringExtra(EXTRA_REST_CAPTION),
            overCaption = intent.getStringExtra(EXTRA_REST_OVER_CAPTION),
        )
    }

    // The custom view's rest block: a ticking Chronometer for a running,
    // counting-up or queue-ended rest, a static clock for paused / waiting, and the
    // localized caption under it. GONE when there is no rest timer. "Over" and
    // "muted" (queue ended) use twin views (session_rest_*_over / _muted) rather
    // than setTextColor: every build sets every value view's visibility, so a
    // reapplied RemoteViews can never leave a stale colour behind.
    private fun bindRestTimer(views: RemoteViews) {
        val display = restTimer?.let { resolveRestDisplay(it, wallClockMs()) }
        val shownValueId: Int? = when (display) {
            null -> null
            is RestDisplay.Countdown -> when {
                display.muted -> R.id.session_rest_clock_muted
                display.over -> R.id.session_rest_clock_over
                else -> R.id.session_rest_clock
            }
            is RestDisplay.CountUp -> if (display.muted) R.id.session_rest_clock_muted else R.id.session_rest_clock
            is RestDisplay.Frozen -> when {
                display.text == null -> null
                display.over -> R.id.session_rest_static_over
                else -> R.id.session_rest_static
            }
        }
        for (valueId in REST_VALUE_VIEW_IDS) {
            views.setViewVisibility(valueId, if (valueId == shownValueId) View.VISIBLE else View.GONE)
        }
        // Stop every Chronometer that isn't the one shown, so nothing ticks off-screen.
        for (clockId in REST_CLOCK_VIEW_IDS) {
            if (clockId != shownValueId) views.setChronometer(clockId, elapsedRealtimeMs(), null, false)
        }

        if (display == null) {
            views.setViewVisibility(R.id.session_rest, View.GONE)
            return
        }
        views.setViewVisibility(R.id.session_rest, View.VISIBLE)
        // Past the deadline an after-tick rest swaps to its "over" caption. The
        // service's own deadline re-post lands here while JS is suspended, so the
        // caption turns with the digits instead of waiting for the app.
        val overCaption = restTimer?.overCaption?.takeIf { it.isNotBlank() }
        val showsOver = display is RestDisplay.Countdown && display.over && !display.muted
        val caption = (if (showsOver) overCaption else null) ?: restTimer?.caption?.takeIf { it.isNotBlank() }
        views.setViewVisibility(R.id.session_rest_caption, if (caption != null) View.VISIBLE else View.GONE)
        views.setTextViewText(R.id.session_rest_caption, caption ?: "")

        // Chronometer counts against SystemClock.elapsedRealtime(), not the wall
        // clock, so shift the epoch anchors into that timebase.
        val toElapsedRealtimeMs = elapsedRealtimeMs() - wallClockMs()
        when (display) {
            is RestDisplay.Countdown -> {
                // Counts down to the deadline, then on into negative ("−00:12"),
                // the same "over your rest" reading as the app's red digits.
                val clockId = shownValueId ?: return
                views.setChronometerCountDown(clockId, true)
                views.setChronometer(clockId, display.deadlineMs + toElapsedRealtimeMs, null, true)
            }
            is RestDisplay.CountUp -> {
                val clockId = shownValueId ?: return
                views.setChronometerCountDown(clockId, false)
                views.setChronometer(clockId, display.startMs + toElapsedRealtimeMs, null, true)
            }
            is RestDisplay.Frozen -> {
                val textId = shownValueId ?: return
                views.setTextViewText(textId, display.text ?: "")
            }
        }
    }

    // Arms one main-thread re-post at the rest's next transition (its deadline or
    // the next on-the-minute beat). Re-armed after every promotion and every
    // transition; cancelled on stop. Nothing is armed for a static display or an
    // after-tick rest that is already over.
    private fun scheduleRestTransition() {
        cancelOnMain(restTransition)
        val display = restTimer?.let { resolveRestDisplay(it, wallClockMs()) } as? RestDisplay.Countdown ?: return
        val transitionMs = display.nextTransitionMs ?: return
        val delayMs = (transitionMs - wallClockMs()).coerceAtLeast(0L) + REST_TRANSITION_SLACK_MS
        scheduleOnMain(restTransition, delayMs)
    }

    private fun onRestTransition() {
        if (!foregrounded) return
        postNotification("rest-transition")
        scheduleRestTransition()
    }

    // --- Driving the wall (2.7) ---

    // The header while picks light: the sub-text says "Driving the wall" and,
    // for a timed drive, the system's countdown chronometer runs to its end
    // (never our own text over it, so TalkBack reads the clock itself). Only
    // the phone that holds the board shows it; the rest timer keeps the
    // content Chronometer.
    private fun applyLighting(builder: NotificationCompat.Builder) {
        val lighting = resolveLighting(lightState, lightWindowEndMs, wallClockMs(), boardConnection)
        when (lighting) {
            is LightingDisplay.Window -> builder
                .setSmallIcon(R.drawable.ic_lightbulb_filled)
                .setSubText(lightDrivingLabel)
                .setUsesChronometer(true)
                .setChronometerCountDown(true)
                .setWhen(lighting.endMs)
                .setShowWhen(true)
            LightingDisplay.Driving -> builder
                .setSmallIcon(R.drawable.ic_lightbulb_filled)
                .setSubText(lightDrivingLabel)
            LightingDisplay.Off -> Unit
        }
    }

    // Arms one re-post just after a timed drive ends. Nothing for an open-ended drive or off.
    private fun scheduleLightTransition() {
        cancelOnMain(lightTransition)
        val window = resolveLighting(lightState, lightWindowEndMs, wallClockMs(), boardConnection)
            as? LightingDisplay.Window ?: return
        val delayMs = (window.endMs - wallClockMs()).coerceAtLeast(0L) + REST_TRANSITION_SLACK_MS
        scheduleOnMain(lightTransition, delayMs)
    }

    private fun onLightTransition() {
        if (!foregrounded) return
        postNotification("lighting-transition")
        scheduleLightTransition()
        scheduleLightRingTick()
    }

    // RemoteViews can't animate, so the ring drains in steps of a re-post. Only with
    // the screen on: nobody can see it otherwise, and turning the screen on re-posts.
    private fun scheduleLightRingTick() {
        cancelOnMain(lightRingTick)
        if (cardPayload == null || !screenInteractive()) return
        val window = currentLighting() as? LightingDisplay.Window ?: return
        val delayMs = (lightWindowTotalMs / RING_STEPS).coerceAtLeast(MIN_RING_TICK_MS)
        // The end's own re-post finishes the job.
        if (wallClockMs() + delayMs >= window.endMs) return
        scheduleOnMain(lightRingTick, delayMs)
    }

    private fun onLightRingTick() {
        if (!foregrounded) return
        postNotification("lighting-ring")
        scheduleLightRingTick()
    }

    // One re-post for whatever the phone slept through, then both transitions
    // re-armed from now.
    private fun onScreenOn() {
        if (restTimer == null && lightState == LIGHT_STATE_OFF) return
        if (!foregrounded) return
        postNotification("screen-on")
        scheduleRestTransition()
        scheduleLightTransition()
        scheduleLightRingTick()
    }

    // Minimal notification for when buildNotification() throws: no RemoteViews,
    // bitmaps, or extra pending intents, so it can still satisfy the
    // startForeground() contract.
    private fun buildFallbackNotification(): Notification {
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_boardsesh_notification)
            .setContentTitle(climbName ?: contentTitleFallback)
            .setOngoing(true)
            .setSilent(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .build()
    }

    private fun launchAppIntent(): PendingIntent? {
        val launch = packageManager.getLaunchIntentForPackage(packageName) ?: return null
        return PendingIntent.getActivity(this, REQ_CONTENT, launch, pendingFlags())
    }

    private fun actionPendingIntent(navAction: String, requestCode: Int): PendingIntent {
        // The JS bridge navigates to the ABSOLUTE queue[currentIndex] (it ignores
        // the action), so send the TARGET index — currentIndex ∓ 1 — not the
        // current one, or both buttons would re-select the current climb (a no-op).
        // An out-of-range target (e.g. Next on the last climb) is dropped by the
        // bridge's range guard.
        val targetIndex = when (navAction) {
            ACTION_NAV_PREVIOUS -> currentIndex - 1
            ACTION_NAV_NEXT -> currentIndex + 1
            else -> currentIndex
        }
        val intent = Intent(this, BoardSessionActionReceiver::class.java).apply {
            action = navAction
            putExtra(EXTRA_CURRENT_INDEX, targetIndex)
            putExtra(EXTRA_CORRELATION_ID, UUID.randomUUID().toString())
        }
        return PendingIntent.getBroadcast(this, requestCode, intent, pendingFlags())
    }

    // The lightbulb carries the current ownership so the receiver can choose
    // reassert (connectedByMe) vs reconnect; the notification is rebuilt on every
    // update, so the extra is always current.
    private fun mirrorPendingIntent(): PendingIntent {
        val intent = Intent(this, BoardSessionActionReceiver::class.java).apply {
            action = ACTION_MIRROR
            putExtra(EXTRA_SESSION_ID, sessionId)
            putExtra(EXTRA_QUEUE_ITEM_UUID, queueItemUuid)
            putExtra(EXTRA_MIRRORED, !mirrored)
        }
        return PendingIntent.getBroadcast(this, REQ_MIRROR, intent, pendingFlags())
    }

    // With no remembered board a background reconnect can only end in the board
    // list, which would land on a paused activity where nobody can pick from it.
    // Open the app instead (an activity PendingIntent: Android 12+ forbids a
    // broadcast receiver from starting one), and the climber connects from the
    // in-app bulb (#7087).
    private fun outlineBulbPendingIntent(): PendingIntent {
        if (bulbOpensApp) launchAppIntent()?.let { return it }
        return bulbPendingIntent()
    }

    // stopsDrive: the lit bulb was drawn as Stop driving, so the receiver
    // dispatches stopDriving instead of reassert.
    private fun bulbPendingIntent(stopsDrive: Boolean = false): PendingIntent {
        val intent = Intent(this, BoardSessionActionReceiver::class.java).apply {
            action = ACTION_BULB
            putExtra(EXTRA_BOARD_CONNECTION, boardConnection)
            putExtra(EXTRA_STOPS_DRIVE, stopsDrive)
            putExtra(EXTRA_CORRELATION_ID, UUID.randomUUID().toString())
        }
        return PendingIntent.getBroadcast(this, REQ_BULB, intent, pendingFlags())
    }

    private fun pendingFlags(): Int {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        } else {
            PendingIntent.FLAG_UPDATE_CURRENT
        }
    }

    // --- Climb thumbnail (on-device, no network) ---

    // The composited bitmap depends on BOTH the overlay AND the backgrounds, so the
    // cache / in-flight / stale-guard key must fold in the backgrounds — otherwise a
    // late background resolution (JS first sends the overlay with empty backgrounds,
    // then re-fires once the bundled board layers are cached) would hit the cached
    // holds-only composite keyed by overlay alone and never re-render with the board
    // photo. The separator is a null char (never present in a file path).
    private fun imageKey(overlay: String, backgrounds: List<String>, mirrored: Boolean): String {
        val base = if (backgrounds.isEmpty()) overlay else overlay + "\u0000" + backgrounds.joinToString("\u0000")
        return if (mirrored) base + "\u0000mirrored" else base
    }

    // Composites the current climb's thumbnail off the main thread (after
    // promotion), then re-posts the notification with it. Never blocks
    // startForeground(), never touches the network.
    private fun maybeComposeImage() {
        val overlay = overlayPath?.takeIf { it.isNotBlank() } ?: return
        val backgrounds = backgroundPaths
        val imageMirrored = mirrored
        val key = imageKey(overlay, backgrounds, imageMirrored)
        currentImageKey = key
        if (bitmapCache.get(key) != null) return
        if (!inFlight.add(key)) return
        imageExecutor.execute {
            var composeError: Throwable? = null
            val bitmap = try {
                imageComposer(overlay, backgrounds)?.let { orientThumbnail(it, imageMirrored) }
            } catch (error: Throwable) {
                // Throwable, not Exception: decoding/compositing large board PNGs can
                // OutOfMemoryError on low-memory devices, which is an Error — catching
                // only Exception would let it kill this background thread noisily.
                // Degrade to no thumbnail (the notification still posts without art).
                composeError = error
                null
            } finally {
                inFlight.remove(key)
            }
            if (bitmap == null) {
                // Every update for this climb retries the compose; only the first
                // failure logs and re-posts (the re-post hides the placeholder).
                if (failedImageKey == key) return@execute
                failedImageKey = key
                if (composeError != null) {
                    Log.w(TAG, "thumbnail compose failed: ${composeError.javaClass.simpleName}: ${composeError.message}")
                } else {
                    Log.w(TAG, "thumbnail overlay did not decode (file exists: ${File(localFilePath(overlay)).exists()})")
                }
            } else {
                bitmapCache.put(key, bitmap)
                if (failedImageKey == key) failedImageKey = null
            }
            postToMain {
                // Stale guard: the climb may have moved on (or the session ended)
                // while the compose was in flight.
                if (currentImageKey != key || !foregrounded) return@postToMain
                postNotification("thumbnail")
            }
        }
    }

    // Paints the card's bokeh off the main thread, then re-posts. Keyed on the JSON
    // itself, which changes exactly when the picture does.
    private fun maybeComposeCardArt() {
        // Before the returns, so a payload the kill switch dropped mid-compose goes stale.
        currentCardKey = cardJson
        val key = cardJson ?: return
        val payload = cardPayload ?: return
        if (cardArtCache.get(key) != null) return
        if (!inFlight.add(key)) return
        imageExecutor.execute {
            val art = try {
                cardArtComposer(payload)
            } catch (error: Throwable) {
                // Throwable: an OutOfMemoryError here must only cost the bokeh.
                Log.w(TAG, "card art compose failed: ${error.javaClass.simpleName}: ${error.message}")
                null
            } finally {
                inFlight.remove(key)
            }
            if (art == null) {
                if (failedCardKey == key) return@execute
                failedCardKey = key
            } else {
                cardArtCache.put(key, art)
                if (failedCardKey == key) failedCardKey = null
            }
            postToMain {
                if (currentCardKey != key || !foregrounded) return@postToMain
                postNotification("card-art")
            }
        }
    }

    // Decode the bundled board background layers + the holds-only overlay (both
    // local PNGs from the BoardRenderer module / bundled assets) and stack them on
    // a dark base. No server.
    private fun composeThumbnail(overlay: String, backgrounds: List<String>): Bitmap? {
        val overlayBitmap = decodeLocalFile(overlay) ?: return null
        var composed: Bitmap? = null
        var scaled: Bitmap? = null
        var rounded: Bitmap? = null
        try {
            val width = overlayBitmap.width
            val height = overlayBitmap.height
            composed = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(composed)
            canvas.drawColor(thumbBackingColor)
            val dst = Rect(0, 0, width, height)
            for (path in backgrounds) {
                val background = decodeLocalFile(path) ?: continue
                try {
                    canvas.drawBitmap(background, null, dst, null)
                } finally {
                    background.recycle()
                }
            }
            canvas.drawBitmap(overlayBitmap, null, dst, null)
            scaled = downscale(composed)
            rounded = roundCorners(scaled)
            return rounded
        } finally {
            // Recycle every decoded/intermediate bitmap; only the returned `rounded`
            // survives (roundCorners always allocates a fresh one). On the success
            // path this is the eager free that keeps native bitmap memory off the GC;
            // on an exception path (e.g. createBitmap/createScaledBitmap OOM) it stops
            // a leak the outer Throwable catch would otherwise silently swallow.
            overlayBitmap.recycle()
            composed?.let { if (it !== scaled && it !== rounded) it.recycle() }
            scaled?.let { if (it !== rounded) it.recycle() }
        }
    }

    private fun decodeLocalFile(path: String): Bitmap? = BitmapFactory.decodeFile(localFilePath(path))

    // Cap the long side so a large render can't blow the ~1 MB RemoteViews Binder
    // transaction limit. The bitmap is parcelled TWICE — RemoteViews doesn't dedupe,
    // and setImageViewBitmap runs in both the collapsed and expanded views — so the
    // transaction carries 2× the single-bitmap size. At 256 px the worst case is a
    // square board: 256·256·4 = 256 KB per copy → ~512 KB for both, comfortably under
    // the limit (a portrait board, the common case, is smaller still).
    // internal so a test can pin the cap without the decode/compose shadows.
    internal fun downscale(src: Bitmap): Bitmap {
        val longSide = maxOf(src.width, src.height)
        if (longSide <= MAX_IMAGE_DIMEN) return src
        val scale = MAX_IMAGE_DIMEN.toFloat() / longSide
        return Bitmap.createScaledBitmap(src, (src.width * scale).toInt(), (src.height * scale).toInt(), true)
    }

    private fun roundCorners(src: Bitmap): Bitmap {
        val radius = IMAGE_CORNER_DP * resources.displayMetrics.density
        val output = Bitmap.createBitmap(src.width, src.height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(output)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        val rect = RectF(0f, 0f, src.width.toFloat(), src.height.toFloat())
        // Opaque dark rounded backing first: a holds-only render (transparent
        // background) then reads as a dark board with lit holds instead of letting
        // the (near-white on Android 12+) notification surface show through. A
        // fully composited board photo is opaque and simply covers this.
        paint.color = thumbBackingColor
        canvas.drawRoundRect(rect, radius, radius, paint)
        // Draw the render on top, clipped to the rounded backing (SRC_ATOP keeps the
        // backing wherever the render is transparent).
        paint.xfermode = PorterDuffXfermode(PorterDuff.Mode.SRC_ATOP)
        canvas.drawBitmap(src, 0f, 0f, paint)
        return output
    }

    companion object {
        // v2 channel at IMPORTANCE_DEFAULT (the original boardsesh_session was LOW;
        // importance can't be raised in place, so a new id is required).
        const val CHANNEL_ID = "boardsesh_session_active"
        private const val LEGACY_CHANNEL_ID = "boardsesh_session"
        const val NOTIFICATION_ID = 4711
        private const val TAG = "BoardSession"

        private const val MAX_IMAGE_DIMEN = 256
        private const val IMAGE_CORNER_DP = 8f
        // Cap the thumbnail cache by BYTES (Android bitmap best practice), not entry
        // count, so it can't balloon if a board ever renders larger than the 256px
        // downscale ceiling. ~256 KB per thumbnail → ~8 entries at 2 MB.
        private const val BITMAP_CACHE_BYTES = 2 * 1024 * 1024

        // Ceiling for bitmap bytes in one posted notification, under the ~1 MB Binder
        // transaction limit with room left for the views, extras and intents.
        private const val MAX_PARCELLED_ART_BYTES = 700 * 1024
        private const val LAYOUTS_CARRYING_ART = 2

        // 38%: the Material figure for a disabled icon.
        private const val DISABLED_CONTROL_ALPHA = 97

        // Both tones of a climb's two panels are about 175 KB, so roughly six climbs.
        private const val CARD_ART_CACHE_BYTES = 1024 * 1024

        const val EXTRA_CARD_JSON = "cardJson"

        private const val RING_FULL_LEVEL = 10_000
        private const val RING_STEPS = 40L
        private const val MIN_RING_TICK_MS = 1_000L

        /**
         * The filesystem path for an overlay or background JS handed over. A
         * scheme-less path is used as is. A `file://` URI is read raw when that file
         * exists (the renderer's own unencoded form), and otherwise decoded, since
         * `Uri.fromFile` encodes characters such as the `,` in overlay names as `%2C`.
         * Reading the raw form first means a literal `%` in a name is never decoded.
         */
        @VisibleForTesting
        internal fun localFilePath(path: String, exists: (String) -> Boolean = { File(it).exists() }): String {
            if (!path.startsWith("file://")) return path
            val raw = path.removePrefix("file://")
            if (exists(raw)) return raw
            return Uri.parse(path).path ?: raw
        }

        @VisibleForTesting
        internal fun orientThumbnail(bitmap: Bitmap, mirrored: Boolean): Bitmap {
            if (!mirrored) return bitmap
            val transform = Matrix().apply { setScale(-1f, 1f) }
            return Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, transform, true)
        }

        const val ACTION_START = "com.boardsesh.liveactivity.action.START"
        const val ACTION_UPDATE = "com.boardsesh.liveactivity.action.UPDATE"
        const val ACTION_STOP = "com.boardsesh.liveactivity.action.STOP"
        const val ACTION_NAV_PREVIOUS = "com.boardsesh.liveactivity.action.NAV_PREVIOUS"
        const val ACTION_NAV_NEXT = "com.boardsesh.liveactivity.action.NAV_NEXT"
        const val ACTION_MIRROR = "com.boardsesh.liveactivity.action.MIRROR"
        const val ACTION_BULB = "com.boardsesh.liveactivity.action.BULB"
        const val ACTION_REST_TIMER = "com.boardsesh.liveactivity.action.REST_TIMER"
        const val ACTION_LIGHTING = "com.boardsesh.liveactivity.action.LIGHTING"

        // Driving the wall (2.7): LIGHT_STATE_* and, for a timed drive
        // (LIGHT_STATE_WINDOW), its end in epoch ms. The header's line rides
        // ACTION_START.
        const val EXTRA_LIGHT_STATE = "lightState"
        const val EXTRA_LIGHT_WINDOW_END_MS = "lightWindowEndMs"
        const val EXTRA_LIGHT_WINDOW_SECONDS = "lightWindowSeconds"
        const val EXTRA_LIGHT_DRIVING_LABEL = "lightDrivingLabel"
        // The lit bulb's Stop driving label (from JS, on ACTION_START), and the
        // bulb intent's flag that it was drawn as Stop driving.
        const val EXTRA_STOP_DRIVING_LABEL = "stopDrivingLabel"
        const val EXTRA_STOPS_DRIVE = "stopsDrive"

        // The same words as LightingWindowStore's modes and the JS
        // LiveActivityLightingMode.
        const val LIGHT_STATE_OFF = LightingWindowStore.MODE_OFF
        const val LIGHT_STATE_WINDOW = LightingWindowStore.MODE_WINDOW
        const val LIGHT_STATE_DRIVING = LightingWindowStore.MODE_DRIVING
        private val LIGHT_STATES = setOf(LIGHT_STATE_OFF, LIGHT_STATE_WINDOW, LIGHT_STATE_DRIVING)

        /**
         * What the header shows at [nowMs]: a timed drive counting down to its
         * end, an open-ended drive, or nothing. A timed drive past its end, or one on a phone that
         * doesn't hold the board, shows nothing. Pure, for tests.
         */
        @VisibleForTesting
        internal fun resolveLighting(state: String, windowEndMs: Long?, nowMs: Long, boardConnection: String): LightingDisplay {
            if (boardConnection != CONNECTION_CONNECTED_BY_ME) return LightingDisplay.Off
            return when (state) {
                LIGHT_STATE_DRIVING -> LightingDisplay.Driving
                LIGHT_STATE_WINDOW -> windowEndMs?.takeIf { it > nowMs }?.let { LightingDisplay.Window(it) } ?: LightingDisplay.Off
                else -> LightingDisplay.Off
            }
        }

        /** The service intent that hands [snapshot] (null: off) to the notification for [sessionId]. */
        internal fun lightingIntent(context: Context, sessionId: String, snapshot: LightingWindowSnapshot?): Intent =
            Intent(context, BoardSessionService::class.java).apply {
                action = ACTION_LIGHTING
                putExtra(EXTRA_SESSION_ID, sessionId)
                putExtra(EXTRA_LIGHT_STATE, snapshot?.mode ?: LIGHT_STATE_OFF)
                snapshot?.endsAtMs?.let { putExtra(EXTRA_LIGHT_WINDOW_END_MS, it) }
                snapshot?.windowSeconds?.let { putExtra(EXTRA_LIGHT_WINDOW_SECONDS, it) }
            }

        const val EXTRA_REST_CLEAR = "restClear"
        const val EXTRA_REST_STATUS = "restStatus"
        const val EXTRA_REST_START_MS = "restStartMs"
        const val EXTRA_REST_DEADLINE_MS = "restDeadlineMs"
        const val EXTRA_REST_PERIOD_SECONDS = "restPeriodSeconds"
        const val EXTRA_REST_FROZEN_SECONDS = "restFrozenSignedSeconds"
        const val EXTRA_REST_CAPTION = "restCaption"
        const val EXTRA_REST_OVER_CAPTION = "restOverCaption"

        // LiveActivityRestTimerOptions.status values (modules/live-activity/src/index.ts).
        const val REST_STATUS_RUNNING = "running"
        const val REST_STATUS_PAUSED = "paused"
        const val REST_STATUS_WAITING = "waiting"
        const val REST_STATUS_QUEUE_ENDED = "queueEnded"
        const val REST_STATUS_COUNT_UP = "countUp"
        private val REST_STATUSES = setOf(
            REST_STATUS_RUNNING,
            REST_STATUS_PAUSED,
            REST_STATUS_WAITING,
            REST_STATUS_QUEUE_ENDED,
            REST_STATUS_COUNT_UP,
        )

        // Re-post a beat just after it rolls, not on the boundary itself, so the
        // resolver sees "now" past the deadline and picks the next beat.
        internal const val REST_TRANSITION_SLACK_MS = 250L

        private val REST_CLOCK_VIEW_IDS =
            intArrayOf(R.id.session_rest_clock, R.id.session_rest_clock_over, R.id.session_rest_clock_muted)
        private val REST_VALUE_VIEW_IDS = REST_CLOCK_VIEW_IDS +
            intArrayOf(R.id.session_rest_static, R.id.session_rest_static_over)

        /**
         * What the rest block shows at [nowMs]. Pure, so the beat roll and the
         * over/under split are testable without RemoteViews.
         *
         * - running, after a tick: count down to the deadline; once past it the
         *   Chronometer runs negative and the digits turn red ([RestDisplay.Countdown.over]).
         * - running, on the minute ([RestTimerSnapshot.periodSeconds]): count down
         *   to the next beat at or after [nowMs]; a beat is never "over".
         * - countUp: count up from the start.
         * - queue ended: the same live clock as running / countUp (the app's pill
         *   keeps ticking too), drawn muted: never the over red, and an after-tick
         *   rest needs no re-post at its deadline because nothing changes there.
         * - paused / waiting: a static clock from the frozen value.
         *
         * Returns null when the snapshot lacks what its status needs.
         */
        @VisibleForTesting
        internal fun resolveRestDisplay(rest: RestTimerSnapshot, nowMs: Long): RestDisplay? {
            return when (rest.status) {
                REST_STATUS_RUNNING -> rest.deadlineMs?.let { countdown(it, rest.periodSeconds, nowMs, muted = false) }
                REST_STATUS_COUNT_UP -> rest.startMs?.let { RestDisplay.CountUp(startMs = it) }
                REST_STATUS_QUEUE_ENDED -> when {
                    rest.deadlineMs != null -> countdown(rest.deadlineMs, rest.periodSeconds, nowMs, muted = true)
                    rest.startMs != null -> RestDisplay.CountUp(startMs = rest.startMs, muted = true)
                    else -> frozen(rest)
                }
                REST_STATUS_PAUSED, REST_STATUS_WAITING -> frozen(rest)
                else -> null
            }
        }

        // A countdown to [deadlineMs]. With a period (on the minute) it rolls to
        // the next beat at or after [nowMs] and is never over; without one it goes
        // over at the deadline. Muted (queue ended) skips the deadline re-post: a
        // muted clock looks the same either side of zero.
        private fun countdown(deadlineMs: Long, periodSeconds: Long?, nowMs: Long, muted: Boolean): RestDisplay.Countdown {
            val periodMs = periodSeconds?.takeIf { it > 0 }?.times(1000L)
            if (periodMs != null) {
                val beatMs = if (nowMs < deadlineMs) {
                    deadlineMs
                } else {
                    deadlineMs + ((nowMs - deadlineMs) / periodMs + 1) * periodMs
                }
                return RestDisplay.Countdown(deadlineMs = beatMs, over = false, nextTransitionMs = beatMs, muted = muted)
            }
            val over = nowMs >= deadlineMs
            return RestDisplay.Countdown(
                deadlineMs = deadlineMs,
                over = over,
                nextTransitionMs = if (over || muted) null else deadlineMs,
                muted = muted,
            )
        }

        private fun frozen(rest: RestTimerSnapshot): RestDisplay.Frozen {
            val frozen = rest.frozenSignedSeconds
            return RestDisplay.Frozen(text = frozen?.let { formatSignedSeconds(it) }, over = frozen != null && frozen < 0)
        }

        /**
         * The frozen clock in the Chronometer's own format (DateUtils "MM:SS", and
         * the same U+2212 minus Chronometer uses past zero), so pausing a running
         * rest doesn't change how the digits look.
         */
        @VisibleForTesting
        internal fun formatSignedSeconds(signedSeconds: Long): String {
            val label = DateUtils.formatElapsedTime(kotlin.math.abs(signedSeconds))
            return if (signedSeconds < 0) "−$label" else label
        }

        const val EXTRA_SESSION_ID = "sessionId"
        const val EXTRA_QUEUE_ITEM_UUID = "queueItemUuid"
        const val EXTRA_SUPPORTS_MIRRORING = "supportsMirroring"
        const val EXTRA_MIRRORED = "mirrored"
        const val EXTRA_MIRROR_LABEL = "mirrorLabel"
        const val EXTRA_UNMIRROR_LABEL = "unmirrorLabel"
        const val EXTRA_CHANNEL_NAME = "channelName"
        const val EXTRA_CHANNEL_DESC = "channelDescription"
        const val EXTRA_TITLE_FALLBACK = "contentTitleFallback"
        const val EXTRA_PREV_LABEL = "previousLabel"
        const val EXTRA_NEXT_LABEL = "nextLabel"
        const val EXTRA_RELIGHT_LABEL = "relightLabel"
        const val EXTRA_RECONNECT_LABEL = "reconnectLabel"
        const val EXTRA_CONNECTING_LABEL = "connectingLabel"
        const val EXTRA_BULB_OPENS_APP = "bulbOpensApp"
        const val EXTRA_BOARD_CONNECTING = "boardConnecting"
        const val EXTRA_ON_WALL_TEMPLATE = "onWallTemplate"
        const val EXTRA_CLIMB_NAME = "climbName"
        const val EXTRA_SUBTITLE = "subtitle"
        const val EXTRA_HAS_NEXT = "hasNext"
        const val EXTRA_HAS_PREVIOUS = "hasPrevious"
        const val EXTRA_CURRENT_INDEX = "currentIndex"
        const val EXTRA_TOTAL_CLIMBS = "totalClimbs"
        const val EXTRA_BOARD_CONNECTION = "boardConnection"
        const val EXTRA_HOLDER_NAME = "holderDisplayName"
        const val EXTRA_CORRELATION_ID = "correlationId"
        const val EXTRA_OVERLAY_PATH = "overlayPath"
        const val EXTRA_BACKGROUND_PATHS = "backgroundPaths"

        const val CONNECTION_CONNECTED_BY_ME = "connectedByMe"
        const val CONNECTION_HELD_BY_PEER = "heldByPeer"
        const val CONNECTION_DISCONNECTED = "disconnected"

        private const val REQ_PREVIOUS = 0
        private const val REQ_NEXT = 1
        private const val REQ_CONTENT = 2
        private const val REQ_BULB = 3
        private const val REQ_MIRROR = 4

        // Process-static so a rapid stop/start keeps thumbnails warm (mirrors the
        // iOS ThumbnailFetcher's persistent cache intent) and so a single worker
        // thread serves every service instance instead of leaking one per restart.
        private val bitmapCache = object : LruCache<String, Bitmap>(BITMAP_CACHE_BYTES) {
            override fun sizeOf(key: String, value: Bitmap): Int = value.byteCount
        }
        private val cardArtCache = object : LruCache<String, CardArt>(CARD_ART_CACHE_BYTES) {
            override fun sizeOf(key: String, value: CardArt): Int = value.byteCount
        }

        private val inFlight: MutableSet<String> = ConcurrentHashMap.newKeySet()
        private val sharedImageExecutor: Executor = Executors.newSingleThreadExecutor()

        // The cache + in-flight set are process-static; clear them between tests so
        // one test's warmed thumbnail can't turn another's expected fetch into a
        // cache hit.
        @VisibleForTesting
        internal fun resetImageStateForTest() {
            bitmapCache.evictAll()
            cardArtCache.evictAll()
            inFlight.clear()
        }
    }
}

/** What the notification header shows while driving the wall; see [BoardSessionService.resolveLighting]. */
internal sealed class LightingDisplay {
    /** A timed drive: "Driving the wall" with the header's countdown chronometer to [endMs]. */
    data class Window(val endMs: Long) : LightingDisplay()

    /** An open-ended drive: "Driving the wall", every pick lights until the climber stops, no clock. */
    object Driving : LightingDisplay()

    object Off : LightingDisplay()
}

/** The rest timer as the service holds it: LiveActivityRestTimerOptions, in Longs. */
internal data class RestTimerSnapshot(
    val status: String,
    val startMs: Long?,
    val deadlineMs: Long?,
    val periodSeconds: Long?,
    val frozenSignedSeconds: Long?,
    val caption: String?,
    /** Caption once an after-tick rest passes its deadline ("Over your rest"). */
    val overCaption: String? = null,
)

/** What the notification's rest block renders; see [BoardSessionService.resolveRestDisplay]. */
internal sealed class RestDisplay {
    /**
     * A ticking countdown to [deadlineMs]; [nextTransitionMs] is when to re-post.
     * [muted] draws it in the quiet colour (queue ended), never the over red.
     */
    data class Countdown(
        val deadlineMs: Long,
        val over: Boolean,
        val nextTransitionMs: Long?,
        val muted: Boolean = false,
    ) : RestDisplay()

    /** A ticking count-up from [startMs] (no rest length set); [muted] as above. */
    data class CountUp(val startMs: Long, val muted: Boolean = false) : RestDisplay()

    /** A static clock (paused / waiting); [text] null shows only the caption. */
    data class Frozen(val text: String?, val over: Boolean) : RestDisplay()
}
