package com.boardsesh.boardrenderer

import java.nio.ByteBuffer
import org.junit.Assert.*
import org.junit.Test

class OwnedAtlasBufferTest {
    @Test
    fun closesExactlyOnceAfterUploadFailure() {
        var releases = 0
        val payload = ByteBuffer.allocateDirect(16)
        val owner =
            OwnedAtlasBuffer(payload) { released ->
                assertSame(payload, released)
                releases++
            }
        try {
            owner.use { it.useBuffer<Unit> { throw IllegalStateException("upload failed") } }
        } catch (_: IllegalStateException) {}
        owner.close()
        assertEquals(1, releases)
        assertThrows(IllegalStateException::class.java) { owner.useBuffer {} }
    }

    @Test
    fun doesNotCopyNativeAllocation() {
        val payload = ByteBuffer.allocateDirect(16)
        OwnedAtlasBuffer(payload) {}
            .use { owner ->
                owner.useBuffer { assertSame(payload, it) }
            }
    }
}
