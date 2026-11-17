package com.boardsesh.boardrenderer

import java.io.Closeable
import java.nio.ByteBuffer

/** Owns one Rust allocation. Native also verifies ownership before freeing. */
class OwnedAtlasBuffer
internal constructor(
    private val buffer: ByteBuffer,
    private val release: (ByteBuffer) -> Unit,
) : Closeable {
    private var closed = false

    @Synchronized
    fun <T> useBuffer(block: (ByteBuffer) -> T): T {
        check(!closed) { "Atlas allocation already released" }
        return block(buffer)
    }

    @Synchronized
    override fun close() {
        if (closed) return
        closed = true
        release(buffer)
    }
}

/** Manifest and pixels never share an allocation or a payload-sized copy. */
class OwnedAtlasBuffers internal constructor(
    private val manifest: OwnedAtlasBuffer,
    private val pixels: OwnedAtlasBuffer,
) : Closeable {
    fun <T> useBuffers(block: (ByteBuffer, ByteBuffer) -> T): T =
        manifest.useBuffer { manifestBytes ->
            pixels.useBuffer { pixelBytes -> block(manifestBytes, pixelBytes) }
        }

    override fun close() {
        try { manifest.close() } finally { pixels.close() }
    }
}
