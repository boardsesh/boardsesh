package com.boardsesh.boardrenderer

import android.graphics.Bitmap
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.nio.ByteBuffer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel

class BoardRendererModule : Module() {
    /**
     * Renders run on this scope, not on expo-modules-core's default
     * `AsyncFunction` queue. That default is ONE `HandlerThread` shared by every
     * Expo module (`expo.modules.AsyncFunctionQueue`), so a play-board render
     * used to wait behind every list thumbnail already in line and behind any
     * other module's pending call; a throttled CPU stretched that line to
     * seconds (issue #5187). `Dispatchers.Default` is the CPU-bound pool, which
     * is what a raster + PNG encode is. The JS render scheduler bounds how many
     * renders it sends at once (`renderConcurrency`), so this never means "every
     * mounted row at once". Cancelled with the module so a torn-down React
     * context does not keep rendering into a dead cache dir.
     */
    private val renderScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    private val cacheDir: File by lazy {
        val reactCacheDir = appContext.reactContext?.cacheDir
            ?: throw IllegalStateException("BoardRenderer: reactContext.cacheDir unavailable")
        File(reactCacheDir, "board-thumbnails").also { it.mkdirs() }
    }

    @Volatile
    private var pruned = false

    private fun ensurePruned() {
        if (pruned) return
        synchronized(this@BoardRendererModule) {
            if (!pruned) {
                val result = CachePruner.pruneCacheIfNeeded(cacheDir, CACHE_CAP_BYTES)
                if (result.orphanedTempFilesRemoved > 0) {
                    android.util.Log.i(
                        "BoardRenderer",
                        "Swept ${result.orphanedTempFilesRemoved} orphaned temp file(s) from a prior crash",
                    )
                }
                if (result.cacheEntriesEvicted > 0) {
                    android.util.Log.i(
                        "BoardRenderer",
                        "Pruned ${result.cacheEntriesEvicted} cached PNGs; new total ${result.finalTotalBytes} bytes",
                    )
                }
                pruned = true
            }
        }
    }

    /**
     * #4107: [CacheDirRecovery] already retries the write once if the cache
     * directory vanishes mid-request, but under sustained storage pressure
     * that single retry can lose too — the recreated directory (or a fresh
     * temp file inside it) can vanish again before the retried write lands,
     * and that second [java.io.FileNotFoundException] was previously
     * unguarded, reaching JS as a rejected `renderHoldsOverlay` promise.
     * This wraps the *entire* pipeline — fast-path check, render, and write
     * — in one more bounded retry: on a vanished-cache failure, treat the
     * cache entry as invalidated and re-run the whole thing exactly once
     * from scratch. See [CacheMissRecovery] for the classification — a
     * `FileNotFoundException`, or a plain `IOException` caught while the
     * cache directory is missing (how `File.createTempFile` and the wrapped
     * `Os.rename` ENOENT actually surface a second vanish) — and for why a
     * dir-present `IOException` (out-of-space, permissions) stays
     * non-retryable, narrower than [CacheDirRecovery]'s own `IOException`
     * contract.
     */
    private fun renderOverlay(configJson: String, cacheKey: String): String {
        ensurePruned()
        return CacheMissRecovery.retryOnceOnCacheVanish(
            isCacheDirMissing = { !cacheDir.isDirectory },
            onRecovered = { failure, cacheDirMissing ->
                // Log what was actually observed: the gate checked the
                // directory at catch time, so "dir was missing" is a
                // verified fact here, not an assumption.
                val observedCause = if (cacheDirMissing) {
                    "cache dir ${cacheDir.absolutePath} was missing at failure time"
                } else {
                    "cache file path vanished with the dir still in place"
                }
                android.util.Log.w(
                    "BoardRenderer",
                    "Overlay render failed for $cacheKey ($observedCause); invalidating and re-rendering once",
                    failure,
                )
            },
        ) {
            renderOverlayOnce(configJson, cacheKey)
        }
    }

    private fun renderOverlayOnce(configJson: String, cacheKey: String): String {
        val outputFile = File(cacheDir, "$cacheKey.png")

        if (outputFile.exists()) {
            if (outputFile.length() > 0) {
                // Touch mtime so LRU treats hot files as recently used.
                outputFile.setLastModified(System.currentTimeMillis())
                return "file://${outputFile.absolutePath}"
            }
            // A zero-byte leftover — a partial write from before this fix shipped
            // (new writes can no longer land partially; see AtomicFileWrite) — is
            // never a valid cache hit. Delete it and fall through to render.
            outputFile.delete()
        }

        val renderResult = BoardRendererBridge.render(configJson)
            ?: throw Exception("Rust render failed")

        val width = renderResult.width
        val height = renderResult.height
        val rgbaData = renderResult.data

        // tiny-skia returns premultiplied RGBA, and ARGB_8888 bitmaps
        // default to premultiplied storage in the same byte layout, so
        // copyPixelsFromBuffer hands the buffer to the bitmap with no
        // per-pixel JVM loop. setPremultiplied is true by default but
        // we set it explicitly so future changes can't accidentally
        // flip it. Recycled in finally so a throw between create and
        // compress can't leak native pixel memory.
        val overlayBitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        try {
            overlayBitmap.setPremultiplied(true)
            overlayBitmap.copyPixelsFromBuffer(ByteBuffer.wrap(rgbaData))

            // Android can reclaim context.cacheDir mid-session, which deletes
            // the directory out from under us and makes every later write fail
            // with FileNotFoundException. Re-create it and try once more.
            CacheDirRecovery.retryOnceAfterRecreating(
                cacheDir,
                onRecovered = { writeFailure ->
                    // Not claiming the directory *had* vanished: any IOException
                    // lands here, so an out-of-space failure with the directory
                    // in place the whole time gets one retry and this line too.
                    android.util.Log.w(
                        "BoardRenderer",
                        "Overlay write failed; cache dir ${cacheDir.absolutePath} is in place, retrying once",
                        writeFailure
                    )
                },
            ) {
                // Fresh same-directory temp creation, compression, stream close,
                // and the atomic Os.rename publication all live inside this retry
                // boundary. A reclaimed cache directory therefore retries the
                // entire pipeline with a new unique temp file, while concurrent
                // renders never share an in-flight path (see AtomicFileWrite).
                AtomicFileWrite.writeAtomically(
                    destination = outputFile,
                    committer = AndroidAtomicFileCommitter,
                ) { outputStream ->
                    overlayBitmap.compress(Bitmap.CompressFormat.PNG, 100, outputStream)
                }
            }
        } finally {
            overlayBitmap.recycle()
        }

        return "file://${outputFile.absolutePath}"
    }

    override fun definition() = ModuleDefinition {
        Name("BoardRenderer")

        // Read by the JS render scheduler (`getNativeRenderConcurrency`) to size
        // its dispatch window. Absent on binaries that still render on the shared
        // serial queue, where the scheduler keeps its one-at-a-time default.
        Constants(
            "renderConcurrency" to RENDER_CONCURRENCY,
        )

        OnDestroy {
            renderScope.cancel()
        }

        // Renders just the climb's hold overlay — a transparent-background
        // PNG containing only the hold markers. The RN component stacks
        // bundled board backgrounds underneath this overlay, so backgrounds
        // aren't passed in here anymore.
        AsyncFunction("renderHoldsOverlay") { configJson: String, cacheKey: String ->
            renderOverlay(configJson, cacheKey)
        }.runOnQueue(renderScope)

        // Same renderer as renderHoldsOverlay, but the method's presence is a
        // native capability signal for marker shape, brush, and size overrides.
        AsyncFunction("renderHoldsOverlayWithMarkers") { configJson: String, cacheKey: String ->
            renderOverlay(configJson, cacheKey)
        }.runOnQueue(renderScope)
    }

    private companion object {
        /**
         * How many renders the JS scheduler may keep inside this module at once.
         * Two: the current play board plus one neighbour or thumbnail. Matches
         * the iOS module.
         */
        const val RENDER_CONCURRENCY = 2

        // Cap the on-disk PNG cache so heavy users don't accumulate hundreds
        // of MB of stale renders. The cache lives in context.cacheDir, which
        // Android may also reclaim on its own under storage pressure — this
        // is just our explicit upper bound.
        const val CACHE_CAP_BYTES: Long = 200L * 1024 * 1024
    }
}
