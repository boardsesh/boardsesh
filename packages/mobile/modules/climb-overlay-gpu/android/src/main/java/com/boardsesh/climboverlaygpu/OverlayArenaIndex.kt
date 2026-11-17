package com.boardsesh.climboverlaygpu

/** Placement/LRU only. Rust owns all raster/descriptor/uniform bytes. */
internal data class ArenaChunk(
    val key: String,
    val handle: Long,
    val offset: Int,
    val bytes: Int,
    val pins: Int = 0,
    val used: Long = 0,
) {
    val retainedCost get() = bytes.toLong() + key.length + 256
}

internal data class ArenaCopy(val source: Int, val destination: Int, val bytes: Int)
internal data class ArenaPlan(
    val revision: Long,
    val capacity: Int,
    val replacement: Boolean,
    val records: Map<String, ArenaChunk>,
    val removed: List<ArenaChunk>,
    val copies: List<ArenaCopy>,
) {
    /** Encoded descriptors depend only on the arena size and these keys' ranges. */
    fun placesLike(other: ArenaPlan, keys: List<String>): Boolean =
        capacity == other.capacity && keys.all { key ->
            val mine = records[key]
            val theirs = other.records[key]
            mine != null && theirs != null && mine.offset == theirs.offset && mine.bytes == theirs.bytes
        }
}

internal class OverlayArenaIndex(
    private val limit: Int = OverlayPacketLayout.MAX_GPU_BYTES,
    private val target: Int = minOf(32 * 1024 * 1024, limit),
    private val entryTarget: Int = 512,
) {
    var capacity = 0
        private set
    var epoch = 0L
        private set
    private var revision = 0L
    private var clock = 0L
    var records: Map<String, ArenaChunk> = emptyMap()
        private set

    /**
     * A detached copy a worker can plan against while the render thread keeps
     * changing this one. Record maps are replaced, never mutated, so it shares them.
     */
    fun lend(): OverlayArenaIndex =
        OverlayArenaIndex(limit, target, entryTarget).also { copy ->
            copy.capacity = capacity
            copy.epoch = epoch
            copy.revision = revision
            copy.clock = clock
            copy.records = records
        }

    fun prepare(required: List<String>, missing: List<ArenaChunk>): ArenaPlan {
        val protected = required.toSet()
        require(protected.size == required.size && target > 0 && entryTarget > 0)
        val next = records.toMutableMap()
        val newKeys = LinkedHashSet<String>()
        var total = next.values.sumOf { it.bytes.toLong() }
        var retainedCost = next.values.sumOf { it.retainedCost }
        var missingBytes = 0
        for (chunk in missing) {
            require(chunk.handle > 0 && chunk.key.isNotEmpty() && chunk.key.toByteArray(Charsets.UTF_8).size <= 64 &&
                chunk.bytes in 0..limit && chunk.bytes % 4 == 0 &&
                chunk.key in protected && chunk.key !in next && newKeys.add(chunk.key))
            if (missingBytes > limit - chunk.bytes) throw OverlayResourceFailure()
            missingBytes += chunk.bytes
            total += chunk.bytes
            retainedCost += chunk.retainedCost
            next[chunk.key] = chunk.copy(offset = 0, pins = 0, used = 0)
        }
        require(protected.all { it in next })
        val removed = ArrayList<ArenaChunk>()
        val optional = records.values.filter { it.pins == 0 && it.key !in protected }
            .sortedWith(compareBy<ArenaChunk> { it.used }.thenBy { it.key })
        for (chunk in optional) {
            if (retainedCost <= target && next.size <= entryTarget) break
            next.remove(chunk.key)
            total -= chunk.bytes
            retainedCost -= chunk.retainedCost
            removed.add(chunk)
        }
        if (total > limit) throw OverlayResourceFailure()
        val placed = next.filterKeys { it !in newKeys }.toMutableMap()
        var compact = false
        for (key in newKeys.sorted()) {
            val chunk = next.getValue(key)
            val offset = gap(chunk.bytes, placed.values)
            if (offset == null) compact = true
            placed[key] = chunk.copy(offset = offset ?: 0)
        }
        var end = placed.values.maxOfOrNull { it.offset + it.bytes } ?: 0
        if ((end > target || capacity > target) && total <= target) compact = true
        if (compact) {
            var offset = 0
            val order = placed.keys.sortedWith(compareBy<String> { records[it]?.offset ?: limit }.thenBy { it })
            for (key in order) {
                val chunk = placed.getValue(key)
                placed[key] = chunk.copy(offset = if (chunk.bytes == 0) 0 else offset)
                offset += chunk.bytes
            }
            end = offset
        }
        val needed = roundedCapacity(end)
        val nextCapacity = if (compact) needed else maxOf(capacity, needed)
        val replacement = nextCapacity != capacity || compact
        val copies = if (replacement) placed.values.mapNotNull { chunk ->
            records[chunk.key]?.takeIf { chunk.bytes > 0 }?.let { previous ->
                ArenaCopy(previous.offset, chunk.offset, chunk.bytes)
            }
        } else emptyList()
        return ArenaPlan(revision, nextCapacity, replacement, placed, removed, copies)
    }

    fun commit(plan: ArenaPlan) {
        check(plan.revision == revision) { "Stale arena plan" }
        require(plan.capacity in 4..limit)
        for ((key, chunk) in plan.records) require(key == chunk.key && chunk.handle > 0 && chunk.pins >= 0 &&
            chunk.offset >= 0 && chunk.offset % 4 == 0 && chunk.bytes >= 0 && chunk.bytes % 4 == 0 &&
            chunk.offset <= plan.capacity && chunk.bytes <= plan.capacity - chunk.offset)
        val ranges = plan.records.values.filter { it.bytes > 0 }.sortedBy { it.offset }
        require(ranges.zipWithNext().all { (left, right) -> left.offset + left.bytes <= right.offset })
        records = plan.records
        capacity = plan.capacity
        revision++
    }

    fun discardTouchedOptional(plan: ArenaPlan): List<ArenaChunk> {
        check(plan.revision == revision)
        records = records - plan.removed.map { it.key }.toSet()
        revision++
        return plan.removed
    }

    fun retain(keys: List<String>): Long {
        require(keys.toSet().size == keys.size && keys.all { it in records })
        clock++
        val next = records.toMutableMap()
        for (key in keys) next[key] = next.getValue(key).let { it.copy(pins = it.pins + 1, used = clock) }
        records = next
        revision++
        return epoch
    }

    fun release(keys: List<String>, expectedEpoch: Long) {
        if (expectedEpoch != epoch) return
        require(keys.toSet().size == keys.size && keys.all { (records[it]?.pins ?: 0) > 0 })
        val next = records.toMutableMap()
        for (key in keys) next[key] = next.getValue(key).let { it.copy(pins = it.pins - 1) }
        records = next
        revision++
    }

    fun reset(): List<ArenaChunk> {
        val removed = records.values.toList()
        records = emptyMap()
        capacity = 0
        epoch++
        revision++
        return removed
    }

    private fun gap(bytes: Int, chunks: Collection<ArenaChunk>): Int? {
        if (bytes == 0) return 0
        var cursor = 0
        for (chunk in chunks.filter { it.bytes > 0 }.sortedBy { it.offset }) {
            if (chunk.offset - cursor >= bytes) return cursor
            cursor = maxOf(cursor, chunk.offset + chunk.bytes)
        }
        return if (cursor <= limit - bytes) cursor else null
    }

    private fun roundedCapacity(bytes: Int): Int {
        if (bytes !in 0..limit) throw OverlayResourceFailure()
        if (bytes == 0) return 4
        var rounded = minOf(64 * 1024, limit)
        while (rounded < bytes) {
            if (rounded > limit / 2) return limit
            rounded *= 2
        }
        return rounded
    }
}
