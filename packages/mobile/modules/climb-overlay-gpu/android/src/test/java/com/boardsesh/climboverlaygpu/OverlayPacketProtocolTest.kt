package com.boardsesh.climboverlaygpu

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class OverlayPacketProtocolTest {
    @Test fun cancelledAndClosedNeverBecomeFailureEvents() {
        assertThrows(OverlayWorkCancelled::class.java) { packetStatus(-3,true) }
        assertThrows(OverlayWorkCancelled::class.java) { packetStatus(-4,false) }
    }
    @Test fun aggregatePressureAndFramesHaveSeparateFailureScopes() {
        val pressure=assertThrows(PacketFailure::class.java) { packetStatus(-5,true) }
        assertEquals("context",pressure.scope)
        assertEquals("gpu-resource-limit",pressure.reason)
        val frame=assertThrows(PacketFailure::class.java) { packetStatus(-2,false) }
        assertEquals("frame",frame.scope)
        val config=assertThrows(PacketFailure::class.java) { packetStatus(-2,true) }
        assertEquals("static",config.scope)
    }
    @Test fun headerIntegersAndBooleansRejectJsonCoercion() {
        for(encoded in listOf("true","\"1\"","1.2","-1","4294967296")) {
            assertThrows(IllegalArgumentException::class.java) { JSONArray("[$encoded]").packetUInt32(0) }
        }
        assertEquals(0xffffffffL,JSONArray("[4294967295]").packetUInt32(0))
        assertThrows(IllegalArgumentException::class.java) { JSONArray("[\"true\"]").packetBoolean(0) }
        assertTrue(JSONArray("[true]").packetBoolean(0))
        assertThrows(IllegalArgumentException::class.java) { JSONObject("{\"offset\":1.2}").packetInt("offset") }
    }
    @Test fun sourcePacketKeepsEmptyFramesDistinctFromConfigFallback() {
        val fallback=JSONObject(packetSource(null,null,null,null))
        val empty=JSONObject(packetSource("",null,null,emptyMap()))
        assertTrue(fallback.isNull("current"));assertEquals("",empty.getString("current"))
        assertEquals(0,empty.getJSONArray("edit_baseline").length())
        assertThrows(PacketFailure::class.java) { packetSource("a".repeat(32769),null,null,null) }
    }
    @Test fun drainedRequiresStableEpochAndNoNativeOrGpuWork() {
        assertTrue(packetStatsDrained(1,1,0,0,true))
        assertFalse(packetStatsDrained(1,2,0,0,true))
        assertFalse(packetStatsDrained(1,1,1,0,true))
        assertFalse(packetStatsDrained(1,1,0,1,true))
        assertFalse(packetStatsDrained(1,1,0,0,false))
        OverlayPacketMetrics.begin();OverlayPacketMetrics.gpuBegin()
        try {
            OverlayPacketMetrics.end()
            val nativeDrained=OverlayPacketMetrics.snapshot()
            assertEquals(0,nativeDrained["pendingNativeJobs"])
            assertEquals(1,nativeDrained["pendingGpuCommands"])
        } finally { OverlayPacketMetrics.gpuEnd() }
        assertEquals(0,OverlayPacketMetrics.snapshot()["pendingGpuCommands"])
    }

}
