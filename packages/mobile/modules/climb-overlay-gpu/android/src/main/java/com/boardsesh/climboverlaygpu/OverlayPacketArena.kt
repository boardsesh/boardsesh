package com.boardsesh.climboverlaygpu

import android.content.Context
import android.opengl.GLES31
import com.boardsesh.boardrenderer.GpuPacketBridge
import java.io.Closeable
import java.nio.ByteBuffer
import org.json.JSONArray
import org.json.JSONObject

internal class PacketArena(var buffer: Int,val capacity: Int) { var users=1 }
internal class UploadedPacket(val handle: PacketHandle,val session: PacketRustSession,val header: PacketHeader,
    val descriptors: IntArray,val resources: Int,val arena: PacketArena,val keys: List<String>,val epoch: Long,
    val prepareMs: Double,val uploadMs: Double,val uploadBytes: Int,val copyBytes: Int,val selectedBytes: Int) {
    private val uniformBytes=directBytes(OverlayPacketLayout.UNIFORM_BYTES)
    var retired=false
    val hit get()=uploadBytes==0 && copyBytes==0
    fun uniforms(lower: Int,upper: Int,progress: Float,pulse: Float,production: Boolean,mirrored: Boolean): ByteBuffer {
        val bytes=uniformBytes.apply { clear() }
        packetStatus(GpuPacketBridge.encodeUniforms(handle.id,lower,upper,progress,pulse,header.width.toFloat(),header.height.toFloat(),production,mirrored,bytes,bytes.capacity()))
        return bytes
    }
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
/** One EGL thread owns placement and GL mutation; old generations remain fence-pinned. */
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
    fun prepare(session: PacketRustSession,request: String,cancel: PacketCancellation,valid: ()->Boolean,idle: Boolean=false): UploadedPacket? {
        val started=System.nanoTime();collect()
        fun current() { if(!valid()) { cancel.cancel();throw OverlayWorkCancelled() } }
        current()
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
            val resident=JSONObject().put("chunks",JSONArray(keys.mapNotNull { metadata[it]?.id })).toString()
            val lease=PacketHandle(0);lease.id=plan.takeHandle()
            lease.use { planLease ->
                GpuPacketBridge.prepare(planLease.id,resident,cancel.id).use { chunks ->
                    packetStatus(chunks.status)
                    val missing=chunks.json(maximum=256*1024)
                    val pixelBytes=chunks.useBuffer(1) { it.remaining() }
                    require(missing.packetInt("version")==OverlayPacketLayout.PACKET_VERSION && missing.packetInt("pixelBytes")==pixelBytes && pixelBytes<=OverlayPacketLayout.MAX_GPU_BYTES)
                    val rows=missing.getJSONArray("chunks");require(rows.length()<=769)
                    data class Missing(val key: String,val handle: Long,val bytes: Int,val source: Int)
                    val records=(0 until rows.length()).map { ordinal->val entry=rows.getJSONObject(ordinal)
                        Missing(entry.getString("key"),entry.packetLong("handle"),entry.packetInt("bytes"),entry.packetInt("sourceOffset")) }
                    val acquired=HashMap<String,PacketHandle>()
                    try {
                        for(record in records) {
                            require(record.key in keys && record.key !in metadata && record.key !in acquired && record.bytes%4==0 && record.source%4==0 && record.source<=pixelBytes && record.bytes<=pixelBytes-record.source)
                            val lease=PacketHandle(0)
                            try { lease.id=chunks.takeMetadata(record.handle);acquired[record.key]=lease }
                            catch(failure: Throwable) { lease.close();throw failure }
                        }
                        val placement=index.prepare(keys,records.map { ArenaChunk(it.key,it.handle,0,it.bytes) })
                        val nextMetadata=HashMap(metadata)
                        placement.removed.forEach { nextMetadata.remove(it.key) }
                        nextMetadata.putAll(acquired)
                        if(idle && records.isNotEmpty() && placement.capacity>32*1024*1024) throw OverlayWorkCancelled()
                        val placements=JSONObject().put("arena_bytes",placement.capacity).put("chunks",JSONArray().apply {
                            for(key in keys) { val item=placement.records.getValue(key);put(JSONObject().put("key",key).put("offset",item.offset).put("bytes",item.bytes)) }
                        }).toString()
                        GpuPacketBridge.encode(planLease.id,placements,cancel.id).use { encoded ->
                            packetStatus(encoded.status)
                            val description=PacketHeader.parse(encoded.json(maximum=65536),encoded.useBuffer(1){it.remaining()},encoded.useBuffer(2){it.remaining()})
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
                                chunks.useBuffer(1) { bytes ->
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
                                val previousMetadata=metadata;metadata=nextMetadata
                                placement.removed.forEach { previousMetadata[it.key]?.close() }
                                acquired.clear()
                                val epoch=index.retain(keys)
                                if(idle) { index.release(keys,epoch);return null }
                                pinned=epoch
                                val handle=PacketHandle(0);adopted=handle;handle.id=encoded.takeHandle()
                                session.retain();sessionRetained=true
                                target.users++;arenaRetained=true
                                return UploadedPacket(handle,session,description,buffers,resources,target,keys,epoch,
                                    (System.nanoTime()-started)/1e6,if(pixelBytes==0 && copied==0)0.0 else (System.nanoTime()-uploading)/1e6,pixelBytes,copied,keys.sumOf { placement.records.getValue(it).bytes })
                            } catch(failure: Throwable) {
                                adopted?.close();if(sessionRetained)session.close();if(arenaRetained)releaseArena(target)
                                pinned?.let { index.release(keys,it) }
                                buffers.forEach { OverlayRenderer.deletePacketBuffer(it) };OverlayRenderer.deletePacketBuffer(resources)
                                if(!committed && placement.replacement)releaseArena(target)
                                if(touched && !committed) index.discardTouchedOptional(placement).forEach { metadata.remove(it.key)?.close() }
                                throw failure
                            } finally { if(gpuWork)OverlayRenderer.trackPacketUploads() }
                        }
                    } finally { acquired.values.forEach { it.close() } }
                }
            }
        }
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
