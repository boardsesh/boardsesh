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
    fun frameFailureAndSameGeometryCancellationRetainStaticResources() {
        assertTrue(OverlayLifecycle.retainGeometry(frameFailure = true, cancelled = false, sameGeometry = true))
        assertTrue(OverlayLifecycle.retainGeometry(frameFailure = false, cancelled = true, sameGeometry = true))
        assertFalse(OverlayLifecycle.retainGeometry(frameFailure = false, cancelled = true, sameGeometry = false))
        assertFalse(OverlayLifecycle.retainGeometry(frameFailure = false, cancelled = false, sameGeometry = true))
    }
}
