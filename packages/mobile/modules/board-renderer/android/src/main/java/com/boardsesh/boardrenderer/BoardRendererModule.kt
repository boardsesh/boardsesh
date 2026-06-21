package com.boardsesh.boardrenderer

import android.graphics.Bitmap
import android.os.SystemClock
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer

class BoardRendererModule : Module() {
    private val cacheDir: File by lazy {
        val reactCacheDir = appContext.reactContext?.cacheDir
            ?: throw IllegalStateException("BoardRenderer: reactContext.cacheDir unavailable")
        File(reactCacheDir, "board-thumbnails").also { it.mkdirs() }
    }

    @Volatile
    private var pruned = false

    private fun pruneCacheIfNeeded(maxBytes: Long) {
        val files = cacheDir.listFiles() ?: return
        var totalBytes = files.sumOf { it.length() }
        if (totalBytes <= maxBytes) return

        // Android's File.lastModified() is our LRU proxy — atime is not
        // reliably available on the filesystems Android caches live on.
        val sorted = files.sortedBy { it.lastModified() }
        var removed = 0
        for (file in sorted) {
            if (totalBytes <= maxBytes) break
            val size = file.length()
            if (file.delete()) {
                totalBytes -= size
                removed++
            }
        }
        if (removed > 0) {
            android.util.Log.i("BoardRenderer", "Pruned $removed cached PNGs; new total $totalBytes bytes")
        }
    }

    private fun renderOverlay(configJson: String, cacheKey: String): String {
        val totalStartNanos = SystemClock.elapsedRealtimeNanos()
        if (!pruned) {
            synchronized(this@BoardRendererModule) {
                if (!pruned) {
                    pruneCacheIfNeeded(CACHE_CAP_BYTES)
                    pruned = true
                }
            }
        }
        val outputFile = File(cacheDir, "$cacheKey.png")

        if (outputFile.exists()) {
            // Touch mtime so LRU treats hot files as recently used.
            outputFile.setLastModified(System.currentTimeMillis())
            Log.i(TAG, "renderOverlay cache hit cacheKey=$cacheKey sizeBytes=${outputFile.length()}")
            return "file://${outputFile.absolutePath}"
        }

        Log.i(TAG, "renderOverlay start cacheKey=$cacheKey configLength=${configJson.length} configHash=${configJson.hashCode()}")
        val nativeStartNanos = SystemClock.elapsedRealtimeNanos()
        val renderResult = BoardRendererBridge.render(configJson)
            ?: throw Exception("Rust render failed")
        Log.i(TAG, "renderOverlay rust done cacheKey=$cacheKey durationMs=${elapsedMs(nativeStartNanos)}")

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
        val bitmapStartNanos = SystemClock.elapsedRealtimeNanos()
        val overlayBitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        Log.i(TAG, "renderOverlay bitmap allocated cacheKey=$cacheKey ${width}x${height} durationMs=${elapsedMs(bitmapStartNanos)}")
        try {
            overlayBitmap.setPremultiplied(true)
            val copyStartNanos = SystemClock.elapsedRealtimeNanos()
            overlayBitmap.copyPixelsFromBuffer(ByteBuffer.wrap(rgbaData))
            Log.i(TAG, "renderOverlay pixels copied cacheKey=$cacheKey bytes=${rgbaData.size} durationMs=${elapsedMs(copyStartNanos)}")

            val writeStartNanos = SystemClock.elapsedRealtimeNanos()
            FileOutputStream(outputFile).use { outputStream ->
                val written = overlayBitmap.compress(Bitmap.CompressFormat.PNG, 100, outputStream)
                if (!written) {
                    outputFile.delete()
                    throw Exception("PNG compression failed")
                }
            }
            Log.i(TAG, "renderOverlay png written cacheKey=$cacheKey sizeBytes=${outputFile.length()} durationMs=${elapsedMs(writeStartNanos)}")
        } finally {
            overlayBitmap.recycle()
        }

        Log.i(TAG, "renderOverlay done cacheKey=$cacheKey totalMs=${elapsedMs(totalStartNanos)}")
        return "file://${outputFile.absolutePath}"
    }

    override fun definition() = ModuleDefinition {
        Name("BoardRenderer")

        // Renders just the climb's hold overlay — a transparent-background
        // PNG containing only the hold markers. The RN component stacks
        // bundled board backgrounds underneath this overlay, so backgrounds
        // aren't passed in here anymore.
        AsyncFunction("renderHoldsOverlay") { configJson: String, cacheKey: String ->
            renderOverlay(configJson, cacheKey)
        }

        // Same renderer as renderHoldsOverlay, but the method's presence is a
        // native capability signal for marker shape, brush, and size overrides.
        AsyncFunction("renderHoldsOverlayWithMarkers") { configJson: String, cacheKey: String ->
            renderOverlay(configJson, cacheKey)
        }
    }

    private companion object {
        // Cap the on-disk PNG cache so heavy users don't accumulate hundreds
        // of MB of stale renders. The cache lives in context.cacheDir, which
        // Android may also reclaim on its own under storage pressure — this
        // is just our explicit upper bound.
        const val CACHE_CAP_BYTES: Long = 200L * 1024 * 1024
        const val TAG = "BoardRenderer"

        fun elapsedMs(startNanos: Long): Long =
            (SystemClock.elapsedRealtimeNanos() - startNanos) / 1_000_000
    }
}
