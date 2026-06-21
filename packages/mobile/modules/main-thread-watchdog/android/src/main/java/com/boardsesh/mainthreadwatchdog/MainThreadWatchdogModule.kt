package com.boardsesh.mainthreadwatchdog

import android.os.Handler
import android.os.Looper
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * ANR-style watchdog for the Android-16 climb-list freeze. A daemon thread posts
 * a tick to the main `Looper` every [INTERVAL_MS]; if the main thread doesn't run
 * it for [THRESHOLD_MS] the UI is hung. On a hang we snapshot the main thread's
 * stack and re-sample it a few times ([SAMPLE_EVERY_MS], up to [MAX_SAMPLES]) so
 * the JS side can tell a *parked* thread (identical frames = blocked on a lock /
 * binder / layout) from a *busy* one (frames change = runaway loop). The freeze
 * ends in a force-kill, so each sample is persisted to a file immediately and
 * drained on the next launch — see `src/lib/main-thread-watchdog.ts`.
 *
 * Scoped to the foreground (start on foreground, stop on background) so Doze /
 * background throttling can't masquerade as a UI freeze.
 */
class MainThreadWatchdogModule : Module() {
  private val mainHandler = Handler(Looper.getMainLooper())
  private val fileLock = Any()

  @Volatile private var watcherThread: Thread? = null
  @Volatile private var running = false

  // Bumped on the main thread each tick; the watcher compares snapshots to tell
  // whether the main thread drained its queue within the interval.
  @Volatile private var tickCounter = 0L
  private val ticker = Runnable { tickCounter++ }

  private val reportsFile: File? by lazy {
    val dir = appContext.reactContext?.filesDir ?: return@lazy null
    File(dir, REPORTS_FILE)
  }

  private fun startWatchdog() {
    if (running) return
    running = true
    val thread = Thread({ watchLoop() }, "boardsesh-mainthread-watchdog").apply {
      isDaemon = true
    }
    watcherThread = thread
    thread.start()
  }

  private fun stopWatchdog() {
    running = false
    watcherThread?.interrupt()
    watcherThread = null
  }

  private fun watchLoop() {
    var stalledMs = 0L
    var samplesTaken = 0
    var nextSampleAtMs = THRESHOLD_MS
    while (running) {
      val before = tickCounter
      mainHandler.post(ticker)
      try {
        Thread.sleep(INTERVAL_MS)
      } catch (interrupted: InterruptedException) {
        break
      }
      val responded = tickCounter != before
      if (responded) {
        stalledMs = 0
        samplesTaken = 0
        nextSampleAtMs = THRESHOLD_MS
      } else {
        stalledMs += INTERVAL_MS
        if (stalledMs >= nextSampleAtMs && samplesTaken < MAX_SAMPLES) {
          captureStall(stalledMs, samplesTaken)
          samplesTaken++
          nextSampleAtMs = stalledMs + SAMPLE_EVERY_MS
        }
      }
    }
  }

  private fun captureStall(stalledMs: Long, sampleIndex: Int) {
    val frames: Array<StackTraceElement> = try {
      Looper.getMainLooper().thread.stackTrace
    } catch (throwable: Throwable) {
      emptyArray()
    }
    val stackText = buildString {
      for (frame in frames) append(frame.toString()).append('\n')
    }
    android.util.Log.e(TAG, "Main thread stalled ${stalledMs}ms (sample $sampleIndex). Stack:\n$stackText")
    val report = JSONObject().apply {
      put("at", System.currentTimeMillis())
      put("stalledMs", stalledMs)
      put("thresholdMs", THRESHOLD_MS)
      put("sampleIndex", sampleIndex)
      put("mainThreadStack", stackText)
    }
    appendReport(report)
  }

  private fun appendReport(report: JSONObject) {
    val file = reportsFile ?: return
    synchronized(fileLock) {
      val existing = try {
        if (file.exists()) JSONArray(file.readText()) else JSONArray()
      } catch (throwable: Throwable) {
        JSONArray()
      }
      existing.put(report)
      // Keep only the most recent reports so a long unattended freeze loop can't
      // grow the file without bound.
      val capped = if (existing.length() > MAX_STORED) {
        JSONArray().also { trimmed ->
          for (index in (existing.length() - MAX_STORED) until existing.length()) {
            trimmed.put(existing.get(index))
          }
        }
      } else {
        existing
      }
      try {
        file.writeText(capped.toString())
      } catch (throwable: Throwable) {
        // Best-effort: a failed write just means this sample is lost.
      }
    }
  }

  override fun definition() = ModuleDefinition {
    Name("MainThreadWatchdog")

    OnCreate { startWatchdog() }
    OnActivityEntersForeground { startWatchdog() }
    OnActivityEntersBackground { stopWatchdog() }
    OnDestroy { stopWatchdog() }

    Function("start") { startWatchdog() }
    Function("stop") { stopWatchdog() }
    Function("isRunning") { running }

    AsyncFunction("getPendingStallReports") {
      val file = reportsFile
      if (file == null) {
        "[]"
      } else {
        synchronized(fileLock) {
          if (file.exists()) {
            try {
              file.readText()
            } catch (throwable: Throwable) {
              "[]"
            }
          } else {
            "[]"
          }
        }
      }
    }

    AsyncFunction("clearStallReports") {
      val file = reportsFile
      if (file != null) {
        synchronized(fileLock) {
          try {
            file.delete()
          } catch (throwable: Throwable) {
            // Ignore — a stale file just gets re-reported once more.
          }
        }
      }
    }
  }

  private companion object {
    const val TAG = "MainThreadWatchdog"
    const val REPORTS_FILE = "mainthread-stalls.json"
    // 1s tick. A real Android ANR is 5s, so THRESHOLD_MS=5s keeps us out of the
    // jank/GC noise band and only fires on a genuine hang.
    const val INTERVAL_MS = 1000L
    const val THRESHOLD_MS = 5000L
    // Re-sample every 3s while still hung to expose whether the stack is moving.
    const val SAMPLE_EVERY_MS = 3000L
    const val MAX_SAMPLES = 4
    const val MAX_STORED = 30
  }
}
