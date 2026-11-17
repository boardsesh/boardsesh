package com.boardsesh.climboverlaygpu

import org.junit.Assert.*
import org.junit.Test

class OverlayPacketJobTest {
    @Test fun cancelledTimerEndsOnceAndNeverStarts() {
        var ended=0;val job=OverlayPacketJob { ended++ }
        job.cancel();job.cancel();assertFalse(job.start());job.finish();assertEquals(1,ended)
    }
    @Test fun runningCancellationRemainsPendingUntilTheActualWorkerEnd() {
        var ended=0;val job=OverlayPacketJob { ended++ }
        assertTrue(job.start());job.cancel();assertEquals(0,ended)
        job.finish();job.finish();assertEquals(1,ended)
    }
}
