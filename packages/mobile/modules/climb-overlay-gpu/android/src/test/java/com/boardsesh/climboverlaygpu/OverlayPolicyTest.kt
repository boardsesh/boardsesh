package com.boardsesh.climboverlaygpu

import org.junit.Assert.*
import org.junit.Test

class OverlayPolicyTest {
    @Test
    fun wholeHoldRevealPreservesRolesDirectionAndMirror() {
        for (step in 0..1000) for (center in listOf(0f, .2f, .5f, .8f, 1f)) {
            val progress = step / 1000f
            val reveal = OverlayPolicy.reveal(progress, center, false)
            assertEquals(reveal, OverlayPolicy.reveal(progress, 1 - center, true), .00001f)
            assertTrue(reveal in 0f..1f)
            assertEquals(
                0f,
                OverlayPolicy.weight(reveal, 2, false) * OverlayPolicy.weight(reveal, 2, true),
                0f,
            )
            assertEquals(1f, OverlayPolicy.weight(reveal, 1, false), 0f)
            assertEquals(0f, OverlayPolicy.weight(reveal, 1, true), 0f)
            if (step == 0) assertEquals(0f, reveal, 0f)
            if (step == 1000) assertEquals(1f, reveal, 0f)
        }
        assertTrue(OverlayPolicy.reveal(.5f, .8f, false) > OverlayPolicy.reveal(.5f, .2f, false))
    }

    @Test
    fun pulseExpandsThenReturnsExactlyToNormalWithinAtlasReserve() {
        assertEquals(350_000_000L, OverlayPolicy.EDIT_DURATION_NS)
        assertEquals(1f, OverlayPolicy.reach(0), 0f)
        assertEquals(1.35f, OverlayPolicy.reach(100_000_000), .00001f)
        var previous = 1f
        for (millisecond in 0..350) {
            val scale = OverlayPolicy.reach(millisecond * 1_000_000L)
            assertTrue(scale in 1f..1.35f)
            assertTrue(if (millisecond <= 100) scale >= previous else scale <= previous)
            previous = scale
        }
        assertEquals(1f, OverlayPolicy.reach(-1), 0f)
        assertEquals(1f, OverlayPolicy.reach(350_000_000), 0f)
        assertEquals(1f, OverlayPolicy.reach(Long.MAX_VALUE), 0f)
    }

    @Test
    fun pagerReversalMissingNeighborAndReducedMotionHaveExactEndpoints() {
        assertEquals(
            OverlayPolicy.Selection(-1, 0, .25f),
            OverlayPolicy.select(11.25, 12.0, true, true, false),
        )
        assertEquals(
            OverlayPolicy.Selection(0, 1, .25f),
            OverlayPolicy.select(12.25, 12.0, true, true, false),
        )
        assertEquals(1f, OverlayPolicy.select(999.0, 12.0, true, true, false).progress, 0f)
        assertEquals(
            OverlayPolicy.Selection(0, 0, 0f),
            OverlayPolicy.select(13.0, 12.0, true, false, false),
        )
        assertEquals(
            OverlayPolicy.Selection(0, 0, 0f),
            OverlayPolicy.select(12.5, 12.0, true, true, true),
        )
    }

    @Test
    fun readinessRequiresMatchingConsumedAndCompletedFrame() {
        val ledger = PresentationLedger()
        val frame = ledger.submit(100, 1, 5)!!
        assertFalse(ledger.accept(frame, 1, 5))
        ledger.finish(frame.timestamp)
        assertFalse(ledger.accept(frame, 1, 5))
        ledger.consume(frame.timestamp)
        assertFalse(ledger.accept(frame, 2, 5))
        val next = ledger.submit(100, 2, 5)!!
        assertTrue(next.timestamp > 100)
        ledger.consume(next.timestamp)
        assertFalse(ledger.accept(next, 2, 5))
        ledger.finish(next.timestamp)
        assertTrue(ledger.accept(next, 2, 5))
    }

    @Test
    fun skippedFramesDoNotBlockLatestAndPendingWorkIsBounded() {
        val ledger = PresentationLedger()
        val first = ledger.submit(100, 1, 5)!!
        val latest = ledger.submit(101, 1, 5)!!
        assertNull(ledger.submit(102, 1, 5))
        ledger.consume(latest.timestamp)
        assertNull(ledger.finish(first.timestamp))
        assertFalse(OverlayPolicy.canSubmit(ledger.size, 2))
        assertTrue(OverlayPolicy.canSubmit(ledger.size, 1))
        ledger.finish(latest.timestamp)
        assertTrue(ledger.accept(latest, 1, 5))
        assertEquals(0, ledger.size)
        val stale = ledger.submit(103, 1, 5)!!
        ledger.finish(stale.timestamp)
        ledger.consume(stale.timestamp)
        assertFalse(ledger.accept(stale, 1, 6))
        ledger.clear()
        assertEquals(0, ledger.size)
    }

    @Test
    fun animationCadenceDoesNotRoundPastSixtyHertzVsync() {
        assertTrue(OverlayPolicy.animationFrameDue(1_000_000_000, 1_016_666_666))
        assertFalse(OverlayPolicy.animationFrameDue(1_000_000_000, 1_008_333_333))
        assertTrue(OverlayPolicy.animationFrameDue(1_000_000_000, 1_016_000_000))
    }

    @Test
    fun comparisonAdmissionIncludesCopiesEvenForCachedAtlas() {
        assertEquals(119087104L, OverlayPolicy.comparisonHeadroom(1080, 1504))
        assertTrue(OverlayPolicy.comparisonHeadroom(1536, 2048) > 100L * 1024 * 1024)
        assertThrows(IllegalArgumentException::class.java) {
            OverlayPolicy.comparisonHeadroom(1537, 2048)
        }
    }

    @Test
    fun aggregateBudgetCannotHidePinnedAtlasesOrPartialReservations() {
        val budget = AtlasBudget()
        budget.reserve(120_143_120)
        assertThrows(IllegalArgumentException::class.java) { budget.reserve(20 * 1024 * 1024) }
        assertEquals(120_143_120L, budget.bytes)
        budget.release(120_143_120)
        assertEquals(0, budget.bytes)
        budget.reserve(OverlayPolicy.ATLAS_LIMIT)
        assertThrows(IllegalArgumentException::class.java) { budget.reserve(1) }
    }
}
