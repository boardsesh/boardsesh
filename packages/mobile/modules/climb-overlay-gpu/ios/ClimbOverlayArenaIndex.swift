import Foundation

/// Placement/LRU bookkeeping only. Pixel/descriptor/uniform bytes belong to Rust.
/// The renderer serial queue owns this index; GPU generations own real buffers.
enum ClimbOverlayArenaFailure: Error { case invalid, pressure, stale }

struct ClimbOverlayChunkRecord: Equatable {
  let key: String
  let handle: UInt64
  var offset: Int
  let bytes: Int
  var pins: Int = 0
  var used: UInt64 = 0
  var retainedCost: Int { bytes+key.utf8.count+256 }
}

struct ClimbOverlayArenaPlan {
  let revision: UInt64
  let capacity: Int
  let replacement: Bool
  let records: [String: ClimbOverlayChunkRecord]
  let removed: [ClimbOverlayChunkRecord]
  let copies: [(source: Int, destination: Int, bytes: Int)]
}

final class ClimbOverlayArenaIndex {
  static let retainedTarget = 32 * 1024 * 1024
  static let entryTarget = 512
  private(set) var capacity = 0
  private(set) var epoch: UInt64 = 0
  private var revision: UInt64 = 0
  private var clock: UInt64 = 0
  private(set) var records: [String: ClimbOverlayChunkRecord] = [:]
  private let limit: Int
  private let target: Int
  private let entriesTarget: Int

  init(limit: Int = ClimbOverlayPacketLayout.maxGpuBytes,
       target: Int = retainedTarget, entriesTarget: Int = entryTarget) {
    self.limit = limit
    self.target = min(target,limit)
    self.entriesTarget = entriesTarget
  }

  func prepare(required: [String], missing: [ClimbOverlayChunkRecord]) throws -> ClimbOverlayArenaPlan {
    let protected = Set(required)
    guard protected.count == required.count,entriesTarget > 0,target > 0 else { throw ClimbOverlayArenaFailure.invalid }
    var next = records
    var newKeys = Set<String>()
    var total = next.values.reduce(0) { $0+$1.bytes }
    var retainedCost = next.values.reduce(0) { $0+$1.retainedCost }
    var missingBytes = 0
    for chunk in missing {
      guard chunk.handle > 0,!chunk.key.isEmpty,chunk.key.utf8.count <= 64,
        chunk.bytes >= 0,chunk.bytes <= limit,chunk.bytes % 4 == 0,
        protected.contains(chunk.key),next[chunk.key] == nil,newKeys.insert(chunk.key).inserted else {
        throw ClimbOverlayArenaFailure.invalid
      }
      guard missingBytes <= limit-chunk.bytes else { throw ClimbOverlayArenaFailure.pressure }
      missingBytes += chunk.bytes
      total += chunk.bytes
      retainedCost += chunk.retainedCost
      next[chunk.key] = ClimbOverlayChunkRecord(key: chunk.key,handle: chunk.handle,offset: 0,bytes: chunk.bytes)
    }
    guard protected.allSatisfy({ next[$0] != nil }) else { throw ClimbOverlayArenaFailure.invalid }
    var removed: [ClimbOverlayChunkRecord] = []
    let optional = records.values.filter { $0.pins == 0 && !protected.contains($0.key) }.sorted {
      $0.used == $1.used ? $0.key < $1.key : $0.used < $1.used
    }
    for chunk in optional where retainedCost > target || next.count > entriesTarget {
      next.removeValue(forKey: chunk.key)
      total -= chunk.bytes
      retainedCost -= chunk.retainedCost
      removed.append(chunk)
    }
    guard total <= limit else { throw ClimbOverlayArenaFailure.pressure }
    var placed = next.filter { !newKeys.contains($0.key) }
    var compact = false
    for key in newKeys.sorted() {
      var chunk = next[key]!
      if let offset = gap(bytes: chunk.bytes,records: placed.values) { chunk.offset = offset }
      else { compact = true }
      placed[key] = chunk
    }
    var end = placed.values.map { $0.offset+$0.bytes }.max() ?? 0
    if (end > target || capacity > target) && total <= target { compact = true }
    if compact {
      var offset = 0
      for key in placed.keys.sorted(by: {
        let left = records[$0]?.offset ?? limit
        let right = records[$1]?.offset ?? limit
        return left == right ? $0 < $1 : left < right
      }) {
        var chunk = placed[key]!
        chunk.offset = chunk.bytes == 0 ? 0 : offset
        placed[key] = chunk
        offset += chunk.bytes
      }
      end = offset
    }
    let needed = try roundedCapacity(end)
    let nextCapacity = compact ? needed : max(capacity,needed)
    let replacement = capacity != nextCapacity || compact
    let copies = replacement ? placed.values.compactMap { chunk -> (Int,Int,Int)? in
      guard chunk.bytes > 0,let previous = records[chunk.key] else { return nil }
      return (previous.offset,chunk.offset,chunk.bytes)
    } : []
    return ClimbOverlayArenaPlan(revision: revision,capacity: nextCapacity,replacement: replacement,
      records: placed,removed: removed,copies: copies)
  }

  func commit(_ plan: ClimbOverlayArenaPlan) throws {
    guard revision == plan.revision else { throw ClimbOverlayArenaFailure.stale }
    guard plan.capacity >= 4,plan.capacity <= limit else { throw ClimbOverlayArenaFailure.invalid }
    let ranges = plan.records.values.filter { $0.bytes > 0 }.sorted { $0.offset < $1.offset }
    for (key,chunk) in plan.records {
      guard key == chunk.key,chunk.handle > 0,chunk.pins >= 0,chunk.offset >= 0,chunk.offset % 4 == 0,
        chunk.bytes >= 0,chunk.bytes % 4 == 0,chunk.offset <= plan.capacity,
        chunk.bytes <= plan.capacity-chunk.offset else { throw ClimbOverlayArenaFailure.invalid }
    }
    for pair in zip(ranges,ranges.dropFirst()) where pair.0.offset+pair.0.bytes > pair.1.offset {
      throw ClimbOverlayArenaFailure.invalid
    }
    records = plan.records
    capacity = plan.capacity
    revision &+= 1
  }

  /// If patching reused ranges fails, their old optional entries are no longer
  /// valid. Pinned entries were excluded from the plan and remain untouched.
  func discardTouchedOptional(_ plan: ClimbOverlayArenaPlan) throws -> [ClimbOverlayChunkRecord] {
    guard revision == plan.revision else { throw ClimbOverlayArenaFailure.stale }
    for chunk in plan.removed { records.removeValue(forKey: chunk.key) }
    revision &+= 1
    return plan.removed
  }

  func retain(_ keys: [String]) throws -> UInt64 {
    guard Set(keys).count == keys.count,keys.allSatisfy({ records[$0] != nil }) else { throw ClimbOverlayArenaFailure.invalid }
    clock &+= 1
    for key in keys { records[key]!.pins += 1; records[key]!.used = clock }
    revision &+= 1
    return epoch
  }

  func release(_ keys: [String], epoch expected: UInt64) throws {
    if expected != epoch { return } // A destroyed GPU context invalidated these ranges.
    guard Set(keys).count == keys.count,keys.allSatisfy({ (records[$0]?.pins ?? 0) > 0 }) else { throw ClimbOverlayArenaFailure.invalid }
    for key in keys { records[key]!.pins -= 1 }
    revision &+= 1
  }

  func reset() -> [ClimbOverlayChunkRecord] {
    let removed = Array(records.values)
    records.removeAll()
    capacity = 0
    epoch &+= 1
    revision &+= 1
    return removed
  }

  private func gap<S: Sequence>(bytes: Int, records: S) -> Int? where S.Element == ClimbOverlayChunkRecord {
    if bytes == 0 { return 0 }
    var cursor = 0
    for chunk in records.filter({ $0.bytes > 0 }).sorted(by: { $0.offset < $1.offset }) {
      if chunk.offset-cursor >= bytes { return cursor }
      cursor = max(cursor,chunk.offset+chunk.bytes)
    }
    return cursor <= limit-bytes ? cursor : nil
  }

  private func roundedCapacity(_ bytes: Int) throws -> Int {
    guard bytes >= 0,bytes <= limit else { throw ClimbOverlayArenaFailure.pressure }
    if bytes == 0 { return 4 }
    var rounded = min(64 * 1024,limit)
    while rounded < bytes {
      guard rounded <= limit/2 else { return limit }
      rounded *= 2
    }
    return rounded
  }
}
