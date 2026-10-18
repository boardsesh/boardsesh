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
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.text.format.DateUtils
import android.util.Log
import android.util.LruCache
import android.view.View
import android.widget.RemoteViews
import androidx.annotation.VisibleForTesting
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
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
    private var onWallTemplate: String = "{{name}} is on the wall"

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

    // On-device climb thumbnail (the app's no-network board-art rule): the
    // BoardRenderer holds-only PNG and the bundled board background layers under it,
    // composited locally — never a backend fetch.
    private var overlayPath: String? = null
    private var backgroundPaths: List<String> = emptyList()

    // The rest countdown (null = hidden). Epoch-ms from JS; converted to the
    // Chronometer's elapsedRealtime timebase at build time.
    private var restTimer: RestTimerSnapshot? = null

    // The overlay path whose composited bitmap is currently displayed; the async
    // compose only applies its result if this still matches (stale guard).
    @Volatile
    private var currentImageKey: String? = null

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
    internal var imageComposer: (String, List<String>) -> Bitmap? = { overlay, backgrounds ->
        composeThumbnail(overlay, backgrounds)
    }

    // Clock + scheduling seams for the rest countdown, so a test can pin "now" and
    // capture the deadline re-post instead of waiting on the main looper.
    internal var wallClockMs: () -> Long = { System.currentTimeMillis() }
    internal var elapsedRealtimeMs: () -> Long = { SystemClock.elapsedRealtime() }
    internal var scheduleOnMain: (Runnable, Long) -> Unit = { task, delayMs -> mainHandler.postDelayed(task, delayMs) }
    internal var cancelOnMain: (Runnable) -> Unit = { mainHandler.removeCallbacks(it) }

    // Re-posts the notification when the rest crosses its deadline: an after-tick
    // rest turns "over" (red), an on-the-minute beat rolls to the next one. The
    // Chronometer itself keeps ticking between re-posts; this only refreshes what
    // a Chronometer can't change on its own (colour, the next beat's base).
    private val restTransition = Runnable { onRestTransition() }

    // The re-post above runs on the main Handler, whose clock is uptime: it stops
    // while the phone is in deep sleep. The Chronometer's base is elapsedRealtime,
    // which keeps counting through sleep. A rest that ends while the screen is off
    // would otherwise show negative digits under its old caption and colour (or a
    // fixed window running negative under "Every 1:00") until the leftover
    // awake-time delay ran out. So re-render the moment the climber can see the
    // notification again; the re-post also re-arms the next transition from now.
    // SCREEN_ON / USER_PRESENT are protected system broadcasts: no other app can
    // send them, so registering without the export flag below API 33 is safe.
    private val screenOnReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (restTimer != null) onRestTransition()
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
                onWallTemplate = intent.getStringExtra(EXTRA_ON_WALL_TEMPLATE) ?: onWallTemplate
                boardConnection = intent.getStringExtra(EXTRA_BOARD_CONNECTION) ?: boardConnection
                holderDisplayName = intent.getStringExtra(EXTRA_HOLDER_NAME)
                // A new session window starts without a countdown; JS sends the
                // current rest state right after every start.
                restTimer = null
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
                    // Absent overlay ⇒ render not ready yet; keep the last one so the
                    // thumbnail doesn't flicker out between updates.
                    intent.getStringExtra(EXTRA_OVERLAY_PATH)?.let { overlayPath = it }
                    intent.getStringArrayListExtra(EXTRA_BACKGROUND_PATHS)?.let { backgroundPaths = it }
                }
            }
        }

        // Promote on EVERY entry, including ACTION_STOP and the null-intent
        // restart: the system may hold a start token from startForegroundService()
        // and crashes with ForegroundServiceDidNotStartInTimeException if we don't
        // call startForeground() in time.
        val promoted = startInForeground()

        if (intent?.action == ACTION_STOP || !promoted) {
            foregrounded = false
            cancelOnMain(restTransition)
            unregisterScreenOnReceiver()
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }

        foregrounded = true
        registerScreenOnReceiver()
        scheduleRestTransition()
        // Image compositing never runs before promotion: the notification was
        // already built (with the cached bitmap or a placeholder) and posted above.
        maybeComposeImage()

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
        if (tryStartForeground(notification, type)) return true
        // On API < 34 a typeless FGS is a valid promotion, so retry to satisfy the
        // contract. On API 34+ type 0 throws MissingForegroundServiceTypeException
        // for a typed service, so the caller gates the start on BLUETOOTH_CONNECT.
        if (type != 0 && Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE &&
            tryStartForeground(notification, 0)
        ) {
            return true
        }
        return false
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

    private fun buildNotification(): Notification {
        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_boardsesh_notification)
            .setStyle(NotificationCompat.DecoratedCustomViewStyle())
            .setCustomContentView(buildContentView(R.layout.notification_session_collapsed))
            .setCustomBigContentView(buildContentView(R.layout.notification_session_expanded))
            .setColor(ContextCompat.getColor(this, R.color.session_accent))
            .setOngoing(true)
            .setSilent(true)
            // DEFAULT-importance channel: alert once on first post so re-posting on
            // every climb/connection update doesn't re-peek the ongoing card.
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
            .setContentIntent(launchAppIntent())

        // Controls follow ownership: only the driver (connectedByMe) gets
        // Previous/Next; everyone else gets just the outline bulb to (re)connect.
        if (boardConnection == CONNECTION_CONNECTED_BY_ME) {
            if (hasPrevious) {
                builder.addAction(R.drawable.ic_skip_previous, previousLabel, actionPendingIntent(ACTION_NAV_PREVIOUS, REQ_PREVIOUS))
            }
            builder.addAction(R.drawable.ic_lightbulb_filled, relightLabel, bulbPendingIntent())
            if (hasNext) {
                builder.addAction(R.drawable.ic_skip_next, nextLabel, actionPendingIntent(ACTION_NAV_NEXT, REQ_NEXT))
            }
        } else {
            builder.addAction(R.drawable.ic_lightbulb_outline, reconnectLabel, bulbPendingIntent())
        }
        return builder.build()
    }

    // internal so a test can inflate the result and assert the rendered holder line
    // without going through the DecoratedCustomViewStyle framework wrapper.
    @VisibleForTesting
    internal fun buildContentView(layoutId: Int): RemoteViews {
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

        val showMirror = supportsMirroring && sessionId.isNotEmpty() && queueItemUuid.isNotEmpty() &&
            boardConnection == CONNECTION_CONNECTED_BY_ME
        views.setViewVisibility(R.id.session_mirror, if (showMirror) android.view.View.VISIBLE else android.view.View.GONE)
        views.setContentDescription(R.id.session_mirror, if (mirrored) unmirrorLabel else mirrorLabel)
        views.setInt(R.id.session_mirror, "setImageAlpha", if (mirrored) 255 else 140)
        if (showMirror) views.setOnClickPendingIntent(R.id.session_mirror, mirrorPendingIntent())
        val bitmap = currentBitmap()
        if (bitmap != null) {
            views.setImageViewBitmap(R.id.session_image, bitmap)
        }
        bindRestTimer(views)
        return views
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
        try {
            getSystemService(NotificationManager::class.java)?.notify(NOTIFICATION_ID, buildNotification())
        } catch (error: Exception) {
            Log.w(TAG, "rest transition re-post failed: ${error.message}")
        }
        scheduleRestTransition()
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

    private fun bulbPendingIntent(): PendingIntent {
        val intent = Intent(this, BoardSessionActionReceiver::class.java).apply {
            action = ACTION_BULB
            putExtra(EXTRA_BOARD_CONNECTION, boardConnection)
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

    private fun currentBitmap(): Bitmap? =
        overlayPath?.takeIf { it.isNotBlank() }?.let { bitmapCache.get(imageKey(it, backgroundPaths, mirrored)) }

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
            val bitmap = try {
                imageComposer(overlay, backgrounds)?.let { orientThumbnail(it, imageMirrored) }
            } catch (error: Throwable) {
                // Throwable, not Exception: decoding/compositing large board PNGs can
                // OutOfMemoryError on low-memory devices, which is an Error — catching
                // only Exception would let it kill this background thread noisily.
                // Degrade to no thumbnail (the notification still posts without art).
                Log.w(TAG, "thumbnail compose failed: ${error.message}")
                null
            } finally {
                inFlight.remove(key)
            }
            if (bitmap == null) return@execute
            bitmapCache.put(key, bitmap)
            postToMain {
                // Stale guard: the climb may have moved on (or the session ended)
                // while the compose was in flight.
                if (currentImageKey != key || !foregrounded) return@postToMain
                try {
                    getSystemService(NotificationManager::class.java)?.notify(NOTIFICATION_ID, buildNotification())
                } catch (error: Exception) {
                    Log.w(TAG, "thumbnail re-post failed: ${error.message}")
                }
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

    private fun decodeLocalFile(path: String): Bitmap? {
        val fsPath = if (path.startsWith("file://")) path.removePrefix("file://") else path
        return BitmapFactory.decodeFile(fsPath)
    }

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
        private val inFlight: MutableSet<String> = ConcurrentHashMap.newKeySet()
        private val sharedImageExecutor: Executor = Executors.newSingleThreadExecutor()

        // The cache + in-flight set are process-static; clear them between tests so
        // one test's warmed thumbnail can't turn another's expected fetch into a
        // cache hit.
        @VisibleForTesting
        internal fun resetImageStateForTest() {
            bitmapCache.evictAll()
            inFlight.clear()
        }
    }
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
