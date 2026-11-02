package com.boardsesh.liveactivity

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONException
import org.json.JSONObject

/**
 * This phone's keep-lighting window (2.7), as the notification, the action
 * receiver and JS share it: LiveActivityLightingWindowSnapshot in
 * modules/live-activity/src/index.ts, and the iOS `SharedLightingWindowState`.
 *
 * Two writers: JS (`source == "app"`) on every change of its drive, and a
 * notification Previous / Next (`source == "lockScreen"`), which opens or
 * renews the window before the press reaches JS. JS adopts a lock-screen write
 * once, by its [updatedAtMs].
 */
internal data class LightingWindowSnapshot(
    val sessionId: String,
    /** [LightingWindowStore.MODE_OFF], [LightingWindowStore.MODE_WINDOW] or [LightingWindowStore.MODE_DRIVING]. */
    val mode: String,
    /** Epoch ms the window ends; null outside a window. */
    val endsAtMs: Long?,
    /** The window's length, so a press renews it by its own length; null outside a window. */
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

/**
 * Settings › Board's keep-lighting choices as JS mirrors them
 * (LiveActivityKeepLightingConfig): the inputs `resolveKeepLightingPlan` in
 * src/lib/keep-lighting.ts reads.
 */
internal data class KeepLightingConfig(
    /** The general `KeepLightingChoice` ("off", "30", "45", "60", "until_stopped"). */
    val keepLighting: String,
    /** The MoonBoard choice; it applies in a crew too. */
    val moonboardKeepLighting: String,
    /** "In a session too". */
    val drivesInSession: Boolean,
    /** A crew is in the session. */
    val inCrew: Boolean,
    /** The session's board is a MoonBoard. */
    val moonboard: Boolean,
    /** False where a press would not keep lighting in the app either. */
    val enabled: Boolean,
)

/** What a press keeps lighting once its climb is up. */
internal sealed class KeepLightingPlan {
    data class Window(val seconds: Double, val family: String) : KeepLightingPlan()
    data class Driving(val family: String) : KeepLightingPlan()
}

internal object LightingWindowStore {
    private const val PREFS_NAME = "boardsesh_lighting_window"
    private const val KEY_WINDOW = "window"
    private const val KEY_CONFIG = "config"
    private const val VERSION = 1

    const val MODE_OFF = "off"
    const val MODE_WINDOW = "window"
    const val MODE_DRIVING = "driving"
    private val MODES = setOf(MODE_OFF, MODE_WINDOW, MODE_DRIVING)

    const val SOURCE_APP = "app"
    const val SOURCE_LOCK_SCREEN = "lockScreen"

    const val FAMILY_GENERAL = "general"
    const val FAMILY_MOONBOARD = "moonboard"

    private const val UNTIL_STOPPED = "until_stopped"

    /** The longest window a choice may ask for. The app offers 60 s; a newer bundle's longer one still works. */
    private const val MAX_WINDOW_SECONDS = 3_600.0

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

    fun loadConfig(context: Context): KeepLightingConfig? = parseConfig(prefs(context).getString(KEY_CONFIG, null))

    fun saveConfig(context: Context, config: KeepLightingConfig) {
        prefs(context).edit().putString(KEY_CONFIG, encodeConfig(config)).apply()
    }

    fun clearConfig(context: Context) {
        prefs(context).edit().remove(KEY_CONFIG).apply()
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

    fun encodeConfig(config: KeepLightingConfig): String = JSONObject().apply {
        put("v", VERSION)
        put("keepLighting", config.keepLighting)
        put("moonboardKeepLighting", config.moonboardKeepLighting)
        put("drivesInSession", config.drivesInSession)
        put("inCrew", config.inCrew)
        put("moonboard", config.moonboard)
        put("enabled", config.enabled)
    }.toString()

    fun parseConfig(json: String?): KeepLightingConfig? {
        if (json == null) return null
        return try {
            val obj = JSONObject(json)
            if (obj.optInt("v", -1) != VERSION) return null
            KeepLightingConfig(
                keepLighting = obj.getString("keepLighting"),
                moonboardKeepLighting = obj.getString("moonboardKeepLighting"),
                drivesInSession = obj.getBoolean("drivesInSession"),
                inCrew = obj.getBoolean("inCrew"),
                moonboard = obj.getBoolean("moonboard"),
                enabled = obj.getBoolean("enabled"),
            )
        } catch (error: JSONException) {
            null
        }
    }

    // --- The press ---

    /** One choice's plan: Until I stop drives, a number of seconds opens a window, Off (or garbage) lights one climb. */
    fun planForChoice(choice: String, family: String): KeepLightingPlan? {
        if (choice == UNTIL_STOPPED) return KeepLightingPlan.Driving(family)
        val seconds = choice.toDoubleOrNull()?.takeIf { it.isFinite() && it > 0 && it <= MAX_WINDOW_SECONDS } ?: return null
        return KeepLightingPlan.Window(seconds, family)
    }

    /**
     * The plan for a press, as `resolveKeepLightingPlan` reads it: a MoonBoard
     * takes its own choice, in a crew too; every other board the general one,
     * and with a crew only while "In a session too" is on.
     */
    fun plan(config: KeepLightingConfig?): KeepLightingPlan? {
        if (config == null || !config.enabled) return null
        if (config.moonboard) return planForChoice(config.moonboardKeepLighting, FAMILY_MOONBOARD)
        if (config.inCrew && !config.drivesInSession) return null
        return planForChoice(config.keepLighting, FAMILY_GENERAL)
    }

    /**
     * What a notification Previous / Next leaves, or null when it changes
     * nothing: a drive goes on, an open window is renewed by its own length,
     * and otherwise the settings decide. Mirrors `SharedLightingWindowRuntime`.
     */
    fun afterPress(
        current: LightingWindowSnapshot?,
        config: KeepLightingConfig?,
        sessionId: String,
        nowMs: Long,
    ): LightingWindowSnapshot? {
        if (current != null && current.sessionId == sessionId && isWithinBounds(current)) {
            if (current.mode == MODE_DRIVING) return null
            val seconds = current.windowSeconds
            val endsAtMs = current.endsAtMs
            if (current.mode == MODE_WINDOW && endsAtMs != null && endsAtMs > nowMs && seconds != null && seconds > 0) {
                return window(sessionId, seconds, current.family, nowMs)
            }
        }
        return when (val plan = plan(config)) {
            null -> null
            is KeepLightingPlan.Window -> window(sessionId, plan.seconds, plan.family, nowMs)
            is KeepLightingPlan.Driving -> LightingWindowSnapshot(
                sessionId = sessionId,
                mode = MODE_DRIVING,
                endsAtMs = null,
                windowSeconds = null,
                family = plan.family,
                source = SOURCE_LOCK_SCREEN,
                updatedAtMs = nowMs,
            )
        }
    }

    /** Opens or renews the window for a press on [sessionId]'s notification and stores it. */
    fun recordPress(context: Context, sessionId: String, nowMs: Long): LightingWindowSnapshot? {
        if (sessionId.isEmpty()) return null
        val next = afterPress(loadWindow(context), loadConfig(context), sessionId, nowMs) ?: return null
        return next.takeIf { saveWindow(context, it) }
    }

    private fun window(sessionId: String, seconds: Double, family: String?, nowMs: Long) = LightingWindowSnapshot(
        sessionId = sessionId,
        mode = MODE_WINDOW,
        endsAtMs = nowMs + (seconds * 1000).toLong(),
        windowSeconds = seconds,
        family = family,
        source = SOURCE_LOCK_SCREEN,
        updatedAtMs = nowMs,
    )
}
