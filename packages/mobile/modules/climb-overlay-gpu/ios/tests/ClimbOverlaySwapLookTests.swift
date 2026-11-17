import Foundation

/// Run with swiftc plus ../ClimbOverlaySwapLook.swift, ../ClimbOverlayMotion.swift,
/// ../ClimbOverlayShader.swift and ../ClimbOverlayPacketLayout.swift. No Expo
/// runtime or GPU needed; scripts/board-motion-preview renders the look on Metal.
@main enum ClimbOverlaySwapLookTests {
  typealias Look = ClimbOverlaySwapLook.Look
  typealias Hold = ClimbOverlaySwapLook.Hold
  typealias Side = ClimbOverlaySwapLook.Side

  static func near(_ first: Float, _ second: Float, _ tolerance: Float = 1e-5) -> Bool { abs(first - second) <= tolerance }

  static func values(_ look: Look) -> [Double] {
    [1, Double(look.holdWindow), Double(look.lowWindow), Double(look.floor), look.climbUp ? 1 : 0,
     Double(look.jitter), Double(look.ghost), Double(look.markLag), Double(look.swell), Double(look.swellTail),
     Double(look.focus), Double(look.tighten), Double(look.topBoost)]
  }

  /// Looks across every slider's extremes and the variants' defaults.
  static func looks() -> [Look] {
    var looks: [Look] = []
    for window: Float in [0.05, 0.12, 0.4, 1] {
      for floor: Float in [0, 0.4, 0.9] {
        for arrivingRules in 0..<4 {
          var look = Look()
          look.holdWindow = window
          look.lowWindow = arrivingRules % 2 == 0 ? 1 : window
          look.floor = floor
          look.climbUp = arrivingRules >= 2
          look.jitter = arrivingRules == 3 ? 0.5 : (arrivingRules == 1 ? 0.25 : 0)
          look.ghost = arrivingRules == 1 ? 0.3 : (arrivingRules == 3 ? 1 : 0)
          look.markLag = arrivingRules == 2 ? 1 : 0.6 * Float(arrivingRules % 2)
          look.swell = [0, 0.08, 0.35, 0.2][arrivingRules]
          look.swellTail = max([0, 0.25, 0.6, 0][arrivingRules], look.swell > 0 ? 0.05 : 0)
          look.focus = [0, 0.3, 0.35, 0][arrivingRules]
          look.tighten = [0, 0.15, 0.6, 0.5][arrivingRules]
          look.topBoost = [0, 1, 0.6, 0][arrivingRules]
          precondition(Look(values(look)) == look, "Every test look round-trips through the prop")
          looks.append(look)
        }
      }
    }
    return looks
  }

  /// Seeded holds spread over the board, a few of each membership.
  static func holds(_ count: Int, seed: UInt32) -> [Hold] {
    (0..<count).map { index in
      let id = seed &+ UInt32(index) &* 7919
      return Hold(centerX: ClimbOverlaySwapLook.entropy(id), centerY: ClimbOverlaySwapLook.entropy(id &+ 1),
        membership: index % 5 == 3 ? 1 : (index % 7 == 4 ? 2 : 0),
        entropy: ClimbOverlaySwapLook.entropy(id &+ 2), annotation: false)
    }
  }

  static func main() {
    // The prop: exactly 13 finite numbers, format 1, every number clamped.
    precondition(Look([]) == nil && Look([2,1,1,0.4,0,0,0,0,0,0,0,0,0]) == nil)
    precondition(Look([1,1,1,0.4,0,0,0,0,0,0,0,0,.nan]) == nil)
    precondition(Look([1,1,1,0.4,0,0,0,0,0,0,0,0]) == nil)
    let wild = Look([1,0,9,-1,0.7,5,-2,3,1,0,2,-1,4])!
    precondition(wild.holdWindow == 0.05 && wild.lowWindow == 1 && wild.floor == 0 && wild.climbUp && wild.jitter == 0.5)
    precondition(wild.ghost == 0 && wild.markLag == 1 && wild.swell == 0.35 && wild.swellTail == 0.05)
    precondition(wild.focus == 0.35 && wild.tighten == 0 && wild.topBoost == 1,
      "A swell always gets a tail, so it ends at reach 1 before its hold is whole")

    let lower = holds(24, seed: 11)
    let upper = holds(24, seed: 97)
    let lowerScene = ClimbOverlaySwapLook.Scene(lower)
    let upperScene = ClimbOverlaySwapLook.Scene(upper)
    for look in looks() {
      for mirrored in [false, true] {
        for arriving in [false, true] {
          for upperSide in [false, true] {
            let scene = upperSide ? upperScene : lowerScene
            let side = Side(weight: 0, arriving: arriving, top: scene.top, bottom: scene.bottom)
            func shapes(_ weight: Float) -> [ClimbOverlaySwapLook.Shape] {
              scene.holds.map { hold in
                let key = ClimbOverlaySwapLook.key(hold, upper: upperSide, side: side, look: look, mirrored: mirrored)
                return ClimbOverlaySwapLook.shaped(ClimbOverlaySwapLook.lit(weight, key: key, arriving: arriving, look: look),
                  key: key, arriving: arriving, look: look, allowReach: true)
              }
            }
            // The invariant the app's relabels and re-flicks rely on: whole, at the floor and dark,
            // every hold of a side looks the same whatever its key.
            precondition(shapes(1).allSatisfy { $0 == ClimbOverlaySwapLook.Shape(mark: 1, glow: 1, reach: 1) },
              "W = 1 is the still image: every hold whole at reach 1")
            precondition(shapes(0).allSatisfy { $0 == .hidden }, "W = 0 hides every hold")
            let atFloor = shapes(look.floor)
            precondition(atFloor.allSatisfy { $0 == atFloor[0] }, "W = floor is uniform for every key")
            for hold in scene.holds {
              let key = ClimbOverlaySwapLook.key(hold, upper: upperSide, side: side, look: look, mirrored: mirrored)
              var previous: Float = 0
              for step in 0...200 {
                let weight = Float(step) / 200
                let lit = ClimbOverlaySwapLook.lit(weight, key: key, arriving: arriving, look: look)
                precondition(lit >= previous - 1e-6 && lit >= 0 && lit <= 1, "A hold never dims as its side brightens")
                previous = lit
                let shape = ClimbOverlaySwapLook.shaped(lit, key: key, arriving: arriving, look: look, allowReach: true)
                precondition(shape.mark <= shape.glow + 1e-6, "A mark never outshines its glow")
                precondition(shape.reach >= ClimbOverlaySwapLook.minReach && shape.reach <= ClimbOverlaySwapLook.maxReach,
                  "Reach stays inside the atlas padding")
                if !arriving { precondition(shape.reach <= 1, "Only an arriving hold grows its halo") }
                let lowPower = ClimbOverlaySwapLook.shaped(lit, key: key, arriving: arriving, look: look, allowReach: false)
                precondition(lowPower.reach == 1 && lowPower.mark == shape.mark && lowPower.glow == shape.glow)
              }
            }
          }
        }
      }
    }

    // Window 1 and no reach terms is API 7's swap: one weight per side.
    var plain = Look()
    plain.floor = 0.4
    for weight in stride(from: Float(0), through: 1, by: 0.05) {
      for hold in lower {
        let key = ClimbOverlaySwapLook.key(hold, upper: false, side: Side(weight: weight, arriving: false), look: plain,
          mirrored: false)
        precondition(near(ClimbOverlaySwapLook.lit(weight, key: key, arriving: true, look: plain), weight))
      }
    }
    let plainLower = Side(weight: 0.25, arriving: false)
    let plainUpper = Side(weight: 0.3, arriving: true)
    for membership in 0...2 {
      for upperSide in [false, true] {
        var hold = lower[0]
        hold.membership = membership
        let shape = ClimbOverlaySwapLook.shape(hold, upper: upperSide, lower: plainLower, upper: plainUpper,
          sharedFloor: 0.4, look: plain, mirrored: false, allowReach: true)
        let expected: Float = membership == 1 ? (upperSide ? 0 : 0.4) : (membership == 2 ? (upperSide ? 0.3 : 0)
          : (upperSide ? 0.3 : 0.25))
        precondition(near(shape.glow, expected) && near(shape.mark, expected) && shape.reach == 1,
          "Plain look matches reveal_weight: shared at the floor once, a changed hold's stronger role only")
      }
    }

    // Direction. The next climb (upper) enters from the right: its right-hand holds light first,
    // and the climb being left (lower) dims from the right too. A display mirror swaps the edge.
    var front = Look()
    front.holdWindow = 0.2
    front.floor = 0
    let left = Hold(centerX: 0.1, centerY: 0.5, membership: 0, entropy: 0.5, annotation: false)
    let right = Hold(centerX: 0.9, centerY: 0.5, membership: 0, entropy: 0.5, annotation: false)
    func litAt(_ hold: Hold, upper: Bool, weight: Float, mirrored: Bool = false) -> Float {
      let side = Side(weight: weight, arriving: upper)
      let key = ClimbOverlaySwapLook.key(hold, upper: upper, side: side, look: front, mirrored: mirrored)
      return ClimbOverlaySwapLook.lit(weight, key: key, arriving: upper, look: front)
    }
    precondition(litAt(right, upper: true, weight: 0.3) > litAt(left, upper: true, weight: 0.3))
    precondition(litAt(right, upper: false, weight: 0.7) < litAt(left, upper: false, weight: 0.7))
    precondition(litAt(right, upper: true, weight: 0.3, mirrored: true) < litAt(left, upper: true, weight: 0.3, mirrored: true))
    // Previous: the lower page arrives from the left.
    precondition(litAt(left, upper: false, weight: 0.3) > litAt(right, upper: false, weight: 0.3))

    // Climb-up: an arriving climb lights from its lowest hold, a leaving one keeps the sideways front.
    var climb = front
    climb.climbUp = true
    let low = Hold(centerX: 0.1, centerY: 0.8, membership: 0, entropy: 0.5, annotation: false)
    let high = Hold(centerX: 0.9, centerY: 0.2, membership: 0, entropy: 0.5, annotation: false)
    let climbScene = ClimbOverlaySwapLook.Scene([low, high])
    let arrivingSide = Side(weight: 0.3, arriving: true, top: climbScene.top, bottom: climbScene.bottom)
    let lowKey = ClimbOverlaySwapLook.key(low, upper: true, side: arrivingSide, look: climb, mirrored: false)
    let highKey = ClimbOverlaySwapLook.key(high, upper: true, side: arrivingSide, look: climb, mirrored: false)
    precondition(lowKey == 0 && highKey == 1, "Keys span the climb's own lit holds, bottom to top")
    precondition(ClimbOverlaySwapLook.lit(0.3, key: lowKey, arriving: true, look: climb)
      > ClimbOverlaySwapLook.lit(0.3, key: highKey, arriving: true, look: climb))
    let leavingSide = Side(weight: 0.3, arriving: false, top: climbScene.top, bottom: climbScene.bottom)
    precondition(near(ClimbOverlaySwapLook.key(high, upper: true, side: leavingSide, look: climb, mirrored: false), 0.1))

    // A ghost: glow only up to the floor, then the mark fills in as the glow finishes.
    var ghost = Look()
    ghost.floor = 0.4
    ghost.ghost = 0.3
    let faint = ClimbOverlaySwapLook.shaped(0.4, key: 0, arriving: true, look: ghost, allowReach: true)
    precondition(faint.mark == 0 && near(faint.glow, 0.3))
    let half = ClimbOverlaySwapLook.shaped(0.7, key: 0, arriving: true, look: ghost, allowReach: true)
    precondition(near(half.mark, 0.5) && near(half.glow, 0.65))
    precondition(ClimbOverlaySwapLook.shaped(0.4, key: 0, arriving: false, look: ghost, allowReach: true).mark == 0.4,
      "Only an arriving climb is a ghost")

    // A swell peaks as its hold becomes whole and is gone before the side is.
    var swell = Look()
    swell.floor = 0.4
    swell.holdWindow = 0.4
    swell.swell = 0.08
    swell.swellTail = 0.25
    var peak: Float = 0
    for step in 0...400 {
      let weight = 0.4 + 0.6 * Float(step) / 400
      peak = max(peak, ClimbOverlaySwapLook.swell(weight, key: 1, look: swell))
    }
    precondition(near(peak, 0.08, 1e-3) && ClimbOverlaySwapLook.swell(1, key: 1, look: swell) == 0)

    // The buffer: header, then lower holds, then upper holds; reach 1 decodes exactly.
    let words = ClimbOverlaySwapLook.encode(lower: lowerScene, upper: upperScene,
      lowerSide: Side(weight: 1, arriving: false), upperSide: Side(weight: 0, arriving: true), sharedFloor: 1,
      look: Look(), mirrored: false, allowReach: true)
    precondition(words.count == 4 * (1 + lower.count + upper.count) && words[0] == 1)
    precondition(words.count * 2 <= 4096, "setFragmentBytes takes at most 4 KB")
    for (index, hold) in lower.enumerated() {
      precondition(words[4 * (1 + index)] == 65535 && words[4 * (1 + index) + 1] == 65535, "Lower whole")
      precondition(words[4 * (1 + index) + 2] == 32768 || hold.membership == 2, "Reach 1 is 32768")
    }
    for index in upper.indices { precondition(words[4 * (1 + lower.count + index) + 1] == 0, "Upper dark") }
    let full = ClimbOverlaySwapLook.Scene(holds(128, seed: 5))
    precondition(ClimbOverlaySwapLook.encode(lower: full, upper: full, lowerSide: Side(weight: 0.5, arriving: false),
      upperSide: Side(weight: 0.5, arriving: true), sharedFloor: 0.4, look: wild, mirrored: false,
      allowReach: true).count * 2 <= 4096, "Two full climbs still fit")

    // The shader stays compilable on its own (the golden harnesses build it with only the layout),
    // so it names the look's binding as a literal: keep the two in step.
    precondition(ClimbOverlayShader.source.contains("constant ushort4* look [[buffer(\(ClimbOverlaySwapLook.metalBinding))]]"))

    // The lower page is the climb being left while the pair leans toward the upper one.
    precondition(ClimbOverlaySwapLook.sides(progress: 0.25, outgoingArrives: false, incomingArrives: true) == (false, true))
    precondition(ClimbOverlaySwapLook.sides(progress: 0.75, outgoingArrives: false, incomingArrives: true) == (true, false))

    // Seven-number frames carry the arrival flags; old frame lengths keep theirs off.
    let seven = ClimbOverlayMotion.sequencedSwapFrame([4.25, 0.4, 0.2, 1, 9, 0, 1])!
    precondition(seven.sequence == 9 && seven.arrivals == .init(outgoing: false, incoming: true) && seven.frame.shared == 1)
    precondition(ClimbOverlayMotion.sequencedSwapFrame([4.25, 0.4, 0.2, 1, 9])!.arrivals == .init())
    precondition(ClimbOverlayMotion.sequencedSwapFrame([4.25, 0.4, 0.2, 1, 9, 0]) == nil)
    precondition(ClimbOverlayMotion.sequencedSwapFrame([4.25, 0.4, 0.2, 1, 9, .nan, 1]) == nil)

    print("Swap look guards passed: prop parsing, W = 1/floor/0 uniform for every key and look, monotone fronts, mark under glow, reach in [0.6, 1.35], plain look = API 7 weights, swipe-edge and mirror direction, climb-up keys, ghosts, swell, buffer layout and seven-number frames")
  }
}
