package com.boardsesh.climboverlaygpu

/** Timers and queued work remain pending until cancellation or actual drain. */
internal class OverlayPacketJob(private val onEnd: ()->Unit) {
    private var started=false
    private var ended=false
    private var cancelled=false
    @Synchronized fun start(): Boolean {
        if(ended || cancelled)return false
        started=true;return true
    }
    fun cancel() {
        val finish=synchronized(this) { cancelled=true;(!started && !ended).also { if(it)ended=true } }
        if(finish)onEnd()
    }
    fun finish() {
        val finish=synchronized(this) { (!ended).also { ended=true } }
        if(finish)onEnd()
    }
}
