import Foundation

/// The swap look (the player's and the board motion lab's, `swapLookVersion` 2):
/// how the wall swap's two side weights become, for each hold, a mark weight, a
/// glow weight and a glow reach. Without a look the shader runs API 7's
/// `reveal_weight` and none of this exists.
///
/// The app keeps sending one weight per side from the wall-swap state machine,
/// so re-flicks, reversals and cancels stay in JS. Here a side's weight W turns
/// into a per-hold weight through a front: every hold has a key in 0...1 and
/// changes over its own window of the side's progress. W = 1, W = floor and
/// W = 0 give the same weight for every key, so the app can relabel a pair, or
/// restart a skipped climb at the floor, without a jump.
///
/// Uniforms come from Rust (`board_renderer_gpu_packet_shared_reveal_uniforms`
/// writes all 144 bytes), so this is computed in Swift once per frame for at
/// most 2 × 128 holds and bound as its own fragment buffer: the shader reads one
/// `ushort4` per candidate hold instead of re-deriving it per pixel, and no
/// Rust, xcframework or contract change is needed.
enum ClimbOverlaySwapLook {
  /// Advertised as the module constant `swapLookVersion`. 2: the look's
  /// format 2 (arrival floor, focus shape) and the `onSwapLookState` event.
  static let version = 2
  /// The fragment buffer the look is bound at, past the Rust contract's 0...4.
  static let metalBinding = 5
  /// The atlas pads every field for this reach (`EDIT_PEAK_REACH`); a halo past it would clip.
  static let maxReach: Float = ClimbOverlayPacketLayout.editPeakReach
  static let minReach: Float = 0.6
  /// One `ushort4` per hold after a header `ushort4`; header x = 1 turns the look on.
  static let off: [UInt16] = [0, 0, 0, 0]

  /// The static look, from the `swapLook` prop: `[2, holdWindow, lowWindow,
  /// floor, arrivalFloor, climbUp, jitter, ghost, markLag, swell, swellTail,
  /// focus, focusShape, tighten, topBoost]`. Every number is clamped to its
  /// range; nil turns the look off.
  struct Look: Equatable {
    /// Above the floor, each hold changes over this share of the side's progress. 1: all together.
    var holdWindow: Float = 1
    /// Below the floor, the same. 1: all together.
    var lowWindow: Float = 1
    /// A leaving climb's two stages meet here (the drag's dim); every hold is at it when its side is.
    var floor: Float = 0.4
    /// The same for an arriving climb. Equal to `floor` it moves like a leaving one; 0 lights it
    /// in one front from dark to whole; with ghosts it is where the ghosts end and the marks begin.
    var arrivalFloor: Float = 0.4
    /// An arriving climb lights bottom to top within its own lit holds, not from the swipe edge.
    var climbUp = false
    /// Mixes each key toward a hash of the hold id: a ragged order.
    var jitter: Float = 0
    /// An arriving climb below the floor shows glow only, up to this glow; 0: no ghosts.
    var ghost: Float = 0
    /// The mark trails the glow: mark × mix(1, w, markLag).
    var markLag: Float = 0
    /// An arriving hold's reach swells by up to this much as it lights, then settles.
    var swell: Float = 0
    /// How long the swell takes to settle, in the side's progress above the floor.
    var swellTail: Float = 0
    /// An arriving hold's reach is 1 + focus × (1 − w)^focusShape: wide while faint.
    var focus: Float = 0
    /// 2 pulls the halo in early (inside the flash budget); 0.5 keeps it wide until the hold is nearly whole.
    var focusShape: Float = 2
    /// A leaving hold's reach is 1 − tighten × (1 − w): it pulls in as it fades.
    var tighten: Float = 0
    /// The swell grows with the key: mix(1, key, topBoost). With climb-up keys, the top swells most.
    var topBoost: Float = 0

    static let fieldCount = 15
    static let format: Double = 2

    init() {}

    init?(_ values: [Double]) {
      guard values.count == Look.fieldCount, values[0] == Look.format, values.allSatisfy({ $0.isFinite }) else {
        return nil
      }
      func number(_ index: Int, _ low: Float, _ high: Float) -> Float { min(high, max(low, Float(values[index]))) }
      holdWindow = number(1, 0.05, 1)
      lowWindow = number(2, 0.05, 1)
      floor = number(3, 0, 0.95)
      arrivalFloor = number(4, 0, 0.95)
      climbUp = values[5] >= 0.5
      jitter = number(6, 0, 0.5)
      ghost = number(7, 0, 1)
      markLag = number(8, 0, 1)
      swell = number(9, 0, 0.35)
      // A swell needs time to settle before its hold is whole, or it would end at full reach,
      // and its hold's window must leave that time: otherwise the last hold's swell is cut
      // off at the side's last frame and its halo snaps back.
      swellTail = max(number(10, 0, 0.6), swell > 0 ? 0.05 : 0)
      if swell > 0 { holdWindow = min(holdWindow, 1 - swellTail) }
      focus = number(11, 0, 0.35)
      focusShape = number(12, 0.25, 3)
      tighten = number(13, 0, 0.8)
      topBoost = number(14, 0, 1)
    }
  }

  /// What the look needs of one hold descriptor, read once per packet.
  struct Hold: Equatable {
    /// The hold's centre across the board, 0 left to 1 right, before any display mirror.
    var centerX: Float
    /// The hold's centre down the board, 0 top to 1 bottom.
    var centerY: Float
    /// 0 lit only in this climb, 1 the same role in both, 2 a changed role.
    var membership: Int
    /// 0..<1 from the physical hold id, the same on both sides.
    var entropy: Float
    var annotation: Bool
  }

  /// One climb's holds and the vertical extent of its lit (non-annotation) holds.
  struct Scene: Equatable {
    var holds: [Hold]
    var top: Float
    var bottom: Float

    init(_ holds: [Hold]) {
      self.holds = holds
      let heights = holds.filter { !$0.annotation }.map(\.centerY)
      top = heights.min() ?? 0
      bottom = heights.max() ?? 1
    }
  }

  /// One side of the pair as this frame shows it.
  struct Side: Equatable {
    var weight: Float
    /// The side's climb is arriving (the app's flag), so it uses the arriving rules.
    var arriving: Bool
    var top: Float = 0
    var bottom: Float = 1
    /// An arriving climb's entry edge (true: the right, before any display mirror). It keys the
    /// climb's front from that edge whichever slot it now sits in, so a climb skipped mid-front
    /// by a quick re-flick, which moves from the upper to the lower slot, keeps its front's side.
    /// Nil: the slot's own edge (lower from the left, upper from the right).
    var fromRight: Bool?
    /// A flick run's arrival: no swell.
    var calm = false

    init(weight: Float, arriving: Bool, top: Float = 0, bottom: Float = 1, fromRight: Bool? = nil, calm: Bool = false) {
      self.weight = weight
      self.arriving = arriving
      self.top = top
      self.bottom = bottom
      self.fromRight = fromRight
      self.calm = calm
    }

    /// From the app's code (`ClimbOverlayMotion.SwapArrivals`): 0 leaving, 1 arriving from the
    /// right, 2 from the left, +4 calm.
    init(weight: Float, code: Int) {
      let edge = code & 3
      self.init(weight: weight, arriving: edge == 1 || edge == 2, fromRight: edge == 1 ? true : (edge == 2 ? false : nil),
        calm: edge != 0 && code & 4 != 0)
    }
  }

  struct Shape: Equatable {
    var mark: Float
    var glow: Float
    var reach: Float
    static let hidden = Shape(mark: 0, glow: 0, reach: 1)
  }

  static func clampUnit(_ value: Float) -> Float { value > 0 ? (value < 1 ? value : 1) : 0 }

  static func smooth(_ value: Float) -> Float {
    let unit = clampUnit(value)
    return unit * unit * (3 - 2 * unit)
  }

  /// PCG hash of a physical hold id to 0..<1; the same id gives the same jitter on both sides.
  static func entropy(_ id: UInt32) -> Float {
    var hash = id &* 747_796_405 &+ 2_891_336_453
    hash = ((hash >> ((hash >> 28) &+ 4)) ^ hash) &* 277_803_737
    hash = (hash >> 22) ^ hash
    return Float(hash >> 8) / Float(1 << 24)
  }

  /// Reads `count` hold descriptors (`ClimbOverlayPacketLayout.descriptorBytes` each).
  /// `upper` picks which membership number belongs to this side, as the shader does.
  static func holds(descriptors: UnsafeRawBufferPointer, count: Int, upper: Bool, width: Float,
                    height: Float) -> [Hold] {
    let stride = ClimbOverlayPacketLayout.descriptorBytes
    guard count > 0, width > 0, height > 0, descriptors.count >= count * stride else { return [] }
    return (0..<count).map { index in
      let base = index * stride
      func float(_ offset: Int) -> Float { descriptors.loadUnaligned(fromByteOffset: base + offset, as: Float.self) }
      func word(_ offset: Int) -> UInt32 { descriptors.loadUnaligned(fromByteOffset: base + offset, as: UInt32.self) }
      let bounds = ClimbOverlayPacketLayout.descriptorOffsetsBounds
      let numbers = ClimbOverlayPacketLayout.descriptorOffsetsNumbers
      let identity = ClimbOverlayPacketLayout.descriptorOffsetsIdentity
      let membership = float(numbers + (upper ? 8 : 12))
      return Hold(centerX: clampUnit((float(bounds) + float(bounds + 8)) * 0.5 / width),
        centerY: clampUnit((float(bounds + 4) + float(bounds + 12)) * 0.5 / height),
        membership: membership == 1 ? 1 : (membership == 2 ? 2 : 0),
        entropy: entropy(word(identity)), annotation: word(identity + 8) > 0)
    }
  }

  /// The order key, 0 acts first as a side's weight rises (and last as it falls).
  /// Sideways: 0 at the edge this side's climb enters from (the lower page from
  /// the left, the upper page from the right, swapped by a display mirror), so a
  /// relabelled pair replays the same front backwards. An arriving climb under
  /// `climbUp`: 0 at its lowest lit hold, 1 at its highest.
  static func key(_ hold: Hold, upper: Bool, side: Side, look: Look, mirrored: Bool) -> Float {
    var key: Float
    if side.arriving && look.climbUp {
      let span = side.bottom - side.top
      key = span > 1e-4 ? (side.bottom - hold.centerY) / span : 0
    } else {
      let across = mirrored ? 1 - hold.centerX : hold.centerX
      let fromRight = side.arriving ? (side.fromRight ?? upper) : upper
      key = fromRight ? 1 - across : across
    }
    key = clampUnit(key)
    return key + (hold.entropy - key) * look.jitter
  }

  /// Where a hold with `key` is inside its own window of `progress`.
  static func window(_ progress: Float, key: Float, width: Float, tail: Float) -> Float {
    let lead = max(0, 1 - width - tail)
    return clampUnit((progress - key * lead) / width)
  }

  /// Linear for a window of 1 (the side's own curve), smoothstep for a narrow one.
  static func ease(_ local: Float, width: Float) -> Float {
    let smoothed = local * local * (3 - 2 * local)
    return local + (smoothed - local) * (1 - width)
  }

  /// The floor a side's two stages meet at: `arrivalFloor` for an arriving climb.
  static func stageFloor(arriving: Bool, look: Look) -> Float { arriving ? look.arrivalFloor : look.floor }

  /// One hold's weight when its side is at `weight`. Above the floor holds move
  /// between the floor and 1 in key order; below it, between 0 and the floor.
  /// An arriving climb finishes its front early by `swellTail`, so the last
  /// hold's swell can settle before the side reaches 1.
  static func lit(_ weight: Float, key: Float, arriving: Bool, look: Look) -> Float {
    let weight = clampUnit(weight)
    let floor = stageFloor(arriving: arriving, look: look)
    if weight >= floor {
      let span = 1 - floor
      let progress = span > 0 ? (weight - floor) / span : 1
      let local = window(progress, key: key, width: look.holdWindow, tail: arriving ? look.swellTail : 0)
      return floor + span * ease(local, width: look.holdWindow)
    }
    let local = window(weight / floor, key: key, width: look.lowWindow, tail: 0)
    return floor * ease(local, width: look.lowWindow)
  }

  /// An arriving hold's swell above reach 1: up as it lights, back down over
  /// `swellTail`, 0 at and below the floor and at 1.
  static func swell(_ weight: Float, key: Float, look: Look) -> Float {
    let floor = look.arrivalFloor
    guard look.swell > 0, weight > floor, weight < 1 else { return 0 }
    let progress = (weight - floor) / (1 - floor)
    let width = look.holdWindow
    let span = width + look.swellTail
    let local = clampUnit((progress - key * max(0, 1 - span)) / span)
    let peak = width / span
    let shape = local < peak ? smooth(local / peak) : 1 - smooth((local - peak) / (1 - peak))
    return look.swell * (1 + (key - 1) * look.topBoost) * shape
  }

  /// Mark, glow and reach for a hold of one side at per-hold weight `weight`.
  static func shaped(_ weight: Float, key: Float, arriving: Bool, look: Look, allowReach: Bool,
                     calm: Bool = false) -> Shape {
    guard weight > 0 else { return .hidden }
    var mark = weight
    var glow = weight
    if arriving && look.ghost > 0 && look.arrivalFloor > 0 {
      // A ghost: glow only up to the arrival floor, then the mark fills in as the glow finishes.
      if weight <= look.arrivalFloor {
        glow = weight * look.ghost / look.arrivalFloor
        mark = 0
      } else {
        let filled = (weight - look.arrivalFloor) / (1 - look.arrivalFloor)
        glow = look.ghost + (1 - look.ghost) * filled
        mark = filled
      }
    }
    mark *= 1 + (weight - 1) * look.markLag
    guard allowReach else { return Shape(mark: mark, glow: glow, reach: 1) }
    let missing = 1 - weight
    let base = arriving ? 1 + look.focus * pow(missing, look.focusShape) : 1 - look.tighten * missing
    let grown = arriving && !calm ? base * (1 + swell(weight, key: key, look: look)) : base
    return Shape(mark: mark, glow: glow, reach: min(maxReach, max(minReach, grown)))
  }

  /// One hold of the union. A shared same-role hold is drawn once, on the lower
  /// side, at the brighter of the two sides' fronts at its spot, never below
  /// `sharedFloor`. A changed hold shows only its stronger role, compared at its
  /// own spot (the lower one on a tie), as API 7 does with the side weights.
  static func shape(_ hold: Hold, upper: Bool, lower lowerSide: Side, upper upperSide: Side, sharedFloor: Float,
                    look: Look, mirrored: Bool, allowReach: Bool) -> Shape {
    let own = upper ? upperSide : lowerSide
    let ownKey = key(hold, upper: upper, side: own, look: look, mirrored: mirrored)
    let ownWeight = lit(own.weight, key: ownKey, arriving: own.arriving, look: look)
    if hold.membership == 1 {
      if upper { return .hidden }
      let otherKey = key(hold, upper: true, side: upperSide, look: look, mirrored: mirrored)
      let otherWeight = lit(upperSide.weight, key: otherKey, arriving: upperSide.arriving, look: look)
      let weight = max(clampUnit(sharedFloor), max(ownWeight, otherWeight))
      return weight > 0 ? Shape(mark: weight, glow: weight, reach: 1) : .hidden
    }
    if hold.membership == 2 {
      let other = upper ? lowerSide : upperSide
      let otherKey = key(hold, upper: !upper, side: other, look: look, mirrored: mirrored)
      let otherWeight = lit(other.weight, key: otherKey, arriving: other.arriving, look: look)
      if upper ? ownWeight <= otherWeight : ownWeight < otherWeight { return .hidden }
    }
    return shaped(ownWeight, key: ownKey, arriving: own.arriving, look: look, allowReach: allowReach, calm: own.calm)
  }

  /// Each side's arrival code: the lower page is the outgoing one while the
  /// pair's progress is below one half, as `ClimbOverlayMotion.selectSwap` maps weights.
  static func sides(progress: Float, outgoing: Int, incoming: Int) -> (lower: Int, upper: Int) {
    progress < 0.5 ? (outgoing, incoming) : (incoming, outgoing)
  }

  static func unorm16(_ value: Float) -> UInt16 { UInt16((clampUnit(value) * 65535).rounded()) }
  /// Reach in 1/32768 steps, so 1 decodes exactly; rounded down, so `maxReach` never decodes past the padding.
  static func reach16(_ value: Float) -> UInt16 { UInt16((min(maxReach, max(0, value)) * 32768).rounded(.down)) }

  /// The fragment buffer for one frame: the header, then every lower hold, then
  /// every upper hold, in the shader's union order. Mark and glow are 0...1 in
  /// 1/65535 steps, reach is in 1/32768 steps.
  static func encode(lower: Scene, upper: Scene, lowerSide: Side, upperSide: Side, sharedFloor: Float, look: Look,
                     mirrored: Bool, allowReach: Bool) -> [UInt16] {
    var words = [UInt16](repeating: 0, count: 4 * (1 + lower.holds.count + upper.holds.count))
    words[0] = 1
    var lowerSide = lowerSide
    var upperSide = upperSide
    (lowerSide.top, lowerSide.bottom) = (lower.top, lower.bottom)
    (upperSide.top, upperSide.bottom) = (upper.top, upper.bottom)
    func write(_ slot: Int, _ shape: Shape) {
      words[4 * slot] = unorm16(shape.mark)
      words[4 * slot + 1] = unorm16(shape.glow)
      words[4 * slot + 2] = reach16(shape.reach)
    }
    for (index, hold) in lower.holds.enumerated() {
      write(1 + index, shape(hold, upper: false, lower: lowerSide, upper: upperSide, sharedFloor: sharedFloor,
        look: look, mirrored: mirrored, allowReach: allowReach))
    }
    for (index, hold) in upper.holds.enumerated() {
      write(1 + lower.holds.count + index, shape(hold, upper: true, lower: lowerSide, upper: upperSide,
        sharedFloor: sharedFloor, look: look, mirrored: mirrored, allowReach: allowReach))
    }
    return words
  }
}
