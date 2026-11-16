import Foundation

/// Pure motion policy, shared by the native view and its standalone tests.
enum ClimbOverlayMotion {
  static let editDuration: Double = 0.350
  static let editPeakTime: Double = 0.100
  // Must match the immutable Rust GPU atlas padding reserve.
  static let editPeakReach: Float = 1.35
  static let revealBand: Float = 0.22

  /// Bits follow the shader's fill, plate, glyph and annotation layer order.
  /// Missing first passes do not imply that later paint passes are absent.
  static func stampLayers(offsets: SIMD4<UInt32>, extraOffsets: SIMD4<UInt32>,
                          annotation: Bool) -> UInt32 {
    let glyph = offsets.w != .max || extraOffsets.w != .max
    if annotation { return glyph ? 8 : 0 }
    let fill = offsets.y != .max || extraOffsets.x != .max ||
      extraOffsets.y != .max || extraOffsets.z != .max
    return (fill ? 1 : 0) | (offsets.z != .max ? 2 : 0) | (glyph ? 4 : 0)
  }

  static func selectStampLayers(lower: UInt32, upper: UInt32, progress: Float) -> UInt32 {
    if progress <= 0 { return lower }
    if progress >= 1 { return upper }
    return lower | upper
  }

  struct Selection {
    let lowerOffset: Int
    let upperOffset: Int
    let progress: Float
  }

  static func select(pagePosition: Double, centerPage: Double, hasPrevious: Bool,
                     hasNext: Bool, reduceMotion: Bool) -> Selection {
    guard !reduceMotion, pagePosition.isFinite, centerPage.isFinite else {
      return Selection(lowerOffset: 0,upperOffset: 0,progress: 0)
    }
    let delta = min(1,max(-1,pagePosition-centerPage))
    if delta < 0 && hasPrevious {
      return Selection(lowerOffset: -1,upperOffset: 0,progress: Float(1+delta))
    }
    if delta > 0 && hasNext {
      return Selection(lowerOffset: 0,upperOffset: 1,progress: Float(delta))
    }
    return Selection(lowerOffset: 0,upperOffset: 0,progress: 0)
  }

  /// Progress at one whole hold's screen-space centre. The incoming upper
  /// page starts on the right; reducing progress reverses the same wave.
  static func revealProgress(_ progress: Float, centerX: Float, mirrored: Bool) -> Float {
    let progress = min(1, max(0, progress.isFinite ? progress : 0))
    if progress == 0 { return 0 }
    if progress == 1 { return 1 }
    let center = min(1,max(0,centerX.isFinite ? centerX : 0))
    let screenCenter = mirrored ? 1-center : center
    let halfBand = revealBand * 0.5
    let boundary = 1+halfBand-progress*(1+2*halfBand)
    let position = min(1,max(0,(screenCenter-(boundary-halfBand))/revealBand))
    return position*position*(3-2*position)
  }

  /// Membership: 0 unique, 1 shared same role, 2 shared changed role.
  static func holdWeight(reveal: Float, membership: Int, upper: Bool) -> Float {
    if membership == 1 { return upper ? 0 : 1 }
    if membership == 2 { return upper ? max(2*reveal-1,0) : max(1-2*reveal,0) }
    return upper ? reveal : 1-reveal
  }

  static func ownershipDistance(distance: Float, reach: Float, weight: Float) -> Float {
    guard weight > 0 else { return .infinity }
    return distance+reach*(1-weight)/max(weight,0.0001)
  }

  static func mergeDistance(actualNearest: Float, nearestScore: Float, runnerScore: Float) -> Float {
    actualNearest+max(runnerScore-nearestScore,0)
  }

  /// Only the glow reach changes; the normal frame is shown before expansion.
  static func editReachScale(elapsed: Double) -> Float {
    guard elapsed.isFinite, elapsed >= 0, elapsed < editDuration else { return 1 }
    let phase = elapsed <= editPeakTime
      ? elapsed / editPeakTime
      : (editDuration - elapsed) / (editDuration - editPeakTime)
    let progress = Float(phase)
    let eased = progress * progress * (3 - 2 * progress)
    return 1 + (editPeakReach - 1) * eased
  }

  /// The first accepted drawable starts the clock, not CPU preparation.
  /// The view fences presentation by request/revision before calling present.
  struct EditorPulse {
    private(set) var pending = false
    private(set) var started: Double?

    mutating func schedule() { cancel(); pending = true }
    mutating func cancel() { pending = false; started = nil }
    mutating func present(at time: Double) -> Bool {
      guard pending, time.isFinite else { return false }
      pending = false
      started = time
      return true
    }
    func reachScale(at time: Double) -> Float {
      started.map { editReachScale(elapsed: time - $0) } ?? 1
    }
  }
}
