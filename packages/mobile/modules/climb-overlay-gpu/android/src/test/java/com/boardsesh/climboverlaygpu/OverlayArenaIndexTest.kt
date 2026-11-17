package com.boardsesh.climboverlaygpu

import org.junit.Assert.*
import org.junit.Test

class OverlayArenaIndexTest {
    private fun chunk(key: String, handle: Long, bytes: Int) = ArenaChunk(key,handle,0,bytes)

    @Test
    fun rotationUploadsNothingAndOneNewHoldUsesOnlyItsMissingRanges() {
        val index = OverlayArenaIndex(2*1024*1024,256*1024)
        val keys = listOf("af","ar","bf","br")
        index.commit(index.prepare(keys,listOf(chunk("af",1,64*1024),chunk("ar",2,4*1024),chunk("bf",3,64*1024),chunk("br",4,4*1024))))
        val epoch = index.retain(keys)
        val before = index.records
        val rotation = index.prepare(keys.reversed(),emptyList())
        assertFalse(rotation.replacement)
        assertTrue(rotation.copies.isEmpty())
        assertEquals(before,rotation.records)
        index.commit(rotation)
        val next = index.prepare(keys+listOf("cf","cr"),listOf(chunk("cf",5,64*1024),chunk("cr",6,4*1024)))
        assertFalse(next.replacement)
        assertTrue(next.copies.isEmpty())
        for (key in keys) assertEquals(before.getValue(key).offset,next.records.getValue(key).offset)
        assertEquals(68*1024,next.records.getValue("cf").bytes+next.records.getValue("cr").bytes)
        index.commit(next)
        index.release(keys,epoch)
    }

    @Test
    fun compactionUsesANewGenerationAndNeverEvictsAnyMountedOrInFlightChunk() {
        val index = OverlayArenaIndex(2*1024*1024,256*1024)
        index.commit(index.prepare(listOf("a","b","c"),listOf(chunk("a",11,64*1024),chunk("b",12,64*1024),chunk("c",13,64*1024))))
        val epoch = index.retain(listOf("a","c"))
        val old = index.records
        val oldPixels = ByteArray(index.capacity)
        for (record in old.values) oldPixels.fill(record.handle.toByte(),record.offset,record.offset+record.bytes)
        val compact = index.prepare(listOf("a","c","d"),listOf(chunk("d",14,96*1024)))
        assertTrue(compact.replacement)
        assertEquals(listOf("b"),compact.removed.map { it.key })
        assertNotEquals(old.getValue("c").offset,compact.records.getValue("c").offset)
        val newPixels = ByteArray(compact.capacity)
        for (copy in compact.copies) oldPixels.copyInto(newPixels,copy.destination,copy.source,copy.source+copy.bytes)
        assertEquals(13.toByte(),oldPixels[old.getValue("c").offset])
        assertEquals(13.toByte(),newPixels[compact.records.getValue("c").offset])
        index.commit(compact)
        index.retain(listOf("c","d"))
        index.release(listOf("a","c"),epoch)
        assertEquals(1,index.records.getValue("c").pins)
        val next = index.prepare(listOf("d","e"),listOf(chunk("e",15,96*1024)))
        assertTrue("c" in next.records)
    }

    @Test
    fun oldContextCleanupAndStalePlansCannotModifyNewResidency() {
        val index = OverlayArenaIndex()
        index.commit(index.prepare(listOf("c"),listOf(chunk("c",20,4))))
        val epoch = index.retain(listOf("c"))
        val stale = index.prepare(listOf("c"),emptyList())
        index.retain(listOf("c"))
        assertThrows(IllegalStateException::class.java) { index.commit(stale) }
        index.reset()
        index.commit(index.prepare(listOf("c"),listOf(chunk("c",21,4))))
        index.retain(listOf("c"))
        index.release(listOf("c"),epoch)
        assertEquals(1,index.records.getValue("c").pins)
    }

    @Test
    fun zeroByteMetadataAndBadPlacementsHaveCheckedBounds() {
        val index = OverlayArenaIndex()
        index.commit(index.prepare(listOf("empty"),listOf(chunk("empty",30,0))))
        assertEquals(4,index.capacity)
        assertThrows(IllegalArgumentException::class.java) { index.prepare(listOf("x"),listOf(chunk("x",31,3))) }
        assertThrows(IllegalArgumentException::class.java) { index.prepare(listOf("x","x"),listOf(chunk("x",31,4))) }
        val valid = index.prepare(listOf("empty","x"),listOf(chunk("x",31,4)))
        assertThrows(IllegalArgumentException::class.java) { index.commit(valid.copy(records=valid.records+mapOf("x" to valid.records.getValue("x").copy(offset=Int.MAX_VALUE)))) }
    }
    @Test
    fun zeroByteRoleMetadataCannotBypassTheEntryBound() {
        val index = OverlayArenaIndex(entryTarget=16)
        for (item in 0 until 1000) {
            val key = "zero-$item"
            index.commit(index.prepare(listOf(key),listOf(chunk(key,item.toLong()+100,0))))
            assertTrue(index.records.size <= 16)
        }
        assertFalse("zero-0" in index.records)
        assertTrue("zero-999" in index.records)
    }

    @Test fun aLentCopyPlansLikeTheLiveIndexUntilAnotherCommitTakesItsRange() {
        val index = OverlayArenaIndex(2*1024*1024,256*1024)
        index.commit(index.prepare(listOf("a","b"),listOf(chunk("a",1,64*1024),chunk("b",2,64*1024))))
        val onScreen = index.retain(listOf("a","b"))
        val lent = index.lend()
        val keys = listOf("b","c")
        val offThread = lent.prepare(keys,listOf(chunk("c",3,64*1024)))
        // The packet on screen retires while the worker encodes: pins change, ranges do not.
        index.release(listOf("a","b"),onScreen)
        val live = index.prepare(keys,listOf(chunk("c",3,64*1024)))
        assertTrue(live.placesLike(offThread,keys))
        assertThrows(IllegalStateException::class.java) { index.commit(offThread) }
        index.commit(live)
        assertTrue("c" in index.records)
        assertFalse("c" in lent.records)

        // Another preparation commits into the gap the worker placed "c" in.
        val moved = OverlayArenaIndex(2*1024*1024,256*1024)
        moved.commit(moved.prepare(listOf("a","b"),listOf(chunk("a",1,64*1024),chunk("b",2,64*1024))))
        val lentBeforeCommit = moved.lend()
        val encoded = lentBeforeCommit.prepare(keys,listOf(chunk("c",3,64*1024)))
        moved.commit(moved.prepare(listOf("d"),listOf(chunk("d",4,64*1024))))
        assertFalse(moved.prepare(keys,listOf(chunk("c",3,64*1024))).placesLike(encoded,keys))
        assertFalse("d" in lentBeforeCommit.records)
    }

    @Test fun placementsDifferWhenTheArenaSizeOrAKeysRangeDiffers() {
        val plan = OverlayArenaIndex().prepare(listOf("a","b"),listOf(chunk("a",1,64),chunk("b",2,64)))
        val keys = listOf("a","b")
        assertTrue(plan.placesLike(plan.copy(removed=listOf(chunk("z",9,4)),copies=emptyList()),keys))
        assertFalse(plan.placesLike(plan.copy(capacity=plan.capacity*2),keys))
        val shifted = plan.records.getValue("b").let { it.copy(offset=it.offset+64) }
        assertFalse(plan.placesLike(plan.copy(records=plan.records+("b" to shifted)),keys))
        assertFalse(plan.placesLike(plan.copy(records=plan.records-"b"),keys))
    }

    @Test fun anUnpinnedOversizedSetDoesNotLeaveAnOversizedAllocationRetained() {
        val index=OverlayArenaIndex(2*1024*1024,64*1024)
        index.commit(index.prepare(listOf("large"),listOf(chunk("large",40,128*1024))))
        val small=index.prepare(listOf("small"),listOf(chunk("small",41,4*1024)))
        assertTrue(small.replacement);assertEquals(64*1024,small.capacity)
        assertEquals(listOf("large"),small.removed.map { it.key })
    }

}
