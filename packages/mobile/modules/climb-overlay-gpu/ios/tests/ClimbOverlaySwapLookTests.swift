import Foundation
import Metal

/// Run with swiftc plus ../ClimbOverlaySwapLook.swift, ../ClimbOverlayMotion.swift,
/// ../ClimbOverlayShader.swift and ../ClimbOverlayPacketLayout.swift. No Expo
/// runtime needed. With a Metal device it also compiles the shader, so a syntax
/// error fails here rather than on a phone; without one that check is skipped.
/// scripts/board-motion-preview renders the look on Metal.
@main enum ClimbOverlaySwapLookTests {
  typealias Look = ClimbOverlaySwapLook.Look
  typealias Hold = ClimbOverlaySwapLook.Hold
  typealias Side = ClimbOverlaySwapLook.Side

  static func near(_ first: Float, _ second: Float, _ tolerance: Float = 1e-5) -> Bool { abs(first - second) <= tolerance }

  static func values(_ look: Look) -> [Double] {
    [2, Double(look.holdWindow), Double(look.lowWindow), Double(look.floor), Double(look.arrivalFloor),
     look.climbUp ? 1 : 0, Double(look.jitter), Double(look.ghost), Double(look.markLag), Double(look.swell),
     Double(look.swellTail), Double(look.focus), Double(look.focusShape), Double(look.tighten), Double(look.topBoost)]
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
          look.arrivalFloor = [floor, 0, 0.4, 0.25][arrivingRules]
          look.focusShape = [2, 0.5, 0.25, 3][arrivingRules]
          look.climbUp = arrivingRules >= 2
          look.jitter = arrivingRules == 3 ? 0.5 : (arrivingRules == 1 ? 0.25 : 0)
          look.ghost = arrivingRules == 1 ? 0.3 : (arrivingRules == 3 ? 1 : 0)
          look.markLag = arrivingRules == 2 ? 1 : 0.6 * Float(arrivingRules % 2)
          look.swell = [0, 0.08, 0.35, 0.2][arrivingRules]
          look.swellTail = max([0, 0.25, 0.6, 0][arrivingRules], look.swell > 0 ? 0.05 : 0)
          look.focus = [0, 0.3, 0.35, 0][arrivingRules]
          look.tighten = [0, 0.15, 0.6, 0.5][arrivingRules]
          look.topBoost = [0, 1, 0.6, 0][arrivingRules]
          if look.swell > 0 { look.holdWindow = min(look.holdWindow, 1 - look.swellTail) }
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

  /// The words both ports write for the fixture's looks, holds and sides, as one hex string per
  /// case (`%04x` per 16-bit word). Android's OverlaySwapLookTest checks the same file, so neither
  /// port can drift; `SWAP_LOOK_FIXTURE_OUT=<path>` writes a fresh one from this side instead.
  static func sharedFixture() {
    let path = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
      .appendingPathComponent("../../fixtures/swap-look-words.json").standardizedFileURL
    let fixture = try! JSONSerialization.jsonObject(with: Data(contentsOf: path)) as! [String: Any]
    let holdSpec = fixture["holds"] as! [String: Int]
    let lowerScene = ClimbOverlaySwapLook.Scene(holds(holdSpec["count"]!, seed: UInt32(holdSpec["lowerSeed"]!)))
    let upperScene = ClimbOverlaySwapLook.Scene(holds(holdSpec["count"]!, seed: UInt32(holdSpec["upperSeed"]!)))
    let sides = fixture["sides"] as! [[Double]]
    let written = (fixture["looks"] as! [[Double]]).map { values in
      let look = Look(values)!
      return sides.map { side in
        ClimbOverlaySwapLook.encode(lower: lowerScene, upper: upperScene,
          lowerSide: Side(weight: Float(side[0]), code: Int(side[1])), upperSide: Side(weight: Float(side[2]), code: Int(side[3])),
          sharedFloor: Float(side[4]), look: look, mirrored: side[5] != 0, allowReach: side[6] != 0)
          .map { String(format: "%04x", $0) }.joined()
      }
    }
    if let out = ProcessInfo.processInfo.environment["SWAP_LOOK_FIXTURE_OUT"] {
      // Keep the hand-written inputs as they are; "words" is the file's last key.
      let text = try! String(contentsOf: path, encoding: .utf8)
      let words = written.map { look in "    [\n" + look.map { "      \"\($0)\"" }.joined(separator: ",\n") + "\n    ]" }
      try! (String(text[..<text.range(of: "\"words\":")!.upperBound]) + " [\n" + words.joined(separator: ",\n") + "\n  ]\n}\n")
        .write(toFile: out, atomically: true, encoding: .utf8)
      print("Wrote \(out)")
      exit(0)
    }
    precondition(fixture["words"] as! [[String]] == written, "The shared fixture's words: Android checks the same file")
  }

  static func main() {
    // The prop: exactly 13 finite numbers, format 1, every number clamped.
    precondition(Look([]) == nil && Look([1,1,1,0.4,0.4,0,0,0,0,0,0,0,2,0,0]) == nil, "Format 1 is gone")
    precondition(Look([2,1,1,0.4,0.4,0,0,0,0,0,0,0,2,0,.nan]) == nil)
    precondition(Look([2,1,1,0.4,0,0,0,0,0,0,0,0,0]) == nil)
    let wild = Look([2,0,9,-1,3,0.7,5,-2,3,1,0,2,9,-1,4])!
    precondition(wild.holdWindow == 0.05 && wild.lowWindow == 1 && wild.floor == 0 && wild.arrivalFloor == 0.95)
    precondition(wild.climbUp && wild.jitter == 0.5 && wild.ghost == 0 && wild.markLag == 1 && wild.swell == 0.35)
    precondition(wild.swellTail == 0.05 && wild.focus == 0.35 && wild.focusShape == 3 && wild.tighten == 0
      && wild.topBoost == 1, "A swell always gets a tail, so it ends at reach 1 before its hold is whole")
    let wide = Look([2,1,1,0.4,0,0,0,0,0,0.3,0.25,0,2,0,0])!
    precondition(wide.holdWindow == 0.75, "A swell's hold window leaves room for its tail")

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
            let atFloor = shapes(ClimbOverlaySwapLook.stageFloor(arriving: arriving, look: look))
            precondition(atFloor.allSatisfy { $0 == atFloor[0] }, "W = this side's floor is uniform for every key")
            // The last frame before whole: a swell has settled, so nothing snaps back at W = 1.
            for hold in scene.holds {
              let key = ClimbOverlaySwapLook.key(hold, upper: upperSide, side: side, look: look, mirrored: mirrored)
              precondition(ClimbOverlaySwapLook.swell(1 - 1e-3, key: key, look: look) < 1e-3,
                "The swell is gone just before its side is whole")
            }
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

    // An arrival floor of 0 lights an arriving climb in one front, from dark to whole.
    var single = Look()
    single.holdWindow = 0.2
    single.arrivalFloor = 0
    precondition(ClimbOverlaySwapLook.lit(0.3, key: 0, arriving: true, look: single) == 1
      && ClimbOverlaySwapLook.lit(0.3, key: 1, arriving: true, look: single) == 0, "One front, no stop at the floor")
    // A focus shape under 2 keeps the halo wide for longer.
    var focus = Look()
    focus.focus = 0.35
    focus.focusShape = 0.5
    precondition(near(ClimbOverlaySwapLook.shaped(0.75, key: 0, arriving: true, look: focus, allowReach: true).reach, 1.175))

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
    front.arrivalFloor = 0
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
    precondition(ClimbOverlaySwapLook.sides(progress: 0.25, outgoing: 0, incoming: 1) == (0, 1))
    precondition(ClimbOverlaySwapLook.sides(progress: 0.75, outgoing: 0, incoming: 2) == (2, 0))

    // The app's codes: 0 leaving, 1 arriving from the right, 2 from the left, +4 calm.
    precondition(Side(weight: 0.5, code: 0) == Side(weight: 0.5, arriving: false))
    precondition(Side(weight: 0.5, code: 1) == Side(weight: 0.5, arriving: true, fromRight: true))
    precondition(Side(weight: 0.5, code: 6) == Side(weight: 0.5, arriving: true, fromRight: false, calm: true))
    precondition(Side(weight: 0.5, code: 4) == Side(weight: 0.5, arriving: false), "Calm only matters when arriving")
    // A climb skipped mid-front moves from the upper slot to the lower one; its entry edge keeps its key.
    let skippedUpper = ClimbOverlaySwapLook.key(right, upper: true, side: Side(weight: 0.3, arriving: true, fromRight: true),
      look: front, mirrored: false)
    let skippedLower = ClimbOverlaySwapLook.key(right, upper: false, side: Side(weight: 0.3, arriving: true, fromRight: true),
      look: front, mirrored: false)
    precondition(skippedUpper == skippedLower && near(skippedLower, 0.1), "The front keeps its side through the slot change")
    precondition(ClimbOverlaySwapLook.key(right, upper: false, side: Side(weight: 0.3, arriving: false, fromRight: true),
      look: front, mirrored: false) == 0.9, "A leaving climb keys from its slot")
    // A flick run's arrival has no swell.
    var calmSwell = Look()
    calmSwell.arrivalFloor = 0
    calmSwell.holdWindow = 0.3
    calmSwell.swell = 0.3
    calmSwell.swellTail = 0.3
    let swollen = ClimbOverlaySwapLook.shaped(0.5, key: 0.2, arriving: true, look: calmSwell, allowReach: true)
    let calm = ClimbOverlaySwapLook.shaped(0.5, key: 0.2, arriving: true, look: calmSwell, allowReach: true, calm: true)
    precondition(swollen.reach > 1.05 && calm.reach == 1 && calm.glow == swollen.glow)

    // Seven-number frames carry the arrival flags; old frame lengths keep theirs off.
    let seven = ClimbOverlayMotion.sequencedSwapFrame([4.25, 0.4, 0.2, 1, 9, 0, 5])!
    precondition(seven.sequence == 9 && seven.arrivals == .init(outgoing: 0, incoming: 5) && seven.frame.shared == 1)
    precondition(ClimbOverlayMotion.sequencedSwapFrame([4.25, 0.4, 0.2, 1, 9, 9, -1])!.arrivals == .init(),
      "Unknown codes are leaving")
    // Without the look (Reduce Motion), a look frame's shared holds follow the shipped rule, not the floor.
    let floorFrame = ClimbOverlayMotion.sequencedSwapFrame([4.25, 0.9, 0.2, 0.7, 10, 0, 1])!.frame
    precondition(floorFrame.shared == 0.9 && floorFrame.sharedFloor == 0.7)
    precondition(ClimbOverlayMotion.sequencedSwapFrame([4.25, 0.3, 0.2, 0.7, 11, 0, 1])!.frame.shared == 0.7)
    precondition(ClimbOverlayMotion.sequencedSwapFrame([4.25, 0.3, 0.2, 0.7, 12])!.frame.sharedFloor == nil)
    precondition(ClimbOverlaySwapLook.reach16(ClimbOverlaySwapLook.maxReach) * 1 <= UInt16(ClimbOverlaySwapLook.maxReach * 32768),
      "Reach rounds down, never past the atlas padding")
    precondition(ClimbOverlayMotion.sequencedSwapFrame([4.25, 0.4, 0.2, 1, 9])!.arrivals == .init())
    precondition(ClimbOverlayMotion.sequencedSwapFrame([4.25, 0.4, 0.2, 1, 9, 0]) == nil)
    precondition(ClimbOverlayMotion.sequencedSwapFrame([4.25, 0.4, 0.2, 1, 9, .nan, 1]) == nil)

    // The shader source compiles, as the app compiles it at runtime, with both entry points.
    var shaderCompiled = "no Metal device, shader compile skipped"
    if let device = MTLCreateSystemDefaultDevice() {
      do {
        let library = try device.makeLibrary(source: ClimbOverlayShader.source, options: nil)
        precondition(library.makeFunction(name: "overlay_vertex") != nil
          && library.makeFunction(name: "overlay_fragment") != nil, "The shader keeps both entry points")
        shaderCompiled = "shader compiled on \(device.name)"
      } catch {
        preconditionFailure("The Metal shader does not compile: \(error)")
      }
    }
    print(shaderCompiled)

    sharedFixture()

    print("Swap look guards passed: shared Android fixture, prop parsing, W = 1/floor/0 uniform for every key and look, monotone fronts, mark under glow, reach in [0.6, 1.35], plain look = API 7 weights, swipe-edge and mirror direction, climb-up keys, ghosts, swell, buffer layout and seven-number frames")
  }
}
