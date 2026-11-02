package com.boardsesh.liveactivity

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONException
import org.json.JSONObject

/**
 * This phone's drive (2.7: off, Put on board's timed drive, or an open-ended
 * drive), as the notification and JS share it:
 * LiveActivityLightingWindowSnapshot in modules/live-activity/src/index.ts, and
 * the iOS `SharedLightingWindowState`.
 *
 * One writer: JS (`source == "app"`), on every change of its drive. A
 * notification Previous / Next writes nothing here: JS lights the wall for it,
 * so JS starts or renews the timed drive at the wall's lit confirm, the way a climb
 * lit in the app does (`armNotificationPressDrive` in lock-screen-lighting.ts).
 * iOS also has a native writer, its lock-screen intent, which lights the wall
 * without JS.
 */
internal data class LightingWindowSnapshot(
    val sessionId: String,
    /** [LightingWindowStore.MODE_OFF], [LightingWindowStore.MODE_WINDOW] or [LightingWindowStore.MODE_DRIVING]. */
    val mode: String,
    /** Epoch ms the timed drive ends; null outside one. */
    val endsAtMs: Long?,
    /** The timed drive's length; null outside one. */
    val windowSeconds: Double?,
    /** Which choice opened it ("general" / "moonboard"), null when unknown. */
    val family: String?,
    val source: String,
    val updatedAtMs: Long,
) {
    /** Same picture on the notification: everything but who wrote it and when. */
    fun drawsLike(other: LightingWindowSnapshot?): Boolean =
        other != null && sessionId == other.sessionId && mode == other.mode &&
            endsAtMs == other.endsAtMs && windowSeconds == other.windowSeconds

    /** What `getLightingWindow` hands JS. */
    fun toBridgeMap(): Map<String, Any?> = mapOf(
        "sessionId" to sessionId,
        "mode" to mode,
        "endsAtMs" to endsAtMs?.toDouble(),
        "windowSeconds" to windowSeconds,
        "family" to family,
        "source" to source,
        "updatedAtMs" to updatedAtMs.toDouble(),
    )
}

internal object LightingWindowStore {
    private const val PREFS_NAME = "boardsesh_lighting_window"
    private const val KEY_WINDOW = "window"
    private const val VERSION = 1

    const val MODE_OFF = "off"
    const val MODE_WINDOW = "window"
    const val MODE_DRIVING = "driving"
    private val MODES = setOf(MODE_OFF, MODE_WINDOW, MODE_DRIVING)

    const val SOURCE_APP = "app"

    /** Bounds shared with the iOS rest timer and lighting window: a day, and 2000–2100. */
    private const val MAX_SECONDS = 86_400.0
    private const val MIN_EPOCH_MS = 946_684_800_000L
    private const val MAX_EPOCH_MS = 4_102_444_800_000L

    private fun prefs(context: Context): SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun loadWindow(context: Context): LightingWindowSnapshot? = parseWindow(prefs(context).getString(KEY_WINDOW, null))

    /** Stores the snapshot, or clears the key when it is out of bounds. Returns whether it was stored. */
    fun saveWindow(context: Context, snapshot: LightingWindowSnapshot): Boolean {
        if (!isWithinBounds(snapshot)) {
            clearWindow(context)
            return false
        }
        prefs(context).edit().putString(KEY_WINDOW, encodeWindow(snapshot)).apply()
        return true
    }

    /** Removes the snapshot. Returns whether there was one. */
    fun clearWindow(context: Context): Boolean {
        val store = prefs(context)
        val existed = store.contains(KEY_WINDOW)
        store.edit().remove(KEY_WINDOW).apply()
        return existed
    }

    fun isWithinBounds(snapshot: LightingWindowSnapshot): Boolean {
        val secondsOk = snapshot.windowSeconds?.let { it.isFinite() && it > 0 && it <= MAX_SECONDS } ?: true
        val millis = listOfNotNull(snapshot.endsAtMs, snapshot.updatedAtMs)
        return secondsOk && snapshot.mode in MODES && millis.all { it in MIN_EPOCH_MS..MAX_EPOCH_MS }
    }

    // --- JSON ---

    fun encodeWindow(snapshot: LightingWindowSnapshot): String = JSONObject().apply {
        put("v", VERSION)
        put("sessionId", snapshot.sessionId)
        put("mode", snapshot.mode)
        put("endsAtMs", snapshot.endsAtMs ?: JSONObject.NULL)
        put("windowSeconds", snapshot.windowSeconds ?: JSONObject.NULL)
        put("family", snapshot.family ?: JSONObject.NULL)
        put("source", snapshot.source)
        put("updatedAtMs", snapshot.updatedAtMs)
    }.toString()

    /** Null for absent or unreadable JSON, an unknown version, or a snapshot out of bounds. */
    fun parseWindow(json: String?): LightingWindowSnapshot? {
        if (json == null) return null
        return try {
            val obj = JSONObject(json)
            if (obj.optInt("v", -1) != VERSION) return null
            val sessionId = obj.optString("sessionId").takeIf { it.isNotEmpty() } ?: return null
            val snapshot = LightingWindowSnapshot(
                sessionId = sessionId,
                mode = obj.getString("mode"),
                endsAtMs = if (obj.isNull("endsAtMs")) null else obj.getLong("endsAtMs"),
                windowSeconds = if (obj.isNull("windowSeconds")) null else obj.getDouble("windowSeconds"),
                family = if (obj.isNull("family")) null else obj.getString("family"),
                source = obj.getString("source"),
                updatedAtMs = obj.getLong("updatedAtMs"),
            )
            snapshot.takeIf { isWithinBounds(it) }
        } catch (error: JSONException) {
            null
        }
    }
}
