import Foundation

/// How the frost's lights change climbs: the board's swap look at pill scale.
/// The rules and their numbers are in `@boardsesh/frosted-bokeh` (`swap.ts`);
/// `BokehMotion.kt` on Android is the same code line for line. No UIKit or
/// Metal here, so it runs in a plain test harness.
///
/// - With the board's swap frames (`swapFrameApi`), the lights follow them: the
///   frame names the pair by page and carries each side's weight; each light
///   takes its own weight through the board's front, keyed by its x.
/// - A climb that appears whole in one step (the Next button, a queue tap, a
///   crewmate's change, any change with no frames) runs the release on its own.
/// - A frame naming a page the app has not sent yet (a flick run outpacing
///   the JS thread) keeps the last frame it could draw until the page arrives.
/// - A climb that leaves the screen in one step fades out where it is.
/// - Lights lit in both climbs stay whole. At most `maxLights` are drawn.

/// One light: a hold's blob in pill points, its colour, and its breathing seed.
struct BokehLight: Equatable {
  /// The physical hold's id, or -1 when the app sent none.
  var id: Int64
  /// The breathing phase, 0..<2π; the shader reads it from the colour's alpha.
  var seed: Float
  var x: Float
  var y: Float
  var r: Float
  var peak: Float
  var red: Float
  var green: Float
  var blue: Float

  /// The seed for a light the app sent without one: a hash of its position.
  static func positionSeed(x: Float, y: Float) -> Float {
    let wave = sin(Double(x) * 12.9898 + Double(y) * 78.233) * 43758.5453
    return Float((wave - wave.rounded(.down)) * 2 * Double.pi)
  }
}

struct BokehClimb: Equatable {
  var key: String
  var lights: [BokehLight]
}

/// The look's numbers the frost uses, from the board's 15-number `swapLook`
/// (`ClimbOverlaySwapLook.Look`), clamped the same way.
struct BokehSwapLook: Equatable {
  var holdWindow: Float = 1
  var lowWindow: Float = 1
  var floor: Float = 0.4
  var arrivalFloor: Float = 0.4
  var ghost: Float = 0
  var swell: Float = 0
  var swellTail: Float = 0
  var focus: Float = 0
  var focusShape: Float = 2
  var tighten: Float = 0
  var topBoost: Float = 0

  init?(_ values: [Double]?) {
    guard let values, values.count == 15, values[0] == 2, values.allSatisfy({ $0.isFinite }) else { return nil }
    func number(_ index: Int, _ low: Float, _ high: Float) -> Float { min(high, max(low, Float(values[index]))) }
    lowWindow = number(2, 0.05, 1)
    floor = number(3, 0, 0.95)
    arrivalFloor = number(4, 0, 0.95)
    ghost = number(7, 0, 1)
    swell = number(9, 0, 0.35)
    swellTail = max(number(10, 0, 0.6), swell > 0 ? 0.05 : 0)
    holdWindow = swell > 0 ? min(number(1, 0.05, 1), 1 - swellTail) : number(1, 0.05, 1)
    focus = number(11, 0, 0.35)
    focusShape = number(12, 0.25, 3)
    tighten = number(13, 0, 0.8)
    topBoost = number(14, 0, 1)
  }
}

/// One board swap frame: `[pagePosition, outgoing, incoming, shared, sequence]`,
/// or seven numbers with the look's arrival codes. `[sequence]` alone: no frames.
struct BokehSwapFrame: Equatable {
  var position: Double
  var outgoing: Float
  var incoming: Float
  /// -1: a four-number frame, which draws without the look.
  var outgoingCode: Int
  var incomingCode: Int

  /// Half up, as JS's `Math.round` and Kotlin's `roundToLong`.
  var from: Int { BokehMotion.page(position) }
  var direction: Int {
    let lean = position - Double(from)
    return lean > 0.01 ? 1 : (lean < -0.01 ? -1 : 0)
  }

  /// nil: not a frame. `.some(nil)`: frames stopped.
  static func parse(_ values: [Double]) -> (sequence: Double, frame: BokehSwapFrame?)? {
    guard values.allSatisfy({ $0.isFinite }) else { return nil }
    switch values.count {
    case 1:
      return (values[0], nil)
    case 5, 7:
      let coded = values.count == 7
      // Codes are 0...7; clamped before the conversion, which traps out of range.
      return (values[4], BokehSwapFrame(position: values[0], outgoing: BokehMotion.unit(Float(values[1])),
        incoming: BokehMotion.unit(Float(values[2])), outgoingCode: coded ? Int(min(7, max(0, values[5]))) : -1,
        incomingCode: coded ? Int(min(7, max(0, values[6]))) : -1))
    default:
      return nil
    }
  }
}

final class BokehMotion {
  /// `MAX_GPU_BOKEH_LIGHTS`: the shader's array size.
  static let maxLights = 30
  /// `BOKEH_SAME_HOLD_POINTS`.
  static let sameHoldPoints: Float = 6
  /// `BOKEH_ABRUPT_STEP`.
  static let abruptStep: Float = 0.5
  static let minReach: Float = 0.6
  static let maxReach: Float = 1.35
  private static let invisible: Float = 0.0005

  /// `BOKEH_SWAP_MS` and `BOKEH_SWAP_OUT_MS`, in seconds.
  var releaseSeconds = 0.22
  var fadeSeconds = 0.15
  var look: BokehSwapLook?
  /// The pill's width in points: lights are keyed by their x over it.
  var width: Float = 0

  private(set) var current = BokehClimb(key: "", lights: [])
  /// The climbs the board can swap between, by page; empty without swap frames.
  private var pages: [Int: BokehClimb] = [:]
  /// The newest frame, and the newest one whose complete pair the app has sent.
  private var frame: BokehSwapFrame?
  private var drawnFrame: BokehSwapFrame?
  private var drawnPages: [Int: BokehClimb] = [:]
  private var lastSequence: Double?
  private var visible: [String: Float] = [:]
  private var leftovers: [(light: BokehLight, start: Double)] = []
  private var arrivals: [String: (start: Double, held: Set<Int>)] = [:]

  private struct Entry {
    var key: String?
    var index: Int
    var light: BokehLight
  }

  private struct Side {
    var weight: Float
    var arriving: Bool
    var fromRight: Bool
    var calm: Bool
  }

  static func unit(_ value: Float) -> Float { value > 0 ? (value < 1 ? value : 1) : 0 }

  /// The nearest page, half up, clamped so the conversion never traps.
  static func page(_ position: Double) -> Int {
    guard !position.isNaN else { return 0 }
    return Int(min(1e9, max(-1e9, (position + 0.5).rounded(.down))))
  }

  static func smooth(_ value: Float) -> Float {
    let clamped = unit(value)
    return clamped * clamped * (3 - 2 * clamped)
  }

  static func sameHold(_ first: BokehLight, _ second: BokehLight) -> Bool {
    guard abs(first.red - second.red) < 0.02, abs(first.green - second.green) < 0.02,
      abs(first.blue - second.blue) < 0.02 else { return false }
    if first.id >= 0 && second.id >= 0 { return first.id == second.id }
    return hypot(first.x - second.x, first.y - second.y) < sameHoldPoints
  }

  // MARK: - Inputs

  /// The climb on show, and the board's pages around it (empty without swap frames).
  func setClimbs(current next: BokehClimb, pages nextPages: [Int: BokehClimb], now: Double) {
    let capped = BokehClimb(key: next.key, lights: Array(next.lights.prefix(Self.maxLights)))
    let cappedPages = nextPages.mapValues { BokehClimb(key: $0.key, lights: Array($0.lights.prefix(Self.maxLights))) }
    if capped == current && cappedPages == pages { return }
    refresh(now) {
      current = capped
      pages = cappedPages
      if pages.isEmpty { frame = nil }
      resolveFrame()
    }
  }

  /// A swap frame command or prop. False when its sequence is not newer than the last one applied.
  @discardableResult
  func applyFrame(_ values: [Double], now: Double) -> Bool {
    guard let parsed = BokehSwapFrame.parse(values) else { return false }
    if let lastSequence, parsed.sequence <= lastSequence { return false }
    lastSequence = parsed.sequence
    if parsed.frame == frame { return true }
    refresh(now) {
      frame = parsed.frame
      resolveFrame()
    }
    return true
  }

  /// Keep the last complete pair until both pages of the newest frame arrive.
  /// Snapshot its climbs too: a partial app update can evict the held pair.
  private func resolveFrame() {
    guard let frame else {
      drawnFrame = nil
      drawnPages = [:]
      return
    }
    guard let outgoing = pages[frame.from] else { return }
    var resolvedPages = [frame.from: outgoing]
    if frame.direction != 0 {
      let incomingPage = frame.from + frame.direction
      guard let incoming = pages[incomingPage] else { return }
      resolvedPages[incomingPage] = incoming
    }
    drawnFrame = frame
    drawnPages = resolvedPages
  }

  // MARK: - Output

  /// Something moves on its own clock: a release or a fade-out.
  func transitioning(_ now: Double) -> Bool {
    prune(now)
    return !leftovers.isEmpty || !arrivals.isEmpty
  }

  /// The lights for one frame, at most `maxLights`, the strongest kept.
  func lights(_ now: Double) -> [BokehLight] {
    prune(now)
    return Self.cap(compose(now).map(\.light))
  }

  static func cap(_ lights: [BokehLight]) -> [BokehLight] {
    let drawn = lights.filter { $0.peak > invisible && $0.r > 0 }
    guard drawn.count > maxLights else { return drawn }
    let keep = Set(drawn.indices.sorted { drawn[$0].peak != drawn[$1].peak ? drawn[$0].peak > drawn[$1].peak : $0 < $1 }
      .prefix(maxLights))
    return drawn.indices.filter { keep.contains($0) }.map { drawn[$0] }
  }

  // MARK: - Transitions

  private var frameMode: Bool { drawnFrame != nil }

  private func visibleWeights() -> [String: Float] {
    guard frameMode, let frame = drawnFrame else { return current.lights.isEmpty ? [:] : [current.key: 1] }
    var weights: [String: Float] = [:]
    if let outgoing = drawnPages[frame.from] { weights[outgoing.key] = frame.outgoing }
    if frame.direction != 0, let incoming = drawnPages[frame.from + frame.direction] {
      weights[incoming.key] = max(weights[incoming.key] ?? 0, frame.incoming)
    }
    return weights
  }

  private func visibleClimbs() -> [BokehClimb] {
    guard frameMode, let frame = drawnFrame else { return [current] }
    var climbs: [BokehClimb] = []
    if let outgoing = drawnPages[frame.from] { climbs.append(outgoing) }
    if frame.direction != 0, let incoming = drawnPages[frame.from + frame.direction] { climbs.append(incoming) }
    return climbs
  }

  /// Applies `change`, then turns what it did to the screen into transitions: a
  /// climb that left in one step fades out where it was, and one that appeared
  /// whole in one step runs the release, holding lights it shares with what was drawn.
  private func refresh(_ now: Double, _ change: () -> Void) {
    prune(now)
    let before = compose(now)
    let previous = visible
    change()
    let next = visibleWeights()
    let climbs = visibleClimbs()
    let shown = climbs.flatMap(\.lights)
    for entry in before {
      guard let key = entry.key, previous[key] != nil, next[key] == nil, entry.light.peak > Self.invisible else { continue }
      if shown.contains(where: { Self.sameHold($0, entry.light) }) { continue }
      leftovers.append((entry.light, now))
    }
    // Something was on screen: a climb arriving whole runs the release. Not on
    // the first climb, which appears whole.
    if !before.isEmpty || !previous.isEmpty {
      for climb in climbs {
        guard let weight = next[climb.key], weight - (previous[climb.key] ?? 0) >= Self.abruptStep else { continue }
        var held = Set<Int>()
        for (index, light) in climb.lights.enumerated()
        where before.contains(where: { Self.sameHold($0.light, light) && $0.light.peak >= 0.5 * light.peak }) {
          held.insert(index)
        }
        leftovers.removeAll { leftover in
          held.contains { Self.sameHold(climb.lights[$0], leftover.light) }
        }
        arrivals[climb.key] = (now, held)
      }
    }
    for key in arrivals.keys where next[key] == nil {
      arrivals[key] = nil
    }
    visible = next
  }

  private func prune(_ now: Double) {
    leftovers.removeAll { now - $0.start >= fadeSeconds }
    arrivals = arrivals.filter { now - $0.value.start < releaseSeconds }
  }

  // MARK: - Drawing

  private func compose(_ now: Double) -> [Entry] {
    var entries: [Entry] = leftovers.map { leftover in
      var light = leftover.light
      light.peak *= fade(now - leftover.start)
      return Entry(key: nil, index: -1, light: light)
    }
    var shaped: [Entry]
    if frameMode, let frame = drawnFrame {
      shaped = frameEntries(frame)
    } else {
      shaped = current.lights.enumerated().map { Entry(key: current.key, index: $0.offset, light: $0.element) }
    }
    for position in shaped.indices {
      guard let key = shaped[position].key, let arrival = arrivals[key] else { continue }
      if arrival.held.contains(shaped[position].index) { continue }
      shaped[position].light.peak *= fill(shaped[position].light, elapsed: now - arrival.start)
    }
    entries.append(contentsOf: shaped)
    return entries
  }

  private func frameEntries(_ frame: BokehSwapFrame) -> [Entry] {
    let direction = frame.direction
    let outgoing = drawnPages[frame.from]
    let incoming = direction != 0 ? drawnPages[frame.from + direction] : nil
    let look = frame.outgoingCode < 0 ? nil : self.look
    var entries: [Entry] = []
    if let outgoing {
      let side = side(weight: frame.outgoing, code: frame.outgoingCode, upper: direction < 0)
      for (index, light) in outgoing.lights.enumerated() {
        let shared = incoming?.lights.contains { Self.sameHold($0, light) } ?? false
        entries.append(Entry(key: outgoing.key, index: index, light: shared ? light : shape(light, side, look)))
      }
    }
    if let incoming {
      let side = side(weight: frame.incoming, code: frame.incomingCode, upper: direction > 0)
      for (index, light) in incoming.lights.enumerated() {
        if outgoing?.lights.contains(where: { Self.sameHold($0, light) }) ?? false { continue }
        entries.append(Entry(key: incoming.key, index: index, light: shape(light, side, look)))
      }
    }
    return entries
  }

  /// A side from its arrival code (0 leaving, 1 from the right, 2 from the left,
  /// +4 calm). A leaving climb is keyed from its own slot's edge: the upper page
  /// from the right, as the board keys it.
  private func side(weight: Float, code: Int, upper: Bool) -> Side {
    let edge = code < 0 ? 0 : code & 3
    let arriving = edge == 1 || edge == 2
    return Side(weight: weight, arriving: arriving, fromRight: arriving ? edge == 1 : upper,
      calm: arriving && code & 4 != 0)
  }

  private func across(_ light: BokehLight) -> Float { width > 0 ? Self.unit(light.x / width) : 0.5 }

  private func shape(_ light: BokehLight, _ side: Side, _ look: BokehSwapLook?) -> BokehLight {
    var out = light
    guard let look else {
      out.peak *= side.weight
      return out
    }
    let unit = across(light)
    let key = side.fromRight ? 1 - unit : unit
    let weight = Self.lit(side.weight, key: key, arriving: side.arriving, look: look)
    let shaped = Self.shaped(weight, key: key, arriving: side.arriving, calm: side.calm, look: look)
    out.peak *= shaped.glow
    out.r *= shaped.reach
    return out
  }

  /// A standalone release's ceiling on an arriving light (`frostReleaseFill`).
  private func fill(_ light: BokehLight, elapsed: Double) -> Float {
    let half = Float(releaseSeconds / 2)
    let key = 1 - across(light)
    return Self.smooth((Float(elapsed) - key * half) / half)
  }

  /// A fading light's share left (`frostReleaseFade`).
  private func fade(_ elapsed: Double) -> Float {
    return 1 - Self.smooth(Float(elapsed / fadeSeconds))
  }

  // MARK: - The board's look (`frostLightWeight`, `frostLightShape`)

  private static func window(_ progress: Float, key: Float, width: Float, tail: Float) -> Float {
    let lead = max(0, 1 - width - tail)
    return unit((progress - key * lead) / width)
  }

  private static func ease(_ local: Float, width: Float) -> Float {
    let smoothed = local * local * (3 - 2 * local)
    return local + (smoothed - local) * (1 - width)
  }

  static func lit(_ weight: Float, key: Float, arriving: Bool, look: BokehSwapLook) -> Float {
    let side = unit(weight)
    let floor = arriving ? look.arrivalFloor : look.floor
    if side >= floor {
      let span = 1 - floor
      let progress = span > 0 ? (side - floor) / span : 1
      let local = window(progress, key: key, width: look.holdWindow, tail: arriving ? look.swellTail : 0)
      return floor + span * ease(local, width: look.holdWindow)
    }
    let local = window(floor > 0 ? side / floor : 1, key: key, width: look.lowWindow, tail: 0)
    return floor * ease(local, width: look.lowWindow)
  }

  private static func swell(_ weight: Float, key: Float, look: BokehSwapLook) -> Float {
    let floor = look.arrivalFloor
    guard look.swell > 0, weight > floor, weight < 1 else { return 0 }
    let progress = (weight - floor) / (1 - floor)
    let span = look.holdWindow + look.swellTail
    let local = unit((progress - key * max(0, 1 - span)) / span)
    let peak = look.holdWindow / span
    let shape = local < peak ? smooth(local / peak) : 1 - smooth((local - peak) / (1 - peak))
    return look.swell * (1 + (key - 1) * look.topBoost) * shape
  }

  static func shaped(_ weight: Float, key: Float, arriving: Bool, calm: Bool,
                     look: BokehSwapLook) -> (glow: Float, reach: Float) {
    guard weight > 0 else { return (0, 1) }
    var glow = weight
    if arriving && look.ghost > 0 && look.arrivalFloor > 0 {
      glow = weight <= look.arrivalFloor
        ? weight * look.ghost / look.arrivalFloor
        : look.ghost + (1 - look.ghost) * (weight - look.arrivalFloor) / (1 - look.arrivalFloor)
    }
    let missing = 1 - weight
    let base = arriving ? 1 + look.focus * pow(missing, look.focusShape) : 1 - look.tighten * missing
    let grown = arriving && !calm ? base * (1 + swell(weight, key: key, look: look)) : base
    return (glow, min(maxReach, max(minReach, grown)))
  }
}
