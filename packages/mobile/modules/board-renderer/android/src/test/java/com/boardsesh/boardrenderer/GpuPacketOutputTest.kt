package com.boardsesh.boardrenderer

import java.nio.ByteBuffer
import java.nio.ByteOrder
import org.junit.Assert.*
import org.junit.Test

class GpuPacketOutputTest {
    private fun bytes(size: Int)=ByteBuffer.allocateDirect(size).order(ByteOrder.LITTLE_ENDIAN)
    @Test fun threeOwnedBuffersAndUnadoptedMetadataFreeIndependentlyExactlyOnce() {
        val header=bytes(4);val pixels=bytes(1024);val handles=bytes(16).putLong(0,101).putLong(8,102)
        val freed=ArrayList<ByteBuffer>();val closed=ArrayList<Long>()
        val owner=GpuPacketOutput.owned(GpuPacketResult(0,81,arrayOf(header,pixels,handles)),2,{ freed.add(it) },{ closed.add(it) })
        assertEquals(101L,owner.takeMetadata(101))
        assertEquals(81L,owner.takeHandle())
        owner.close();owner.close()
        assertEquals(listOf(102L),closed)
        assertEquals(3,freed.size)
        assertTrue(freed[0]===header && freed[1]===pixels && freed[2]===handles)
        assertThrows(IllegalStateException::class.java) { owner.useBuffer(1) { it.remaining() } }
    }
    @Test fun decoderFailureReleasesAllRawBuffersAndPublishedHandles() {
        val buffers=arrayOf(bytes(4),bytes(4),bytes(16).putLong(0,91).putLong(8,91))
        val freed=ArrayList<ByteBuffer>();val closed=ArrayList<Long>()
        assertThrows(IllegalStateException::class.java) {
            GpuPacketOutput.owned(GpuPacketResult(0,84,buffers),2,{freed.add(it)},{closed.add(it)})
        }
        assertEquals(listOf(84L,91L,91L),closed)
        assertEquals(3,freed.size)
    }
    @Test fun exceptionDuringPixelReadStillReleasesMetadataAndPacketHandle() {
        val buffers=arrayOf(bytes(4),bytes(512),bytes(8).putLong(0,95))
        val closed=ArrayList<Long>();val freed=ArrayList<ByteBuffer>()
        assertThrows(IllegalArgumentException::class.java) {
            GpuPacketOutput.owned(GpuPacketResult(0,87,buffers),2,{freed.add(it)},{closed.add(it)}).use { owner ->
                owner.useBuffer(1) { throw IllegalArgumentException("decode failed") }
            }
        }
        assertEquals(listOf(87L,95L),closed);assertEquals(3,freed.size)
    }
}
