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

    private fun swapAt(
        position: Double,
        outgoing: Float,
        incoming: Float,
        center: Double = 12.0,
        previous: Boolean = true,
        next: Boolean = true,
    ): Triple<Int, Int, OverlayPolicy.SwapWeights> {
        val (selection, weights) =
            OverlayPolicy.selectSwap(position, center, previous, next, outgoing, incoming)
        return Triple(OverlayPolicy.slot(selection.lower), OverlayPolicy.slot(selection.upper), weights)
    }

    @Test
    fun wallSwapPairsFollowTheOutgoingClimbAcrossARenderAndNeverReachAThird() {
        assertEquals(0 to 1, OverlayPolicy.REVEAL_MODE_WIPE to OverlayPolicy.REVEAL_MODE_SWAP)
        assertEquals(OverlayPolicy.REVEAL_MODE_SWAP, OverlayPolicy.revealMode("swap"))
        for (name in listOf("wipe", null, "", "Swap", "fade")) {
            assertEquals(OverlayPolicy.REVEAL_MODE_WIPE, OverlayPolicy.revealMode(name))
        }
        // Leaving 12 for 13, before and after the app renders 13 as its centre.
        assertEquals(Triple(0, 2, OverlayPolicy.SwapWeights(.4f, 0f)), swapAt(12.25, .4f, 0f))
        assertEquals(Triple(1, 0, OverlayPolicy.SwapWeights(.4f, 0f)), swapAt(12.25, .4f, 0f, center = 13.0))
        // Leaving 13 for 12: the outgoing climb is the upper one, either way round.
        assertEquals(OverlayPolicy.SwapWeights(.6f, .2f), swapAt(12.75, .2f, .6f).third)
        assertEquals(OverlayPolicy.SwapWeights(.6f, .2f), swapAt(12.75, .2f, .6f, center = 13.0).third)
        // Weights ignore position; Reduce Motion is the app's to apply.
        assertEquals(swapAt(12.1, .3f, .5f).third, swapAt(12.4, .3f, .5f).third)
        assertEquals(Triple(0, 0, OverlayPolicy.SwapWeights(1f, 0f)), swapAt(12.0, .4f, .9f))
        assertEquals(OverlayPolicy.SwapWeights(1f, 0f), swapAt(12.25, .4f, .5f, next = false).third)
        // A pair beyond the prepared trio shows its nearest prepared climb alone.
        assertEquals(Triple(2, 2, OverlayPolicy.SwapWeights(1f, 0f)), swapAt(13.25, .4f, .6f))
        assertEquals(Triple(1, 1, OverlayPolicy.SwapWeights(1f, 0f)), swapAt(10.75, .4f, .6f))
        assertEquals(0, swapAt(13.25, .4f, .6f, next = false).first)
        assertEquals(OverlayPolicy.SwapWeights(1f, 0f), swapAt(12.25, Float.NaN, Float.POSITIVE_INFINITY).third)
        assertEquals(OverlayPolicy.SwapWeights(1f, 0f), swapAt(12.25, 2f, -1f).third)
    }

    @Test
    fun wallSwapHoldWeightsKeepSharedHoldsAndOneRoleAtATime() {
        val mid = OverlayPolicy.SwapWeights(.3f, .6f)
        assertEquals(1f, OverlayPolicy.swapWeight(mid, 1, false), 0f)
        assertEquals(0f, OverlayPolicy.swapWeight(mid, 1, true), 0f)
        assertEquals(.3f, OverlayPolicy.swapWeight(mid, 0, false), 0f)
        assertEquals(.6f, OverlayPolicy.swapWeight(mid, 0, true), 0f)
        for (lowerStep in 0..20) for (upperStep in 0..20) {
            val weights = OverlayPolicy.SwapWeights(lowerStep / 20f, upperStep / 20f)
            val oldRole = OverlayPolicy.swapWeight(weights, 2, false)
            val newRole = OverlayPolicy.swapWeight(weights, 2, true)
            assertEquals(0f, oldRole * newRole, 0f)
            assertEquals(maxOf(weights.lower, weights.upper), maxOf(oldRole, newRole), 0f)
        }
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
    fun delayedConsumptionRetriesWithoutAcceptingZeroOrStaleTimestamps() {
        val ledger = PresentationLedger()
        val frame = ledger.submit(100, 1, 5)!!
        ledger.finish(frame.timestamp)
        assertNull(ledger.consume(0))
        assertFalse(ledger.accept(frame, 1, 5))
        assertEquals(PresentationLedger.ConsumptionWait.RETRY, ledger.consumptionWait(200, 1, 5))
        assertEquals(PresentationLedger.ConsumptionWait.NONE, ledger.consumptionWait(200, 2, 5))
        assertEquals(PresentationLedger.ConsumptionWait.NONE, ledger.consumptionWait(200, 1, 6))
        ledger.consume(frame.timestamp)
        assertTrue(ledger.accept(frame, 1, 5))
        assertEquals(PresentationLedger.ConsumptionWait.NONE, ledger.consumptionWait(200, 1, 5))
        val next = ledger.submit(300, 2, 5)!!
        ledger.finish(next.timestamp)
        assertNull(ledger.consume(frame.timestamp))
        assertEquals(
            PresentationLedger.ConsumptionWait.TIMED_OUT,
            ledger.consumptionWait(2_000_000_300, 2, 5),
        )
        ledger.clear()
        assertEquals(
            PresentationLedger.ConsumptionWait.NONE,
            ledger.consumptionWait(2_000_000_300, 2, 5),
        )
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
