import Foundation

/// Pure motion policy, shared by the native view and its standalone tests.
enum ClimbOverlayMotion {
  static let editDuration = ClimbOverlayPacketLayout.editDurationSeconds
  static let editPeakTime = ClimbOverlayPacketLayout.editPeakTimeSeconds
  // Must match the immutable Rust GPU atlas padding reserve.
  static let editPeakReach = ClimbOverlayPacketLayout.editPeakReach
  static let revealBand = ClimbOverlayPacketLayout.revealBand
  static let revealModeWipe = ClimbOverlayPacketLayout.revealModeWipe
  static let revealModeSwap = ClimbOverlayPacketLayout.revealModeSwap

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

  /// The app names the reveal; the generated contract numbers it.
  static func revealMode(named name: String?) -> Int { name == "swap" ? revealModeSwap : revealModeWipe }

  /// Scene slot for a page offset from the centre: 0 current, 1 previous, 2 next.
  static func slot(_ offset: Int) -> Int { offset == -1 ? 1 : (offset == 1 ? 2 : 0) }

  /// The wall swap's lower and upper class weights, and the weight of holds lit
  /// with the same role in both (1 keeps them whole, as API 6 drew them).
  struct SwapWeights: Equatable {
    let lower: Float
    let upper: Float
    var shared: Float = 1
  }

  /// In swap mode the app's page position names a pair, not a progress: the
  /// nearest page is the climb being left, and the side it leans to is the
  /// arriving one. The timing lives in the app; only the weights arrive here.
  /// A pair beyond the prepared neighbours shows the nearest prepared climb on
  /// its own, so a lagging scene can never light a third climb.
  static func selectSwap(pagePosition: Double, centerPage: Double, hasPrevious: Bool, hasNext: Bool,
                         outgoing: Float, incoming: Float, shared: Float = 1) -> (Selection, SwapWeights) {
    let still = SwapWeights(lower: 1, upper: 0)
    guard pagePosition.isFinite, centerPage.isFinite else {
      return (Selection(lowerOffset: 0,upperOffset: 0,progress: 0), still)
    }
    let delta = pagePosition-centerPage
    if abs(delta) > 1 {
      let edge = delta > 0 ? (hasNext ? 1 : 0) : (hasPrevious ? -1 : 0)
      return (Selection(lowerOffset: edge,upperOffset: edge,progress: 0), still)
    }
    let selection = select(pagePosition: pagePosition,centerPage: centerPage,hasPrevious: hasPrevious,
      hasNext: hasNext,reduceMotion: false)
    guard selection.lowerOffset != selection.upperOffset else { return (selection, still) }
    let outgoing = min(1,max(0,outgoing.isFinite ? outgoing : 1))
    let incoming = min(1,max(0,incoming.isFinite ? incoming : 0))
    let shared = min(1,max(0,shared.isFinite ? shared : 1))
    // Progress below one half: the lower page is the nearer one, so it is outgoing.
    // Shared holds are the same either way round.
    return (selection, selection.progress < 0.5
      ? SwapWeights(lower: outgoing,upper: incoming,shared: shared)
      : SwapWeights(lower: incoming,upper: outgoing,shared: shared))
  }

  /// One animated prop carries the swap's pair and its weights, so a frame can
  /// never pair a new position with old weights: the page position, the
  /// outgoing-only and incoming-only weights and, from API 7, the shared-hold
  /// weight. Nil unless the first three are finite numbers and nothing follows
  /// the fourth; the weights clamp to 0...1, and a missing or non-finite shared
  /// weight is 1, so an app that sends three numbers keeps shared holds whole.
  struct SwapFrame: Equatable {
    let pagePosition: Double
    let outgoing: Float
    let incoming: Float
    var shared: Float = 1
  }
  static func swapFrame(_ values: [Double]) -> SwapFrame? {
    guard values.count == 3 || values.count == 4, values.prefix(3).allSatisfy({ $0.isFinite }) else { return nil }
    let shared = values.count == 4 && values[3].isFinite ? Float(min(1,max(0,values[3]))) : 1
    return SwapFrame(pagePosition: values[0],outgoing: Float(min(1,max(0,values[1]))),
      incoming: Float(min(1,max(0,values[2]))),shared: shared)
  }

  /// While the next trio prepares, the packet already on screen keeps drawing
  /// the running swap if it holds every climb the frame shows: then the frame
  /// is the one the new packet will draw, and the hand-over changes nothing.
  /// Nil means hold the last frame instead of showing a different climb.
  static func carryOverSwap(pagePosition: Double, centerPage: Double, hasPrevious: Bool, hasNext: Bool,
                            outgoing: Float, incoming: Float, shared: Float = 1) -> (Selection, SwapWeights)? {
    guard pagePosition.isFinite, centerPage.isFinite, abs(pagePosition-centerPage) <= 1 else { return nil }
    let (selection, weights) = selectSwap(pagePosition: pagePosition,centerPage: centerPage,
      hasPrevious: hasPrevious,hasNext: hasNext,outgoing: outgoing,incoming: incoming,shared: shared)
    return pagePosition == centerPage || selection.lowerOffset != selection.upperOffset ? (selection, weights) : nil
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
