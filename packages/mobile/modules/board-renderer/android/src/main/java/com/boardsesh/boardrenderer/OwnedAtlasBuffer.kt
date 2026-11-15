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
