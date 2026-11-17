package com.boardsesh.climboverlaygpu

import org.junit.Assert.*
import org.junit.Test

class OverlayLifecycleTest {
    @Test
    fun aCurrentRequestInitializesBeforeRecreatingALostSurface() {
        var context = false
        var surface = false
        val calls = ArrayList<String>()
        fun prepare(current: Boolean) = OverlayLifecycle.beginPreparation({ current }, {
            calls.add("initialize")
            context = true
        }, {
            assertTrue(context)
            calls.add("surface")
            surface = true
        })
        assertTrue(prepare(true))
        assertTrue(surface)
        assertEquals(listOf("initialize", "surface"), calls)
        context = false
        surface = false // Existing TextureView survives an EGL context reset.
        assertTrue(prepare(true))
        assertTrue(context && surface)
        assertEquals(listOf("initialize", "surface", "initialize", "surface"), calls)
        assertFalse(prepare(false))
        assertEquals(4, calls.size)
    }

    @Test
    fun aFrameInvalidatedDuringSetupCannotBePresented() {
        var current = true
        assertFalse(OverlayLifecycle.beginPreparation({ current }, {}, { current = false }))
    }

    @Test
    fun contextRecoveryIsBoundedPerRequestAndNeverPoisonsANewRequest() {
        val gate = ContextRecoveryGate()
        assertTrue(gate.retry(7, 3))
        assertFalse(gate.retry(7, 3))
        assertTrue(gate.retry(8, 3))
        assertFalse(gate.retry(8, 3))
        assertTrue(gate.retry(8, 4))
    }

    @Test
    fun recoveryUsesAlreadyQueuedLatestWorkAndRetriesAResetDuringWorkExactlyOnce() {
        val queue = OverlayPreparationQueue()
        assertTrue(queue.begin()) // Newer request queued before context reset.
        queue.requestRecovery()
        assertFalse(queue.begin())
        queue.started() // Queued latest work performs initialization/recreation.
        assertFalse(queue.needsRecovery)
        assertFalse(queue.finish(false))

        assertTrue(queue.begin())
        queue.started()
        queue.requestRecovery() // Reset during currently running preparation.
        assertFalse(queue.begin())
        assertTrue(queue.finish(false))
        assertTrue(queue.begin())
        queue.started()
        assertFalse(queue.finish(false))
        assertFalse(queue.needsRecovery)
    }

    @Test
    fun newFramesAndMembershipReuseGeometryButSourceAssetsAndGenerationDoNot() {
        val source = OverlayRequest("layout", "p1r13", "", "p2r13", 1.0, "first", 7, 3, false, false)
        val swipe = source.copy(frames = "p2r13", previous = "p1r13", next = "p3r43", center = 2.0,
            requestId = "next", revision = 8, animateEdits = true, observedEmpty = true)
        assertTrue(source.sameGeometry(swipe))
        assertFalse(source.sameGeometry(swipe.copy(config = "other-layout")))
        assertFalse(source.sameGeometry(swipe.copy(generation = 4)))
        assertFalse(source.sameGeometry(swipe.copy(geometryAssetPath = "other-path")))
        assertFalse(source.sameGeometry(swipe.copy(geometryAssetSha256 = "other-sha")))
        assertFalse(source.sameGeometry(swipe.copy(generatedGeometryDirectory = "other-directory")))
    }

    @Test
    fun onlyASwapTrioChangeWithTheSameGeometryCarriesThePacketOnScreen() {
        val onScreen = OverlayRequest("layout", "p1r13", "p0r13", "p2r13", 1.0, "first", 7, 3, false, false)
        val swipe = onScreen.copy(frames = "p2r13", previous = "p1r13", next = "p3r43", center = 2.0,
            requestId = "next", revision = 8)
        assertTrue(OverlayLifecycle.carriesPacket(onScreen, swipe, swap = true))
        assertFalse(OverlayLifecycle.carriesPacket(onScreen, swipe, swap = false))
        assertFalse(OverlayLifecycle.carriesPacket(null, swipe, swap = true))
        assertFalse(OverlayLifecycle.carriesPacket(onScreen.copy(animateEdits = true), swipe, swap = true))
        assertFalse(OverlayLifecycle.carriesPacket(onScreen, swipe.copy(animateEdits = true), swap = true))
        assertFalse(OverlayLifecycle.carriesPacket(onScreen, swipe.copy(config = "other-layout"), swap = true))
        assertFalse(OverlayLifecycle.carriesPacket(onScreen, swipe.copy(generation = 4), swap = true))
    }

    @Test
    fun anEncodeIsCurrentOnlyWhileEveryKeyKeepsTheHandleItWasLent() {
        val lent = mapOf("a" to 1L, "b" to 2L)
        val keys = listOf("a", "b", "c") // "c" was missing when lent.
        assertTrue(OverlayLifecycle.residencyUnchanged(lent, keys) { lent[it] })
        assertTrue(OverlayLifecycle.residencyUnchanged(lent, keys) { (lent + ("other" to 9L))[it] })
        assertFalse(OverlayLifecycle.residencyUnchanged(lent, keys) { mapOf("a" to 1L)[it] }) // "b" evicted
        assertFalse(OverlayLifecycle.residencyUnchanged(lent, keys) { (lent + ("b" to 5L))[it] }) // re-uploaded
        assertFalse(OverlayLifecycle.residencyUnchanged(lent, keys) { (lent + ("c" to 7L))[it] }) // uploaded elsewhere
        assertFalse(OverlayLifecycle.residencyUnchanged(lent, lent.keys) { emptyMap<String, Long>()[it] }) // trimmed
    }

    private fun encodeFailure(
        tokenCancelled: Boolean = false,
        attempt: Int = 0,
        outOfMemory: Boolean = false,
        cancelledStatus: Boolean = false,
        moved: Boolean = false,
        resourceFailure: Boolean = false,
        carrying: Boolean = false,
    ) = OverlayLifecycle.encodeFailure(tokenCancelled, OverlayLifecycle.preparesInline(attempt), outOfMemory,
        cancelledStatus, moved, resourceFailure, carrying)

    @Test
    fun aHandleClosedUnderTheWorkerRetriesTheStillCurrentRequest() {
        // Rust reports the closed chunk handle with the cancelled status; the token was never cancelled.
        assertEquals(OverlayLifecycle.EncodeFailure.RETRY, encodeFailure(cancelledStatus = true, moved = true))
        assertEquals(OverlayLifecycle.EncodeFailure.RETRY, encodeFailure(attempt = 1, cancelledStatus = true, moved = true))
        // Any other failure against a moved arena is a stale loan too, as before.
        assertEquals(OverlayLifecycle.EncodeFailure.RETRY, encodeFailure(moved = true))
        assertEquals(OverlayLifecycle.EncodeFailure.RETRY, encodeFailure(moved = true, resourceFailure = true, carrying = true))
    }

    @Test
    fun aCancelledTokenWithdrawsEvenWhenTheArenaAlsoMoved() {
        for (attempt in 0..OverlayLifecycle.OFF_THREAD_ATTEMPTS) for (moved in listOf(true, false)) {
            assertEquals(OverlayLifecycle.EncodeFailure.WITHDRAW,
                encodeFailure(tokenCancelled = true, attempt = attempt, cancelledStatus = true, moved = moved))
            assertEquals(OverlayLifecycle.EncodeFailure.WITHDRAW,
                encodeFailure(tokenCancelled = true, attempt = attempt, outOfMemory = true, moved = moved))
        }
    }

    @Test
    fun aClosedHandleWithUnchangedResidencyRetriesThenFailsVisiblyInline() {
        // Not expected: lent sessions are retained and only resident chunk handles close. Retry
        // off-thread, and if the inline encode against a fresh loan still sees it, fail instead of hanging.
        assertEquals(OverlayLifecycle.EncodeFailure.RETRY, encodeFailure(cancelledStatus = true))
        assertEquals(OverlayLifecycle.EncodeFailure.FAIL_CLOSED,
            encodeFailure(attempt = OverlayLifecycle.OFF_THREAD_ATTEMPTS, cancelledStatus = true))
    }

    @Test
    fun exhaustedAttemptsEncodeInlineAndAnInlineFailureNeverRetries() {
        var attempt = 0
        while (encodeFailure(attempt = attempt, cancelledStatus = true, moved = true) ==
            OverlayLifecycle.EncodeFailure.RETRY) {
            attempt++
            assertTrue(attempt <= OverlayLifecycle.OFF_THREAD_ATTEMPTS)
        }
        assertEquals(OverlayLifecycle.OFF_THREAD_ATTEMPTS, attempt)
        assertTrue(OverlayLifecycle.preparesInline(attempt))
        val inline = OverlayLifecycle.OFF_THREAD_ATTEMPTS
        assertEquals(OverlayLifecycle.EncodeFailure.FAIL, encodeFailure(attempt = inline, moved = true))
        assertEquals(OverlayLifecycle.EncodeFailure.FAIL_RESOURCE, encodeFailure(attempt = inline, outOfMemory = true))
        assertEquals(OverlayLifecycle.EncodeFailure.FAIL_RESOURCE, encodeFailure(outOfMemory = true, moved = true))
        // The carried packet's release is tried, then a second resource failure fails the request.
        assertEquals(OverlayLifecycle.EncodeFailure.RELEASE_CARRIED,
            encodeFailure(attempt = inline, resourceFailure = true, carrying = true))
        assertEquals(OverlayLifecycle.EncodeFailure.FAIL, encodeFailure(attempt = inline, resourceFailure = true))
        assertEquals(OverlayLifecycle.EncodeFailure.FAIL, encodeFailure())
    }

    @Test
    fun anArenaThatKeepsMovingFallsBackToTheRenderThread() {
        assertFalse(OverlayLifecycle.preparesInline(0))
        assertFalse(OverlayLifecycle.preparesInline(OverlayLifecycle.OFF_THREAD_ATTEMPTS - 1))
        assertTrue(OverlayLifecycle.preparesInline(OverlayLifecycle.OFF_THREAD_ATTEMPTS))
    }

    @Test
    fun aMemoryTrimKeepsTheArenaAPresentingBoardDrawsFrom() {
        var released = 0
        assertFalse(OverlayLifecycle.trim(presenting = true, release = { released++ }, recover = { fail("$it") }))
        assertEquals(0, released)
        assertTrue(OverlayLifecycle.trim(presenting = false, release = { released++ }, recover = { fail("$it") }))
        assertEquals(1, released)
    }

    @Test
    fun aFailedMemoryTrimRecoversAsALostContextAndNeverThrows() {
        val lost = IllegalStateException("EGL context unavailable")
        val recovered = ArrayList<Exception>()
        assertFalse(OverlayLifecycle.trim(presenting = false, release = { throw lost }, recover = { recovered.add(it) }))
        assertEquals(listOf<Exception>(lost), recovered)
        // A recovery that fails too must still stay off the render thread's looper.
        assertFalse(
            OverlayLifecycle.trim(
                presenting = false,
                release = { throw IllegalStateException("GPU resource retirement failed") },
                recover = { throw IllegalStateException("reset failed") },
            ),
        )
    }

    @Test
    fun onlyFailuresThatRepeatForThisPhoneAndConfigAreStatic() {
        fun event(failure: Exception, resourceExhausted: Boolean = false) =
            OverlayLifecycle.failureEvent(failure, resourceExhausted)
        assertEquals("gpu-config-unsupported" to "static", event(PacketFailure("gpu-config-unsupported", "static")))
        assertEquals("gpu-device-unsupported" to "static", event(OverlayUnsupportedFailure("gpu-device-unsupported")))
        assertEquals("gpu-pipeline-unsupported" to "static", event(OverlayUnsupportedFailure("gpu-pipeline-unsupported")))
        assertEquals("gpu-internal-failure" to "context", event(PacketFailure("gpu-internal-failure", "context")))
        assertEquals("frame-role-unsupported" to "frame", event(AtlasFrameFailure("frame-role-unsupported")))
        assertEquals("gpu-resource-limit" to "context", event(OverlayResourceFailure()))
        assertEquals("gpu-resource-limit" to "context", event(IllegalStateException("EGL surface"), resourceExhausted = true))
        for (transient in listOf(
            IllegalStateException("GPU packet allocation/upload failed (GL 1282)"),
            IllegalStateException("GPU completion failed"),
            IllegalStateException("GPU atlas-sized surface unavailable"),
            IllegalStateException("GPU texture consumption timestamp unavailable"),
            IllegalStateException("GLES3 unavailable"),
            IllegalArgumentException("Failed requirement."),
        )) assertEquals("gpu-preparation-failed" to "context", event(transient))
    }

    @Test
    fun frameFailureAndSameGeometryCancellationRetainStaticResources() {
        assertTrue(OverlayLifecycle.retainGeometry(frameFailure = true, cancelled = false, sameGeometry = true))
        assertTrue(OverlayLifecycle.retainGeometry(frameFailure = false, cancelled = true, sameGeometry = true))
        assertFalse(OverlayLifecycle.retainGeometry(frameFailure = false, cancelled = true, sameGeometry = false))
        assertFalse(OverlayLifecycle.retainGeometry(frameFailure = false, cancelled = false, sameGeometry = true))
    }
}
