package com.boardsesh.climboverlaygpu

import android.content.Context
import com.boardsesh.boardrenderer.GpuPacketBridge
import com.boardsesh.boardrenderer.GpuPacketOutput
import java.io.Closeable
import java.io.File
import java.nio.ByteBuffer
import java.security.MessageDigest
import org.json.JSONArray
import org.json.JSONObject

internal class PacketFailure(val reason: String,val scope: String): RuntimeException(reason)
internal fun packetStatus(status: Int,static: Boolean = false) {
    when (status) {
        OverlayPacketLayout.STATUSES_SUCCESS -> return
        OverlayPacketLayout.STATUSES_CANCELLED,OverlayPacketLayout.STATUSES_CLOSED -> throw OverlayWorkCancelled()
        OverlayPacketLayout.STATUSES_RESOURCE_PRESSURE -> throw PacketFailure("gpu-resource-limit","context")
        OverlayPacketLayout.STATUSES_INTERNAL_PANIC -> throw PacketFailure("gpu-internal-failure","context")
        else -> throw PacketFailure(if (static) "gpu-config-unsupported" else "frame-packet-invalid",if (static) "static" else "frame")
    }
}
private fun packetInteger(raw: Any): Long = when(raw) {
    is Byte -> raw.toLong()
    is Short -> raw.toLong()
    is Int -> raw.toLong()
    is Long -> raw
    else -> throw IllegalArgumentException("Invalid native packet integer")
}
internal fun JSONObject.packetInt(key: String): Int {
    val integer=packetInteger(get(key));require(integer in 0..Int.MAX_VALUE.toLong());return integer.toInt()
}
internal fun JSONObject.packetLong(key: String): Long = packetInteger(get(key)).also { require(it>0) }
internal fun JSONArray.packetUInt32(index: Int): Long = packetInteger(get(index)).also { require(it in 0..0xffffffffL) }
internal fun JSONArray.packetBoolean(index: Int): Boolean = get(index).also { require(it is Boolean) } as Boolean
internal fun GpuPacketOutput.json(index: Int = 0,maximum: Int): JSONObject = useBuffer(index) {
    require(it.remaining() in 1..maximum)
    val bytes = ByteArray(it.remaining());it.get(bytes);JSONObject(String(bytes,Charsets.UTF_8))
}
internal class PacketHandle(@Volatile var id: Long): Closeable {
    override fun close() { val handle = id;id = 0;if (handle != 0L) GpuPacketBridge.closeHandle(handle) }
}
internal class PacketCancellation: Closeable {
    private val handle=PacketHandle(0)
    init { val result = GpuPacketBridge.createCancel();packetStatus(result[0].toInt());handle.id=result[1] }
    val id get() = handle.id
    /** Set before Rust is told, so a CANCELLED status always finds it set. CLOSED never sets it. */
    @Volatile var cancelled=false
        private set
    fun cancel() { cancelled=true;GpuPacketBridge.cancel(id) }
    override fun close() = handle.close()
}
internal object PacketContract {
    val valid: Boolean by lazy {
        if (GpuPacketBridge.packetApiVersion() != OverlayPacketLayout.PACKET_VERSION) throw PacketFailure("gpu-contract-unsupported","static")
        GpuPacketBridge.contract().use { output ->
            packetStatus(output.status,true)
            val digest = output.useBuffer(0) {
                require(it.remaining() in 1..65536)
                MessageDigest.getInstance("SHA-256").apply { update(it) }.digest().joinToString("") { byte -> "%02x".format(byte) }
            }
            if (digest != OverlayPacketLayout.CONTRACT_SHA256) throw PacketFailure("gpu-contract-unsupported","static")
        }
        true
    }
}
internal class PacketRustSession(val source: String,app: Context,cancel: PacketCancellation): Closeable {
    val handle=PacketHandle(0)
    private var references=1
    fun retain(): PacketRustSession { check(references>0);references++;return this }
    init {
        check(PacketContract.valid)
        val result = GpuPacketBridge.createSession(source,cancel.id)
        packetStatus(result[0].toInt(),true);handle.id=result[1]
        try {
            GpuPacketBridge.setCacheDirectory(handle.id,File(app.cacheDir,"aura-lazy-v1").absolutePath.toByteArray(Charsets.UTF_8))
        } catch(failure: Throwable) { handle.close();throw failure }
    }
    fun persistAfterReady() { GpuPacketBridge.schedulePersist(handle.id) }
    override fun close() { check(references>0);references--;if(references==0)handle.close() }
}
internal data class PacketScene(val offset: Int,val bytes: Int,val count: Int,val layers: Int,val directory: Int)
internal data class PacketHeader(val width: Int,val height: Int,val scenes: List<PacketScene>,val present: List<Boolean>,
    val roles: Map<Long,Long>,val changed: Int) {
    companion object {
        fun parse(root: JSONObject,descriptors: Int,resources: Int): PacketHeader {
            require(root.packetInt("version") == OverlayPacketLayout.PACKET_VERSION && root.getString("contractSha256") == OverlayPacketLayout.CONTRACT_SHA256)
            val width=root.packetInt("width");val height=root.packetInt("height")
            require(width in 1..1536 && height in 1..2304)
            val columns=(width+OverlayPacketLayout.TILE_EDGE-1)/OverlayPacketLayout.TILE_EDGE
            val rows=(height+OverlayPacketLayout.TILE_EDGE-1)/OverlayPacketLayout.TILE_EDGE
            require(root.packetInt("columns")==columns && root.packetInt("tileEdge")==OverlayPacketLayout.TILE_EDGE &&
                root.packetInt("descriptorBytes")==OverlayPacketLayout.DESCRIPTOR_BYTES && root.packetInt("uniformBytes")==OverlayPacketLayout.UNIFORM_BYTES)
            require(descriptors<=3*(OverlayPacketLayout.MAX_ACTIVE_PER_SOURCE+1)*OverlayPacketLayout.DESCRIPTOR_BYTES && resources in OverlayPacketLayout.LUT_WORDS*4..8*1024*1024 && resources%4==0)
            val values=root.getJSONArray("scenes");require(values.length()==3)
            val scenes=(0..2).map { slot -> val item=values.getJSONObject(slot)
                val offset=item.packetInt("offset");val bytes=item.packetInt("bytes");val count=item.packetInt("count")
                val layers=item.packetInt("stamp_layers");val directory=item.packetInt("tile_directory")
                val reach=item.getDouble("max_reach")
                require(count<=OverlayPacketLayout.MAX_ACTIVE_PER_SOURCE && bytes==maxOf(1,count)*OverlayPacketLayout.DESCRIPTOR_BYTES && offset%16==0 && offset<=descriptors && bytes<=descriptors-offset &&
                    layers<=15 && reach.isFinite() && reach in 0.0..512.0 && directory>=OverlayPacketLayout.LUT_WORDS && directory.toLong()+columns*rows*2L<=resources/4)
                PacketScene(offset,bytes,count,layers,directory)
            }
            val states=root.getJSONArray("present");require(states.length()==3 && states.packetBoolean(0))
            val pairs=root.getJSONArray("current_roles");require(pairs.length()<=scenes[0].count)
            val roles=LinkedHashMap<Long,Long>()
            for (item in 0 until pairs.length()) {
                val pair=pairs.getJSONArray(item);require(pair.length()==2)
                val id=pair.packetUInt32(0);val role=pair.packetUInt32(1);require(id in 0..0xffffffffL && role in 0..0xffffffffL);roles[id]=role
            }
            val changed=root.packetInt("changed_count");require(changed<=scenes[0].count)
            return PacketHeader(width,height,scenes,(0..2).map { states.packetBoolean(it) },roles,changed)
        }
    }
}
internal fun packetSource(current: String?,previous: String?,next: String?,baseline: Map<Long,Long>?): String {
    for (frame in listOfNotNull(current,previous,next)) if (frame.toByteArray(Charsets.UTF_8).size>32768) throw PacketFailure("frame-encoding-too-large","frame")
    return JSONObject().apply {
        put("current",current?:JSONObject.NULL);put("previous",previous?:JSONObject.NULL);put("next",next?:JSONObject.NULL);put("strict",true)
        if (baseline!=null) put("edit_baseline",JSONArray().apply { baseline.toSortedMap().forEach { (id,role)->put(JSONArray(listOf(id,role))) } })
    }.toString()
}

internal fun packetStatsDrained(before: Long,after: Long,nativeJobs: Int,gpuCommands: Int,rustDrained: Boolean)=
    before==after && nativeJobs==0 && gpuCommands==0 && rustDrained
