package com.boardsesh.diagnostics

import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

class AtomicDiagnosticAbortTest {
    @Test fun drainsOldScopeWritesBeforeAtomicStampAndAbort() {
        val executor = Executors.newSingleThreadExecutor()
        try {
            val calls = mutableListOf<String>()
            executor.submit { calls.add("old-observer") }
            assertTrue(AtomicDiagnosticAbort.run({ executor.submit(it) }) {
                calls.add("visible-run-id")
                calls.add("abort")
            })
            assertEquals(listOf("old-observer", "visible-run-id", "abort"), calls)
        } finally { executor.shutdownNow() }
    }

    @Test fun unavailablePreventsEvenAnUncooperativeLateSchedulerFromCrashing() {
        var queued: Runnable? = null
        var crashed = false
        var cleanedUp = false
        assertFalse(AtomicDiagnosticAbort.run({ runnable ->
            queued = runnable
            FutureTask(runnable, null)
        }, 1, onFailure = { cleanedUp = true }) { crashed = true })
        queued!!.run()
        assertFalse(crashed)
        assertFalse(cleanedUp)
    }

    @Test fun failedAbortRemovesPartialAttributionBeforeUnavailableAndLaterObserverWrites() {
        val executor = Executors.newSingleThreadExecutor()
        try {
            val calls = mutableListOf<String>()
            val nativeScope = mutableMapOf<String, String>()
            executor.submit {
                nativeScope["launch_id"] = "real-launch"
                calls.add("old-observer")
            }
            assertFalse(AtomicDiagnosticAbort.run(
                { executor.submit(it) },
                onFailure = {
                    nativeScope.remove("source")
                    nativeScope.remove("test_run_id")
                    nativeScope.remove("mobile_diagnostics_native_abort")
                    calls.add("cleanup")
                },
            ) {
                nativeScope["source"] = "sentry-test"
                nativeScope["test_run_id"] = "failed-run"
                nativeScope["mobile_diagnostics_native_abort"] = "test-context"
                calls.add("partial-stamp")
                throw UnsatisfiedLinkError("abort JNI symbol missing")
            })
            calls.add("unavailable")
            // Work queued behind the failed atomic job must see the rollback too.
            val laterScope = executor.submit<Map<String, String>> {
                calls.add("later-observer")
                nativeScope.toMap()
            }.get(1, TimeUnit.SECONDS)
            assertEquals(mapOf("launch_id" to "real-launch"), laterScope)
            assertEquals(
                listOf("old-observer", "partial-stamp", "cleanup", "unavailable", "later-observer"),
                calls,
            )
        } finally { executor.shutdownNow() }
    }

    @Test fun timeoutDoesNotReportUnavailableWhileAtomicActionIsRunning() {
        val executor = Executors.newSingleThreadExecutor()
        val callers = Executors.newSingleThreadExecutor()
        val started = CountDownLatch(1)
        val release = CountDownLatch(1)
        try {
            val result = callers.submit<Boolean> {
                AtomicDiagnosticAbort.run({ executor.submit(it) }, 100) {
                    started.countDown()
                    release.await()
                }
            }
            assertTrue(started.await(1, TimeUnit.SECONDS))
            try {
                result.get(200, TimeUnit.MILLISECONDS)
                fail("Must not report unavailable while the action still runs")
            } catch (_: TimeoutException) { /* The action holds the cancellation gate. */ }
            release.countDown()
            assertFalse(result.get(1, TimeUnit.SECONDS))
        } finally {
            release.countDown()
            callers.shutdownNow()
            executor.shutdownNow()
        }
    }
}
