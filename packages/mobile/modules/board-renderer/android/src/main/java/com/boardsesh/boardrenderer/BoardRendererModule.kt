package com.boardsesh.boardrenderer

import android.graphics.Bitmap
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
            return "file://${outputFile.absolutePath}"
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

            FileOutputStream(outputFile).use { outputStream ->
                val written = overlayBitmap.compress(Bitmap.CompressFormat.PNG, 100, outputStream)
                if (!written) {
                    outputFile.delete()
                    throw Exception("PNG compression failed")
                }
            }
        } finally {
            overlayBitmap.recycle()
        }

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
    }
}
