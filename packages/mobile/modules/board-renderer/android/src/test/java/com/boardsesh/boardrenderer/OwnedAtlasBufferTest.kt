package com.boardsesh.boardrenderer

import java.nio.ByteBuffer
import org.junit.Assert.*
import org.junit.Test

class OwnedAtlasBufferTest {
    @Test
    fun independentAllocationsReleaseBothAfterCancelledPreparation() {
        val manifest = ByteBuffer.allocateDirect(8)
        val pixels = ByteBuffer.allocateDirect(16)
        val released = ArrayList<ByteBuffer>()
        val owner = OwnedAtlasBuffers(
            OwnedAtlasBuffer(manifest) { released.add(it) },
            OwnedAtlasBuffer(pixels) { released.add(it) },
        )
        assertThrows(IllegalStateException::class.java) {
            owner.use {
                it.useBuffers<Unit> { header, storage ->
                    assertSame(manifest, header)
                    assertSame(pixels, storage)
                    throw IllegalStateException("request cancelled")
                }
            }
        }
        owner.close()
        assertEquals(2, released.size)
        assertSame(manifest, released[0])
        assertSame(pixels, released[1])
        assertThrows(IllegalStateException::class.java) { owner.useBuffers { _, _ -> } }
    }

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
