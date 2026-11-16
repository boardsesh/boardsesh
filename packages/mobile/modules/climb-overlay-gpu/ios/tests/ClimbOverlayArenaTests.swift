import Foundation

@main enum ClimbOverlayArenaTests {
  static func main() throws {
    let unit = 1024
    func chunk(_ key: String,_ handle: UInt64,_ bytes: Int) -> ClimbOverlayChunkRecord {
      ClimbOverlayChunkRecord(key: key,handle: handle,offset: 0,bytes: bytes)
    }
    func rejected(_ action: () throws -> Void) {
      do { try action(); preconditionFailure("Invalid/stale arena operation accepted") } catch {}
    }
    let cache = ClimbOverlayArenaIndex(limit: 2 * 1024 * 1024,target: 256 * unit)
    let initial = try cache.prepare(required: ["af","ar","bf","br"],missing: [
      chunk("af",1,64*unit),chunk("ar",2,4*unit),chunk("bf",3,64*unit),chunk("br",4,4*unit)])
    try cache.commit(initial)
    let epoch = try cache.retain(["af","ar","bf","br"])
    let before = cache.records
    let rotation = try cache.prepare(required: ["br","bf","ar","af"],missing: [])
    precondition(!rotation.replacement && rotation.copies.isEmpty)
    precondition(rotation.records == before,"Trio rotation changes no resident pixel placement")
    try cache.commit(rotation)
    let addOne = try cache.prepare(required: ["af","ar","bf","br","cf","cr"],missing: [chunk("cf",5,64*unit),chunk("cr",6,4*unit)])
    precondition(!addOne.replacement && addOne.copies.isEmpty,"A spare arena range avoids a full-set upload")
    for key in before.keys { precondition(addOne.records[key]?.offset == before[key]?.offset) }
    precondition(addOne.records["cf"]!.bytes+addOne.records["cr"]!.bytes == 68*unit,"Only the new hold's field/role chunks transfer")
    try cache.commit(addOne)
    try cache.release(["af","ar","bf","br"],epoch: epoch)

    // An optional hole is too short. Compaction creates a NEW GPU generation;
    // old command/scene bytes retain their old offsets until their lease ends.
    let fragmented = ClimbOverlayArenaIndex(limit: 2*1024*1024,target: 256*unit)
    try fragmented.commit(fragmented.prepare(required: ["a","b","c"],missing: [chunk("a",11,64*unit),chunk("b",12,64*unit),chunk("c",13,64*unit)]))
    let oldEpoch = try fragmented.retain(["a","c"])
    let oldRecords = fragmented.records
    let oldPixels = oldRecords.values.reduce(into: [UInt8](repeating: 0,count: fragmented.capacity)) { bytes,record in
      bytes.replaceSubrange(record.offset..<record.offset+record.bytes,with: repeatElement(UInt8(record.handle),count: record.bytes))
    }
    let compact = try fragmented.prepare(required: ["a","c","d"],missing: [chunk("d",14,96*unit)])
    precondition(compact.replacement && compact.removed.map(\.key) == ["b"])
    precondition(compact.records["c"]!.offset != oldRecords["c"]!.offset)
    var newPixels = [UInt8](repeating: 0,count: compact.capacity)
    for copy in compact.copies {
      newPixels.replaceSubrange(copy.destination..<copy.destination+copy.bytes,with: oldPixels[copy.source..<copy.source+copy.bytes])
    }
    precondition(oldPixels[oldRecords["c"]!.offset] == 13)
    precondition(newPixels[compact.records["c"]!.offset] == 13)
    try fragmented.commit(compact)
    _ = try fragmented.retain(["c","d"])
    try fragmented.release(["a","c"],epoch: oldEpoch)
    precondition(fragmented.records["c"]!.pins == 1,"Old and new generations share per-chunk pins")
    let next = try fragmented.prepare(required: ["d","e"],missing: [chunk("e",15,96*unit)])
    precondition(next.records["c"] != nil,"A mounted/in-flight chunk cannot be evicted")
    let stale = try fragmented.prepare(required: ["d"],missing: [])
    _ = try fragmented.retain(["d"])
    rejected { try fragmented.commit(stale) }
    let staleEpoch = fragmented.epoch
    _ = fragmented.reset()
    try fragmented.commit(fragmented.prepare(required: ["c"],missing: [chunk("c",21,4)]))
    _ = try fragmented.retain(["c"])
    try fragmented.release(["c"],epoch: staleEpoch)
    precondition(fragmented.records["c"]!.pins == 1,"Old-context cleanup cannot unpin new residency")
    rejected { _ = try fragmented.prepare(required: ["x"],missing: [chunk("x",22,3)]) }
    rejected { _ = try fragmented.prepare(required: ["x","x"],missing: [chunk("x",22,4)]) }

    let shrinking = ClimbOverlayArenaIndex(limit: 2*1024*1024,target: 64*unit)
    try shrinking.commit(shrinking.prepare(required: ["large"],missing: [chunk("large",40,128*unit)]))
    let small = try shrinking.prepare(required: ["small"],missing: [chunk("small",41,4*unit)])
    precondition(small.replacement && small.capacity == 64*unit && small.removed.map(\.key) == ["large"],
      "After an oversized selected set ends, the retained GPU allocation shrinks with the LRU")
    let zero = ClimbOverlayArenaIndex()
    try zero.commit(zero.prepare(required: ["empty-role"],missing: [chunk("empty-role",30,0)]))
    precondition(zero.capacity == 4 && zero.records["empty-role"]?.bytes == 0)
    let bounded = ClimbOverlayArenaIndex(entriesTarget: 16)
    for item in 0..<1000 {
      let key = "zero-\(item)"
      try bounded.commit(bounded.prepare(required: [key],missing: [chunk(key,UInt64(item+100),0)]))
      precondition(bounded.records.count <= 16,"Zero-byte role metadata must evict")
    }
    precondition(bounded.records["zero-0"] == nil && bounded.records["zero-999"] != nil)
    print("Swift arena: resident rotation/new-hold-only, pinned compaction, context epochs and invalid ranges passed")
  }
}
