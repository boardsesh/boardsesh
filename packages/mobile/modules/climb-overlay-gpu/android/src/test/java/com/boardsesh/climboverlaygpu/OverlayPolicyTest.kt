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
        shared: Float = 1f,
    ): Triple<Int, Int, OverlayPolicy.SwapWeights> {
        val (selection, weights) =
            OverlayPolicy.selectSwap(position, center, previous, next, outgoing, incoming, shared)
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
    fun sharedHoldsTakeOneWeightWhicheverSideIsOutgoingAndAStillKeepsThemWhole() {
        assertEquals(OverlayPolicy.SwapWeights(.4f, 0f, .4f), swapAt(12.25, .4f, 0f, shared = .4f).third)
        assertEquals(OverlayPolicy.SwapWeights(.6f, .2f, .6f), swapAt(12.75, .2f, .6f, shared = .6f).third)
        assertEquals(OverlayPolicy.SwapWeights(1f, 0f, 1f), swapAt(12.0, .4f, 0f, shared = .4f).third)
        assertEquals(1f, swapAt(13.25, .4f, .6f, shared = .4f).third.shared)
        // Without a shared weight (API 6's look) shared holds stay whole.
        assertEquals(1f, swapAt(12.25, .4f, 0f).third.shared)
        assertEquals(1f, swapAt(12.25, .4f, 0f, shared = Float.NaN).third.shared)
        assertEquals(0f, swapAt(12.25, .4f, 0f, shared = -1f).third.shared)
        assertEquals(1f, swapAt(12.25, .4f, 0f, shared = 2f).third.shared)
    }

    private fun shown(controls: OverlayControls, center: Double = 12.0): Triple<Int, Int, OverlayPolicy.SwapWeights> {
        val (selection, weights) =
            OverlayPolicy.selectSwap(
                controls.position!!, center, true, true, controls.outgoing, controls.incoming, controls.shared,
            )
        return Triple(OverlayPolicy.slot(selection.lower), OverlayPolicy.slot(selection.upper), weights)
    }

    @Test
    fun aSwapFrameReachesTheRenderThreadAsOneSnapshot() {
        val swapping =
            OverlayControls(null, false, false, false, OverlayPolicy.REVEAL_MODE_SWAP)
                .withSwapFrame(listOf(12.25, 0.0, 0.97))!!
        assertEquals(Triple(0, 2, OverlayPolicy.SwapWeights(0f, .97f)), shown(swapping))
        // The swap ends: the pair, the leaving climb and the arriving one change in
        // one assignment. Split props once let the render thread read the new
        // position with the old weights: the climb just left, fully lit.
        val arrived = swapping.withSwapFrame(listOf(13.0, 1.0, 0.0))!!
        assertEquals(Triple(13.0, 1f, 0f), Triple(arrived.position, arrived.outgoing, arrived.incoming))
        assertEquals(Triple(0, 2, OverlayPolicy.SwapWeights(0f, 1f)), shown(arrived))
        assertEquals(swapping.copy(position = 13.0, outgoing = 1f, incoming = 0f), arrived)
        assertEquals(OverlayPolicy.REVEAL_MODE_SWAP, arrived.revealMode)
        assertEquals(1f to 0f, swapping.withSwapFrame(listOf(12.25, 2.0, -1.0))!!.let { it.outgoing to it.incoming })
        for (malformed in listOf(null, listOf(12.25, .4), listOf(12.25, .4, 0.0, 1.0, 1.0), listOf(Double.NaN, .4, 0.0),
            listOf(12.0, .4, Double.POSITIVE_INFINITY), listOf(Double.NaN, .4, 0.0, 1.0), emptyList())) {
            assertNull(swapping.withSwapFrame(malformed))
        }
    }

    @Test
    fun anApi7SwapFrameCarriesTheSharedHoldWeightAndThreeNumbersKeepThemWhole() {
        val controls = OverlayControls(null, false, false, false, OverlayPolicy.REVEAL_MODE_SWAP)
        val dipped = controls.withSwapFrame(listOf(12.25, .4, 0.0, .4))!!
        assertEquals(.4f, dipped.shared)
        assertEquals(Triple(0, 2, OverlayPolicy.SwapWeights(.4f, 0f, .4f)), shown(dipped))
        assertEquals(1f, controls.withSwapFrame(listOf(12.25, .4, 0.0))!!.shared)
        assertEquals(1f, dipped.withSwapFrame(listOf(12.25, .4, 0.0))!!.shared)
        for (invalid in listOf(Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY)) {
            assertEquals(1f, controls.withSwapFrame(listOf(12.25, .4, 0.0, invalid))!!.shared)
        }
        assertEquals(0f, controls.withSwapFrame(listOf(12.25, .4, 0.0, -3.0))!!.shared)
        assertEquals(1f, controls.withSwapFrame(listOf(12.25, .4, 0.0, 7.0))!!.shared)
        // The carried-over frame from the old trio keeps the shared weight too.
        val carried = OverlayPolicy.carryOverSwap(12.25, 12.0, true, true, 0f, .6f, .6f)!!
        assertEquals(swapAt(12.25, 0f, .6f, center = 13.0, shared = .6f).third, carried.second)
    }

    @Test
    fun theOldTrioKeepsTheRunningSwapUntilItsReplacementIsReady() {
        fun carried(position: Double, center: Double, next: Boolean = true, outgoing: Float, incoming: Float) =
            OverlayPolicy.carryOverSwap(position, center, true, next, outgoing, incoming)?.let { (selection, weights) ->
                Triple(OverlayPolicy.slot(selection.lower), OverlayPolicy.slot(selection.upper), weights)
            }
        // Leaving 12 for 13 after the app rendered 13: the old trio (11, 12, 13)
        // draws the same pages and weights the new trio (12, 13, 14) will.
        val old = carried(12.25, 12.0, outgoing = .1f, incoming = .5f)!!
        val new = swapAt(12.25, .1f, .5f, center = 13.0)
        assertEquals(0 to 2, old.first to old.second)
        assertEquals(1 to 0, new.first to new.second)
        assertEquals(new.third, old.third)
        assertEquals(Triple(0, 2, OverlayPolicy.SwapWeights(0f, 1f)), carried(13.0, 12.0, outgoing = 1f, incoming = 0f))
        assertEquals(Triple(0, 0, OverlayPolicy.SwapWeights(1f, 0f)), carried(12.0, 12.0, outgoing = 1f, incoming = 0f))
        // A frame the old trio cannot draw holds the last one instead of guessing.
        assertNull(carried(13.25, 12.0, outgoing = .1f, incoming = .5f))
        assertNull(carried(12.25, 12.0, next = false, outgoing = .1f, incoming = .5f))
        assertNull(carried(13.0, 12.0, next = false, outgoing = 1f, incoming = 0f))
        assertNull(carried(Double.NaN, 12.0, outgoing = 1f, incoming = 0f))
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
    fun twoCarriedFramesSeenOnlyWithStaleTimestampsDrainOnTheReRead() {
        // The old request (revision 7) keeps drawing the swap while revision 8 prepares.
        val ledger = PresentationLedger()
        val before = ledger.submit(50, 7, 3)!!
        ledger.finish(before.timestamp)
        ledger.consume(before.timestamp)
        assertTrue(ledger.accept(before, 7, 3))
        val first = ledger.submit(100, 7, 3)!!
        val second = ledger.submit(108, 7, 3)!!
        ledger.finish(first.timestamp)
        ledger.finish(second.timestamp)
        // Both update callbacks ran before HWUI latched: each read the frame before the carry.
        assertNull(ledger.consume(before.timestamp))
        assertNull(ledger.consume(before.timestamp))
        assertFalse(OverlayPolicy.canSubmit(ledger.size, 0))

        val presenter = OverlayConsumption.presenter(eligible = false, carrying = true)
        assertEquals(OverlayConsumption.Presenter.CARRIED, presenter)
        // No later frame can arrive, so the refused draw arms the re-read itself.
        assertTrue(OverlayConsumption.armsOwnObservation(presenter))
        assertEquals(
            OverlayConsumption.Observation.OBSERVE,
            OverlayConsumption.observation(presenter, ledger.consumptionWait(120, 7, 3)),
        )
        val old = "revision-7"
        assertTrue(OverlayConsumption.takesSlot(null, false, old, carried = true))
        assertTrue(OverlayConsumption.observationCurrent(matches = false, carried = true, matchesGeometry = true))

        // 16 ms later the texture holds the newest carried frame.
        val latched = ledger.consume(second.timestamp)!!
        assertEquals(1, ledger.size) // The skipped earlier frame left with it.
        assertTrue(ledger.accept(latched, 7, 3))
        assertEquals(OverlayConsumption.Accepted.RESUME, OverlayConsumption.accepted(presenter, true))
        assertEquals(0, ledger.size)
        assertTrue(OverlayPolicy.canSubmit(ledger.size, 0))
        assertEquals(
            OverlayConsumption.Observation.NONE,
            OverlayConsumption.observation(presenter, ledger.consumptionWait(130, 7, 3)),
        )
    }

    @Test
    fun aCarriedFrameNeverReportsReady() {
        val carried = OverlayConsumption.Presenter.CARRIED
        for (left in listOf(true, false)) {
            assertNotEquals(OverlayConsumption.Accepted.PRESENTED, OverlayConsumption.accepted(carried, left))
            assertEquals(OverlayConsumption.Accepted.DROPPED, OverlayConsumption.accepted(OverlayConsumption.Presenter.NONE, left))
        }
        assertEquals(OverlayConsumption.Accepted.DROPPED, OverlayConsumption.accepted(carried, false))
        // The current request is unchanged: its consumed, completed frame is presented.
        assertEquals(
            OverlayConsumption.Accepted.PRESENTED,
            OverlayConsumption.accepted(OverlayConsumption.Presenter.CURRENT, true),
        )
        assertEquals(
            OverlayConsumption.Accepted.DROPPED,
            OverlayConsumption.accepted(OverlayConsumption.Presenter.CURRENT, false),
        )
        assertEquals(OverlayConsumption.Presenter.CURRENT, OverlayConsumption.presenter(eligible = true, carrying = true))
        assertEquals(OverlayConsumption.Presenter.NONE, OverlayConsumption.presenter(eligible = false, carrying = false))
        assertFalse(OverlayConsumption.armsOwnObservation(OverlayConsumption.Presenter.CURRENT))
        assertFalse(OverlayConsumption.armsOwnObservation(OverlayConsumption.Presenter.NONE))
    }

    @Test
    fun aStuckCarriedFrameStopsTheCarryWithoutFailingTheNewRequest() {
        val ledger = PresentationLedger()
        val stuck = ledger.submit(100, 7, 3)!!
        ledger.finish(stuck.timestamp)
        val late = 2_000_000_100L
        assertEquals(PresentationLedger.ConsumptionWait.TIMED_OUT, ledger.consumptionWait(late, 7, 3))
        assertEquals(
            OverlayConsumption.Observation.STOP_CARRY,
            OverlayConsumption.observation(OverlayConsumption.Presenter.CARRIED, ledger.consumptionWait(late, 7, 3)),
        )
        // The new request has no frame of its own in the ledger, so nothing fails it.
        assertEquals(
            OverlayConsumption.Observation.NONE,
            OverlayConsumption.observation(OverlayConsumption.Presenter.CURRENT, ledger.consumptionWait(late, 8, 3)),
        )
        for (wait in PresentationLedger.ConsumptionWait.entries) {
            assertNotEquals(
                OverlayConsumption.Observation.FAIL,
                OverlayConsumption.observation(OverlayConsumption.Presenter.CARRIED, wait),
            )
            assertEquals(
                OverlayConsumption.Observation.NONE,
                OverlayConsumption.observation(OverlayConsumption.Presenter.NONE, wait),
            )
        }
        // The current request keeps its 2-second failure and its re-read.
        assertEquals(
            OverlayConsumption.Observation.FAIL,
            OverlayConsumption.observation(OverlayConsumption.Presenter.CURRENT, PresentationLedger.ConsumptionWait.TIMED_OUT),
        )
        assertEquals(
            OverlayConsumption.Observation.OBSERVE,
            OverlayConsumption.observation(OverlayConsumption.Presenter.CURRENT, PresentationLedger.ConsumptionWait.RETRY),
        )
    }

    @Test
    fun aCarriedReReadGivesWayToTheRequestThatReplacedIt() {
        val old = "revision-7"
        val next = "revision-8"
        // The current request's pending re-read is never displaced, as before.
        assertFalse(OverlayConsumption.takesSlot(next, false, next, carried = false))
        assertFalse(OverlayConsumption.takesSlot(next, false, old, carried = true))
        // A late carried re-read never queues behind or replaces the current one.
        assertTrue(OverlayConsumption.takesSlot(old, true, next, carried = false))
        assertFalse(OverlayConsumption.takesSlot(old, true, old, carried = true))
        assertTrue(OverlayConsumption.takesSlot(old, true, next, carried = true))
        // Hidden, detached, destroyed or regeometried: the view no longer allows the carry.
        assertFalse(OverlayConsumption.observationCurrent(matches = false, carried = true, matchesGeometry = false))
        assertFalse(OverlayConsumption.observationCurrent(matches = false, carried = false, matchesGeometry = true))
        assertTrue(OverlayConsumption.observationCurrent(matches = true, carried = false, matchesGeometry = true))
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
