package com.boardsesh.climboverlaygpu

import android.content.Context
import android.opengl.GLES31
import com.boardsesh.boardrenderer.GpuPacketBridge
import com.boardsesh.boardrenderer.GpuPacketOutput
import java.io.Closeable
import java.nio.ByteBuffer
import org.json.JSONArray
import org.json.JSONObject

internal class PacketArena(var buffer: Int,val capacity: Int) { var users=1 }
internal class UploadedPacket(val handle: PacketHandle,val session: PacketRustSession,val header: PacketHeader,
    val descriptors: IntArray,val resources: Int,val arena: PacketArena,val keys: List<String>,val epoch: Long,
    val prepareMs: Double,val uploadMs: Double,val uploadBytes: Int,val copyBytes: Int,val selectedBytes: Int,
    /** Each scene's holds as the swap look reads them, decoded with the packet ([OverlaySwapLook.PacketScenes]). */
    val lookScenes: OverlaySwapLook.PacketScenes) {
    private val uniformBytes=directBytes(OverlayPacketLayout.UNIFORM_BYTES)
    var retired=false
    val hit get()=uploadBytes==0 && copyBytes==0
    fun uniforms(lower: Int,upper: Int,progress: Float,pulse: Float,production: Boolean,mirrored: Boolean,
        revealMode: Int=OverlayPolicy.REVEAL_MODE_WIPE,swap: OverlayPolicy.SwapWeights=OverlayPolicy.SwapWeights(1f,0f)): ByteBuffer {
        val bytes=uniformBytes.apply { clear() }
        packetStatus(GpuPacketBridge.encodeUniforms(handle.id,lower,upper,revealMode,progress,swap.lower,swap.upper,swap.shared,pulse,
            header.width.toFloat(),header.height.toFloat(),production,mirrored,bytes,bytes.capacity()))
        return bytes
    }
}
/** What the render thread lends an encode: each resident chunk's open handle and a detached placement index. */
internal class ArenaLoan(val resident: Map<String,Long>,val index: OverlayArenaIndex)
/** A chunk the Rust batch materialized: its metadata lease and its range in the batch's pixel buffer. */
internal data class MissingChunk(val key: String,val handle: Long,val bytes: Int,val source: Int)
/** The CPU half of a packet, encoded against an [ArenaLoan]. Owns its native outputs until upload adopts them. */
internal class EncodedPacket(val keys: List<String>,val missing: List<MissingChunk>,val pixelBytes: Int,val chunks: GpuPacketOutput,
    val acquired: HashMap<String,PacketHandle>,val placement: ArenaPlan,val encoded: GpuPacketOutput,val description: PacketHeader,
    val lookScenes: OverlaySwapLook.PacketScenes): Closeable {
    override fun close() { acquired.values.forEach { it.close() };acquired.clear();encoded.close();chunks.close() }
}
internal object OverlayPacketMetrics {
    private var epoch=0L
    private var pending=0
    private var pendingGpu=0
    private var completedGpu=0L
    private var uploads=0L
    private var copies=0L
    private var prefetch=0L
    private var replacements=0L
    private var resets=0L
    @Synchronized fun begin() { pending++;epoch++ }
    @Synchronized fun end() { pending--;epoch++ }
    @Synchronized fun gpuBegin() { pendingGpu++;epoch++ }
    @Synchronized fun gpuEnd() { pendingGpu--;check(pendingGpu>=0);completedGpu++;epoch++ }
    @Synchronized fun gpuCompletionEpoch()=completedGpu
    @Synchronized fun gpuReset() { pendingGpu=0;epoch++ }
    @Synchronized fun uploaded(bytes: Int,idle: Boolean) { uploads+=bytes;if(idle)prefetch+=bytes;epoch++ }
    @Synchronized fun copied(bytes: Int,idle: Boolean) { copies+=bytes;if(idle)prefetch+=bytes;epoch++ }
    @Synchronized fun replaced() { replacements++;epoch++ }
    @Synchronized fun reset() { resets++;epoch++ }
    @Synchronized fun snapshot(): Map<String,Any> = mapOf("available" to true,"nativeActivityEpoch" to epoch,"pendingNativeJobs" to pending,"pendingGpuCommands" to pendingGpu,
        "cpuToGpuPixelUploadBytes" to uploads,"gpuArenaCopyBytes" to copies,"gpuPixelUploadBytes" to uploads+copies,
        "prefetchPixelUploadBytes" to prefetch,"arenaReplacements" to replacements,"contextResets" to resets)
}
/**
 * One EGL thread owns placement and GL mutation; old generations remain fence-pinned.
 * Only [encode] may run elsewhere, against an [ArenaLoan] the render thread checks before upload.
 */
internal object OverlayPacketArena {
    private val index=OverlayArenaIndex()
    private var arena: PacketArena?=null
    private var metadata=HashMap<String,PacketHandle>()
    private val sessions=LinkedHashMap<String,PacketRustSession>(4,0.75f,true)
    private val retired=ArrayList<Pair<Long,UploadedPacket>>()
    fun session(app: Context,source: String,cancel: PacketCancellation): PacketRustSession {
        val existing=sessions[source]
        if(existing!=null) return existing.retain()
        if(sessions.size>=4) { val oldest=sessions.entries.iterator();oldest.next().value.close();oldest.remove() }
        val created=PacketRustSession(source,app,cancel)
        try { sessions[source]=created;return created.retain() } catch(failure: Throwable) { created.close();throw failure }
    }
    private fun releaseArena(buffer: PacketArena) {
        buffer.users--;check(buffer.users>=0)
        if(buffer.users==0) OverlayRenderer.deletePacketBuffer(buffer.buffer)
    }
    private fun finish(packet: UploadedPacket) {
        index.release(packet.keys,packet.epoch)
        releaseArena(packet.arena)
        packet.session.close()
    }
    fun collect() {
        val iterator=retired.iterator()
        while(iterator.hasNext()) {
            val (fence,packet)=iterator.next()
            val status=GLES31.glClientWaitSync(fence,0,0)
            if(status==GLES31.GL_ALREADY_SIGNALED || status==GLES31.GL_CONDITION_SATISFIED) {
                GLES31.glDeleteSync(fence);OverlayPacketMetrics.gpuEnd();finish(packet);iterator.remove()
            } else check(status==GLES31.GL_TIMEOUT_EXPIRED)
        }
    }
    fun retire(packet: UploadedPacket?) {
        if(packet==null || packet.retired)return
        packet.retired=true
        packet.descriptors.forEach { OverlayRenderer.deletePacketBuffer(it) }
        OverlayRenderer.deletePacketBuffer(packet.resources)
        packet.handle.close()
        val fence=GLES31.glFenceSync(GLES31.GL_SYNC_GPU_COMMANDS_COMPLETE,0)
        if(fence==0L) { GLES31.glFinish();finish(packet) } else {
            try { retired.add(fence to packet) }
            catch(_: OutOfMemoryError) { GLES31.glFinish();GLES31.glDeleteSync(fence);finish(packet);return }
            OverlayPacketMetrics.gpuBegin();OverlayRenderer.scheduleResourceRetirement()
        }
    }
    fun hasRetired()=retired.isNotEmpty()
    fun releaseGPU() {
        GLES31.glFinish();collect()
        arena?.let(::releaseArena);arena=null
        metadata.values.forEach { it.close() };metadata.clear();index.reset()
    }
    fun abandonContext() {
        retired.forEach { (_,packet)->packet.session.close() };retired.clear()
        arena=null;metadata.values.forEach { it.close() };metadata.clear();index.reset();OverlayPacketMetrics.reset()
    }
    /** Render thread: settles retired packets and lends the arena's residency and placement to an encode. */
    fun lend(cancel: PacketCancellation,valid: ()->Boolean): ArenaLoan {
        collect()
        if(!valid()) { cancel.cancel();throw OverlayWorkCancelled() }
        return ArenaLoan(metadata.mapValues { it.value.id },index.lend())
    }
    /** A lent resident chunk was evicted or released since, so a failed encode may only be stale. */
    fun moved(loan: ArenaLoan)=!OverlayLifecycle.residencyUnchanged(loan.resident,loan.resident.keys) { metadata[it]?.id }
    /** Every phase on the calling render thread: prefetch, the comparison, and a preparation whose arena keeps moving. */
    fun prepare(session: PacketRustSession,request: String,cancel: PacketCancellation,valid: ()->Boolean,idle: Boolean=false): UploadedPacket? {
        val started=System.nanoTime();val loan=lend(cancel,valid)
        return encode(session,request,cancel,loan,idle).use { upload(session,it,loan,cancel,valid,idle,started) }
    }
    /**
     * The Rust plan, chunk and encode phases. Reads only its arguments and changes
     * no arena state, so it may run on the preparation worker. Rust takes its
     * handle registry only to insert leases, never while rasterizing, so frames
     * encoding uniforms on the render thread meanwhile do not wait on it.
     */
    fun encode(session: PacketRustSession,request: String,cancel: PacketCancellation,loan: ArenaLoan,idle: Boolean=false): EncodedPacket =
        GpuPacketBridge.createPlan(session.handle.id,request,cancel.id).use { plan ->
            packetStatus(plan.status)
            val header=plan.json(maximum=256*1024)
            require(header.packetInt("version")==OverlayPacketLayout.PACKET_VERSION && header.getString("contractSha256")==OverlayPacketLayout.CONTRACT_SHA256)
            val rawKeys=header.getJSONArray("chunks");require(rawKeys.length()<=769)
            val keys=(0 until rawKeys.length()).map { rawKeys.getString(it).also { key->require(key.matches(Regex("[0-9a-f]{64}"))) } }
            require(keys.distinct().size==keys.size)
            val counts=header.getJSONArray("counts");val present=header.getJSONArray("present")
            require(counts.length()==3 && present.length()==3 && present.getBoolean(0))
            for(slot in 0..2) require(counts.getInt(slot) in 0..OverlayPacketLayout.MAX_ACTIVE_PER_SOURCE)
            val resident=JSONObject().put("chunks",JSONArray(keys.mapNotNull { loan.resident[it] })).toString()
            val lease=PacketHandle(0);lease.id=plan.takeHandle()
            lease.use { planLease ->
                val chunks=GpuPacketBridge.prepare(planLease.id,resident,cancel.id)
                val acquired=HashMap<String,PacketHandle>()
                var encoded: GpuPacketOutput?=null
                try {
                    packetStatus(chunks.status)
                    val missing=chunks.json(maximum=256*1024)
                    val pixelBytes=chunks.useBuffer(1) { it.remaining() }
                    require(missing.packetInt("version")==OverlayPacketLayout.PACKET_VERSION && missing.packetInt("pixelBytes")==pixelBytes && pixelBytes<=OverlayPacketLayout.MAX_GPU_BYTES)
                    val rows=missing.getJSONArray("chunks");require(rows.length()<=769)
                    val records=(0 until rows.length()).map { ordinal->val entry=rows.getJSONObject(ordinal)
                        MissingChunk(entry.getString("key"),entry.packetLong("handle"),entry.packetInt("bytes"),entry.packetInt("sourceOffset")) }
                    for(record in records) {
                        require(record.key in keys && record.key !in loan.resident && record.key !in acquired && record.bytes%4==0 && record.source%4==0 && record.source<=pixelBytes && record.bytes<=pixelBytes-record.source)
                        val metadataLease=PacketHandle(0)
                        try { metadataLease.id=chunks.takeMetadata(record.handle);acquired[record.key]=metadataLease }
                        catch(failure: Throwable) { metadataLease.close();throw failure }
                    }
                    val placement=loan.index.prepare(keys,records.map { ArenaChunk(it.key,it.handle,0,it.bytes) })
                    if(idle && records.isNotEmpty() && placement.capacity>32*1024*1024) throw OverlayWorkCancelled()
                    val placements=JSONObject().put("arena_bytes",placement.capacity).put("chunks",JSONArray().apply {
                        for(key in keys) { val item=placement.records.getValue(key);put(JSONObject().put("key",key).put("offset",item.offset).put("bytes",item.bytes)) }
                    }).toString()
                    val output=GpuPacketBridge.encode(planLease.id,placements,cancel.id);encoded=output
                    packetStatus(output.status)
                    val description=PacketHeader.parse(output.json(maximum=65536),output.useBuffer(1){it.remaining()},output.useBuffer(2){it.remaining()})
                    // The swap look reads hold centres, roles and ids per frame; the descriptors leave the CPU at
                    // upload. Retain the small plain arrays even with the look off so
                    // enabling it on an already prepared packet needs no geometry work.
                    val lookScenes=output.useBuffer(1) { OverlaySwapLook.PacketScenes.decode(it,description) }
                    EncodedPacket(keys,records,pixelBytes,chunks,acquired,placement,output,description,lookScenes)
                } catch(failure: Throwable) { acquired.values.forEach { it.close() };encoded?.close();chunks.close();throw failure }
            }
        }
    /**
     * Render thread: re-places [packet] in the live arena, uploads and commits it.
     * Throws [OverlayArenaMoved] when residency or placement differs from the loan
     * it was encoded against. A failure before commit leaves [packet] reusable.
     */
    fun upload(session: PacketRustSession,packet: EncodedPacket,loan: ArenaLoan,cancel: PacketCancellation,valid: ()->Boolean,idle: Boolean,started: Long): UploadedPacket? {
        fun current() { if(!valid()) { cancel.cancel();throw OverlayWorkCancelled() } }
        current()
        val keys=packet.keys;val records=packet.missing;val encoded=packet.encoded;val description=packet.description;val pixelBytes=packet.pixelBytes
        if(!OverlayLifecycle.residencyUnchanged(loan.resident,keys) { metadata[it]?.id }) throw OverlayArenaMoved()
        val placement=index.prepare(keys,records.map { ArenaChunk(it.key,it.handle,0,it.bytes) })
        if(!placement.placesLike(packet.placement,keys)) throw OverlayArenaMoved()
        val nextMetadata=HashMap(metadata)
        placement.removed.forEach { nextMetadata.remove(it.key) }
        nextMetadata.putAll(packet.acquired)
        current()
        val buffers=IntArray(3)
        val target=if(placement.replacement) PacketArena(0,placement.capacity).apply {
            buffer=OverlayRenderer.allocatePacketBuffer(placement.capacity);OverlayPacketMetrics.replaced()
        } else arena?:error("Missing resident arena")
        var resources=0;var copied=0;var touched=false;var committed=false
        var pinned: Long?=null;var adopted: PacketHandle?=null;var sessionRetained=false;var arenaRetained=false
        val uploading=System.nanoTime()
        var gpuWork=false
        try {
            if(!idle) {
                gpuWork=true
                encoded.useBuffer(1) { bytes->for((slot,scene) in description.scenes.withIndex()) { val part=bytes.duplicate();part.position(scene.offset);part.limit(scene.offset+scene.bytes);buffers[slot]=OverlayRenderer.uploadPacketBuffer(part.slice()) } }
                resources=encoded.useBuffer(2) { OverlayRenderer.uploadPacketBuffer(it) }
            }
            if(placement.replacement) arena?.let { old ->
                gpuWork=true
                GLES31.glBindBuffer(GLES31.GL_COPY_READ_BUFFER,old.buffer);GLES31.glBindBuffer(GLES31.GL_COPY_WRITE_BUFFER,target.buffer)
                for(copy in placement.copies) { GLES31.glCopyBufferSubData(GLES31.GL_COPY_READ_BUFFER,GLES31.GL_COPY_WRITE_BUFFER,copy.source,copy.destination,copy.bytes);copied+=copy.bytes }
                OverlayRenderer.checkPacketGL();OverlayPacketMetrics.copied(copied,idle)
            }
            packet.chunks.useBuffer(1) { bytes ->
                GLES31.glBindBuffer(GLES31.GL_SHADER_STORAGE_BUFFER,target.buffer)
                for(record in records) if(record.bytes>0) {
                    current();gpuWork=true;val part=bytes.duplicate();part.position(record.source);part.limit(record.source+record.bytes)
                    touched=!placement.replacement
                    GLES31.glBufferSubData(GLES31.GL_SHADER_STORAGE_BUFFER,placement.records.getValue(record.key).offset,record.bytes,part.slice())
                    OverlayPacketMetrics.uploaded(record.bytes,idle);OverlayRenderer.checkPacketGL()
                }
            }
            current();index.commit(placement);committed=true
            if(placement.replacement) { arena?.let(::releaseArena);arena=target }
            val previousMetadata=metadata;metadata=nextMetadata;packet.acquired.clear()
            placement.removed.forEach { previousMetadata[it.key]?.close() }
            val epoch=index.retain(keys)
            if(idle) { index.release(keys,epoch);return null }
            pinned=epoch
            val handle=PacketHandle(0);adopted=handle;handle.id=encoded.takeHandle().also { check(it!=0L) { "Packet already uploaded" } }
            session.retain();sessionRetained=true
            target.users++;arenaRetained=true
            return UploadedPacket(handle,session,description,buffers,resources,target,keys,epoch,
                (System.nanoTime()-started)/1e6,if(pixelBytes==0 && copied==0)0.0 else (System.nanoTime()-uploading)/1e6,pixelBytes,copied,keys.sumOf { placement.records.getValue(it).bytes },
                packet.lookScenes)
        } catch(failure: Throwable) {
            adopted?.close();if(sessionRetained)session.close();if(arenaRetained)releaseArena(target)
            pinned?.let { index.release(keys,it) }
            buffers.forEach { OverlayRenderer.deletePacketBuffer(it) };OverlayRenderer.deletePacketBuffer(resources)
            if(!committed && placement.replacement)releaseArena(target)
            if(touched && !committed) index.discardTouchedOptional(placement).forEach { metadata.remove(it.key)?.close() }
            throw failure
        } finally { if(gpuWork)OverlayRenderer.trackPacketUploads() }
    }
}


internal fun packetResourceStats(): Map<String,Any?> {
    val before=OverlayPacketMetrics.snapshot()
    val rust=GpuPacketBridge.stats().use { output -> packetStatus(output.status);output.json(maximum=16384) }
    require(rust.packetInt("version")==1 && rust.getBoolean("available"))
    val after=OverlayPacketMetrics.snapshot()
    fun objectMap(root: JSONObject): Map<String,Any?> = root.keys().asSequence().associateWith { root.get(it) }
    return after+mapOf("statsVersion" to 1,"rust" to objectMap(rust),
        "drained" to packetStatsDrained(before["nativeActivityEpoch"] as Long,after["nativeActivityEpoch"] as Long,
            after["pendingNativeJobs"] as Int,after["pendingGpuCommands"] as Int,rust.getBoolean("drained")))
}
