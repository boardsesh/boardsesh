package com.boardsesh.boardrenderer

import androidx.annotation.Keep
import java.io.Closeable
import java.nio.ByteBuffer
import java.nio.ByteOrder

/** JNI transfer object. Every buffer is independently Rust-owned, never a pixel ByteArray. */
@Keep // JNI finds this constructor by name; its fields are populated outside R8's call graph.
class GpuPacketResult(val status: Int, val handle: Long, val buffers: Array<ByteBuffer>)

class GpuPacketOutput private constructor(
    private val result: GpuPacketResult,
    private val handlesBuffer: Int? = null,
    private val freeBuffer: (ByteBuffer) -> Unit = GpuPacketBridge::freeBuffer,
    private val closeHandle: (Long) -> Unit = GpuPacketBridge::closeHandle,
) : Closeable {
    val status get() = result.status
    private var handle = result.handle
    private var closed = false
    init {
        if (handlesBuffer != null) {
            require(handlesBuffer in result.buffers.indices)
            val ids = result.buffers[handlesBuffer].order(ByteOrder.LITTLE_ENDIAN)
            require(ids.capacity() % 8 == 0 && ids.capacity() <= 769 * 8)
            for (offset in 0 until ids.capacity() step 8) {
                val id = ids.getLong(offset)
                check(id > 0) { "Invalid native metadata handle" }
                for (prior in 0 until offset step 8) check(ids.getLong(prior) != id) { "Duplicate native metadata handle" }
            }
        }
    }
    companion object {
        /** Own raw JNI outputs before allocating the owner object itself. */
        fun owned(result: GpuPacketResult, handlesBuffer: Int? = null,
            freeBuffer: (ByteBuffer) -> Unit = GpuPacketBridge::freeBuffer,
            closeHandle: (Long) -> Unit = GpuPacketBridge::closeHandle): GpuPacketOutput {
            try { return GpuPacketOutput(result, handlesBuffer, freeBuffer, closeHandle) }
            catch (failure: Throwable) {
                if (result.handle != 0L) closeHandle(result.handle)
                if (handlesBuffer != null && handlesBuffer in result.buffers.indices) {
                    val ids = result.buffers[handlesBuffer].order(ByteOrder.LITTLE_ENDIAN)
                    if (ids.capacity() % 8 == 0 && ids.capacity() <= 769 * 8)
                        for (offset in 0 until ids.capacity() step 8) closeHandle(ids.getLong(offset))
                }
                result.buffers.forEach(freeBuffer)
                throw failure
            }
        }
    }
    fun <T> useBuffer(index: Int, block: (ByteBuffer) -> T): T {
        check(!closed)
        return block(result.buffers[index].duplicate().order(ByteOrder.LITTLE_ENDIAN))
    }
    fun takeHandle(): Long {
        check(!closed)
        return handle.also { handle = 0 }
    }
    fun takeMetadata(id: Long): Long {
        check(!closed)
        val index = handlesBuffer ?: error("Output has no metadata handles")
        val ids = result.buffers[index].order(ByteOrder.LITTLE_ENDIAN)
        for (offset in 0 until ids.capacity() step 8) if (ids.getLong(offset) == id) {
            ids.putLong(offset, 0)
            return id
        }
        error("Unknown or already adopted metadata handle")
    }
    override fun close() {
        if (closed) return
        closed = true
        if (handle != 0L) closeHandle(handle)
        if (handlesBuffer != null) {
            val ids = result.buffers[handlesBuffer].order(ByteOrder.LITTLE_ENDIAN)
            for (offset in 0 until ids.capacity() step 8) {
                val id = ids.getLong(offset)
                if (id != 0L) closeHandle(id)
            }
        }
        result.buffers.forEach(freeBuffer)
    }
}

/** The Rust packet API owns all descriptor/uniform encoding. */
object GpuPacketBridge {
    init {
        System.loadLibrary("board_renderer_ffi")
        System.loadLibrary("board_renderer_jni")
    }
    private external fun nativeCancelCreate(): LongArray
    private external fun nativeSessionCreate(config: ByteArray, cancel: Long): LongArray
    private external fun nativePlanCreate(session: Long, request: ByteArray, cancel: Long): GpuPacketResult
    private external fun nativePlanPrepare(plan: Long, resident: ByteArray, cancel: Long): GpuPacketResult
    private external fun nativePlanEncode(plan: Long, placements: ByteArray, cancel: Long): GpuPacketResult
    private external fun nativeContract(): GpuPacketResult
    private external fun nativeStats(): GpuPacketResult
    external fun packetApiVersion(): Int
    external fun cancel(handle: Long)
    external fun closeHandle(handle: Long)
    external fun freeBuffer(buffer: ByteBuffer)
    external fun setCacheDirectory(session: Long, path: ByteArray): Int
    external fun schedulePersist(session: Long): Int
    /** `revealMode` 0 wipes with `progress`; 1 swaps with the lower-only, upper-only and shared hold weights. */
    external fun encodeUniforms(packet: Long, lower: Int, upper: Int, revealMode: Int, progress: Float,
        swapLower: Float, swapUpper: Float, swapShared: Float, pulse: Float,
        viewportWidth: Float, viewportHeight: Float, productionEmpty: Boolean, mirrored: Boolean,
        destination: ByteBuffer, length: Int): Int
    fun createCancel(): LongArray = nativeCancelCreate()
    fun contract(): GpuPacketOutput = GpuPacketOutput.owned(nativeContract())
    fun stats(): GpuPacketOutput = GpuPacketOutput.owned(nativeStats())
    fun createSession(config: String, cancel: Long): LongArray {
        val bytes = config.toByteArray(Charsets.UTF_8)
        require(bytes.size <= 8 * 1024 * 1024)
        return nativeSessionCreate(bytes, cancel)
    }
    fun createPlan(session: Long, request: String, cancel: Long): GpuPacketOutput =
        GpuPacketOutput.owned(nativePlanCreate(session,request.toByteArray(Charsets.UTF_8),cancel))
    fun prepare(plan: Long, resident: String, cancel: Long): GpuPacketOutput =
        GpuPacketOutput.owned(nativePlanPrepare(plan,resident.toByteArray(Charsets.UTF_8),cancel),2)
    fun encode(plan: Long, placements: String, cancel: Long): GpuPacketOutput =
        GpuPacketOutput.owned(nativePlanEncode(plan,placements.toByteArray(Charsets.UTF_8),cancel))
}
