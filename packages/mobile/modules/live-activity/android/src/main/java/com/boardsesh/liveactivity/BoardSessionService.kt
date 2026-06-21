package com.boardsesh.liveactivity

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
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
import android.util.Log
import android.util.LruCache
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
 * the wall".
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

    override fun onBind(intent: Intent?): IBinder? = null

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
                contentTitleFallback = intent.getStringExtra(EXTRA_TITLE_FALLBACK) ?: contentTitleFallback
                previousLabel = intent.getStringExtra(EXTRA_PREV_LABEL) ?: previousLabel
                nextLabel = intent.getStringExtra(EXTRA_NEXT_LABEL) ?: nextLabel
                relightLabel = intent.getStringExtra(EXTRA_RELIGHT_LABEL) ?: relightLabel
                reconnectLabel = intent.getStringExtra(EXTRA_RECONNECT_LABEL) ?: reconnectLabel
                onWallTemplate = intent.getStringExtra(EXTRA_ON_WALL_TEMPLATE) ?: onWallTemplate
                boardConnection = intent.getStringExtra(EXTRA_BOARD_CONNECTION) ?: boardConnection
                holderDisplayName = intent.getStringExtra(EXTRA_HOLDER_NAME)
            }
            ACTION_UPDATE -> {
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

        // Promote on EVERY entry, including ACTION_STOP and the null-intent
        // restart: the system may hold a start token from startForegroundService()
        // and crashes with ForegroundServiceDidNotStartInTimeException if we don't
        // call startForeground() in time.
        val promoted = startInForeground()

        if (intent?.action == ACTION_STOP || !promoted) {
            foregrounded = false
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }

        foregrounded = true
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

        val bitmap = currentBitmap()
        if (bitmap != null) {
            views.setImageViewBitmap(R.id.session_image, bitmap)
        }
        return views
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
    private fun imageKey(overlay: String, backgrounds: List<String>): String =
        if (backgrounds.isEmpty()) overlay else overlay + "\u0000" + backgrounds.joinToString("\u0000")

    private fun currentBitmap(): Bitmap? =
        overlayPath?.takeIf { it.isNotBlank() }?.let { bitmapCache.get(imageKey(it, backgroundPaths)) }

    // Composites the current climb's thumbnail off the main thread (after
    // promotion), then re-posts the notification with it. Never blocks
    // startForeground(), never touches the network.
    private fun maybeComposeImage() {
        val overlay = overlayPath?.takeIf { it.isNotBlank() } ?: return
        val backgrounds = backgroundPaths
        val key = imageKey(overlay, backgrounds)
        currentImageKey = key
        if (bitmapCache.get(key) != null) return
        if (!inFlight.add(key)) return
        imageExecutor.execute {
            val bitmap = try {
                imageComposer(overlay, backgrounds)
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

        const val ACTION_START = "com.boardsesh.liveactivity.action.START"
        const val ACTION_UPDATE = "com.boardsesh.liveactivity.action.UPDATE"
        const val ACTION_STOP = "com.boardsesh.liveactivity.action.STOP"
        const val ACTION_NAV_PREVIOUS = "com.boardsesh.liveactivity.action.NAV_PREVIOUS"
        const val ACTION_NAV_NEXT = "com.boardsesh.liveactivity.action.NAV_NEXT"
        const val ACTION_BULB = "com.boardsesh.liveactivity.action.BULB"

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
