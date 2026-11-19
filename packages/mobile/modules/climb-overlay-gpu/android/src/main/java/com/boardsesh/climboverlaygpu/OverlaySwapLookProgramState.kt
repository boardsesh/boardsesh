package com.boardsesh.climboverlaygpu

/**
 * Render-thread state for one context's optional program. Constructing it and
 * reading protocol constants do no GPU work. A disabled request always uses
 * the base program, including after a successful optional build.
 */
internal class SwapLookProgramState {
    var program = 0
        private set
    private var attempted = false

    fun resolve(eligible: Boolean, swap: Boolean, hasLook: Boolean, reduced: Boolean, build: () -> Int): Int {
        if (!eligible || !swap || !hasLook || reduced) return 0
        if (!attempted) {
            attempted = true
            program = build()
        }
        return program
    }

    /** Called only when the owning EGL context is destroyed. */
    fun reset() {
        program = 0
        attempted = false
    }
}
