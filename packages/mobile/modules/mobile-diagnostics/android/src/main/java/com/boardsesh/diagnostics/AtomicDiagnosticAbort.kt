package com.boardsesh.diagnostics

import java.util.concurrent.Future
import java.util.concurrent.TimeUnit

/** Cancel a still-pending crash without permitting it to run after an unavailable response. */
internal object AtomicDiagnosticAbort {
    fun run(
        submit: (Runnable) -> Future<*>,
        timeoutMillis: Long = 5000,
        onFailure: () -> Unit = {},
        action: () -> Unit,
    ): Boolean {
        val gate = Any()
        var cancelled = false
        val future = try {
            submit(Runnable {
                synchronized(gate) {
                    if (!cancelled) {
                        try {
                            action()
                        } catch (error: Throwable) {
                            // Roll back partial attribution before releasing the gate.
                            // JNI linkage errors are Errors, not Exceptions.
                            try { onFailure() } catch (cleanupError: Throwable) {
                                error.addSuppressed(cleanupError)
                            }
                            throw error
                        }
                    }
                }
            })
        } catch (_: Exception) { return false }
        return try {
            future.get(timeoutMillis, TimeUnit.MILLISECONDS)
            true // Only test doubles return; the real action terminates the process.
        } catch (error: Exception) {
            // If already running, wait for the atomic action rather than reporting a
            // failure followed by a delayed crash. The real abort does not return.
            synchronized(gate) { cancelled = true }
            future.cancel(false)
            if (error is InterruptedException) Thread.currentThread().interrupt()
            false
        }
    }
}
