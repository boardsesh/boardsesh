// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Marco de Jongh

package com.boardsesh.boardrenderer

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
        System.loadLibrary("board_renderer_ffi")
        System.loadLibrary("board_renderer_jni")
    }

    external fun nativeRender(configJson: String): ByteArray?

    fun render(configJson: String): RenderResult? {
        val raw = nativeRender(configJson) ?: return null
        if (raw.size < 8) return null

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
        return RenderResult(pixelData, width, height)
    }
}
