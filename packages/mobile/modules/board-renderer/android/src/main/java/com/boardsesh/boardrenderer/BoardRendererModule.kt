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

    private fun renderOverlay(configJson: String, cacheKey: String): String {
        if (!pruned) {
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
                // Write to a temp file and rename into place so a thrown exception
                // mid-compress (IO interruption, storage-full, process kill) can
                // never leave a partial PNG at outputFile's path — it either lands
                // whole or not at all (see AtomicFileWrite, #3748). The temp name is
                // deterministic ("$cacheKey.png.tmp"), which is safe because Expo
                // serialises every call into this module on a single modulesQueue
                // (see #4041's PR body) — there's no concurrent renderOverlay call
                // for the same cacheKey to collide with.
                AtomicFileWrite.writeAtomically(outputFile) { tempFile ->
                    FileOutputStream(tempFile).use { outputStream ->
                        val written = overlayBitmap.compress(Bitmap.CompressFormat.PNG, 100, outputStream)
                        if (!written) {
                            throw Exception("PNG compression failed")
                        }
                    }
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
