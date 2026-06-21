package com.boardsesh.boardrenderer

import android.os.Build
import android.os.SystemClock
import android.util.Log

data class RenderResult(
    val data: ByteArray,
    val width: Int,
    val height: Int
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is RenderResult) return false
        return data.contentEquals(other.data) && width == other.width && height == other.height
    }

    override fun hashCode(): Int {
        var result = data.contentHashCode()
        result = 31 * result + width
        result = 31 * result + height
        return result
    }
}

object BoardRendererBridge {
    init {
        val startNanos = SystemClock.elapsedRealtimeNanos()
        try {
            Log.i(TAG, "Loading board renderer native libs; supportedAbis=${Build.SUPPORTED_ABIS.joinToString(",")}")
            System.loadLibrary("board_renderer_ffi")
            Log.i(TAG, "Loaded board_renderer_ffi in ${elapsedMs(startNanos)}ms")
            System.loadLibrary("board_renderer_jni")
            Log.i(TAG, "Loaded board_renderer_jni in ${elapsedMs(startNanos)}ms")
        } catch (throwable: Throwable) {
            Log.e(TAG, "Failed loading board renderer native libs after ${elapsedMs(startNanos)}ms", throwable)
            throw throwable
        }
    }

    external fun nativeRender(configJson: String): ByteArray?

    fun render(configJson: String): RenderResult? {
        val startNanos = SystemClock.elapsedRealtimeNanos()
        Log.i(TAG, "nativeRender start configLength=${configJson.length} configHash=${configJson.hashCode()}")
        val raw = nativeRender(configJson)
        if (raw == null) {
            Log.e(TAG, "nativeRender returned null durationMs=${elapsedMs(startNanos)}")
            return null
        }
        if (raw.size < 8) {
            Log.e(TAG, "nativeRender returned short payload bytes=${raw.size} durationMs=${elapsedMs(startNanos)}")
            return null
        }

        // First 8 bytes: width (u32 LE) + height (u32 LE)
        val width = (raw[0].toInt() and 0xFF) or
                ((raw[1].toInt() and 0xFF) shl 8) or
                ((raw[2].toInt() and 0xFF) shl 16) or
                ((raw[3].toInt() and 0xFF) shl 24)
        val height = (raw[4].toInt() and 0xFF) or
                ((raw[5].toInt() and 0xFF) shl 8) or
                ((raw[6].toInt() and 0xFF) shl 16) or
                ((raw[7].toInt() and 0xFF) shl 24)

        val pixelData = raw.copyOfRange(8, raw.size)
        Log.i(TAG, "nativeRender done ${width}x${height} bytes=${raw.size} durationMs=${elapsedMs(startNanos)}")
        return RenderResult(pixelData, width, height)
    }

    private fun elapsedMs(startNanos: Long): Long =
        (SystemClock.elapsedRealtimeNanos() - startNanos) / 1_000_000

    private const val TAG = "BoardRenderer"
}
