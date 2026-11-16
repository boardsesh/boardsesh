import Foundation

/// Compile with ../ClimbOverlayAtlas.swift and ../ClimbOverlayMotion.swift.
@main enum ClimbOverlayAtlasTests {
  static func main() throws {
    func stamp(_ offset: Int) -> [String: Any] {
      ["offset":offset,"x":1,"y":2,"width":1,"height":1]
    }
    func full(_ state: Int,_ identity: Int? = nil,_ annotation: Bool = false) -> [String: Any] {
      ["state":state,"identity":identity ?? state,"color":[77,245,253],"annotation":annotation,
       "fillPasses":[NSNull(),stamp(256),NSNull(),NSNull()],"plate":NSNull(),
       "glyphPasses":[NSNull(),stamp(260)]]
    }
    func bytes(_ roles: [[String: Any]],second: [[String: Any]]? = nil,mirrored: Bool = false) throws -> Data {
      func hold(_ id: Int,_ mirror: Int,_ roles: [[String: Any]]) -> [String: Any] {
        ["id":id,"mirror":mirror,"x":0,"y":0,"width":8,"height":8,"bounds":[1,2,3,4],"field":0,"reach":12,"roles":roles]
      }
      var holds = [hold(1,2,roles)]
      if let second { holds.append(hold(2,1,second)) }
      let root: [String: Any] = ["version":2,"width":8,"height":8,"covers":NSNull(),"veil":[0,0,0,0],
        "mirrored":mirrored,"glow":true,"merge":0,"seam":0,"seamMix":0,"seamSharpness":0,
        "fringe":0,"coreShare":0,"lut":Array(repeating: 0,count: 257),"holds":holds]
      return try JSONSerialization.data(withJSONObject: root,options: [.sortedKeys])
    }
    func rejected(_ data: Data) {
      do { _ = try decodeClimbOverlayAtlasManifest(data); preconditionFailure("Malformed role metadata accepted") }
      catch {}
    }
    func descriptorBytes(_ descriptor: GPUHold) -> Data {
      var copy = descriptor
      return withUnsafeBytes(of: &copy) { Data($0) }
    }
    let compact = try decodeClimbOverlayAtlasManifest(bytes([full(13),["state":43,"alias":13]]))
    let expanded = try decodeClimbOverlayAtlasManifest(bytes([full(13),full(43,13)]))
    let hold = compact.holds[0]
    precondition(hold.roles.map(\.state) == [13,43])
    precondition(hold.roles.map(\.identity) == [13,13])
    let canonical = makeClimbOverlayGPUHold(hold: hold,role: hold.roles[0])
    let alias = makeClimbOverlayGPUHold(hold: hold,role: hold.roles[1])
    let legacy = makeClimbOverlayGPUHold(hold: expanded.holds[0],role: expanded.holds[0].roles[1])
    precondition(MemoryLayout<GPUHold>.stride == 224)
    precondition(descriptorBytes(canonical) == descriptorBytes(alias))
    precondition(descriptorBytes(alias) == descriptorBytes(legacy))
    precondition(alias.identity == SIMD4(1,13,0,0))
    precondition(alias.offsets.y == .max && alias.offsets.w == .max)
    precondition(alias.extraOffsets.x == 256 && alias.extraOffsets.w == 260)
    precondition(alias.fillCrop1 == SIMD4(1,2,1,1) && alias.glyphCrop1 == SIMD4(1,2,1,1))
    precondition(alias.stampLayers == 5,"Later-only fill and glyph passes survive aliases")
    let auxiliary = try decodeClimbOverlayAtlasManifest(bytes([full(46,nil,true),["state":47,"alias":46]],
      second: [full(46,nil,true),["state":47,"alias":46]],mirrored: true))
    let mirroredHold = auxiliary.holds.first { $0.id == auxiliary.holds[0].mirror }!
    let auxiliaryAlias = makeClimbOverlayGPUHold(hold: mirroredHold,role: mirroredHold.roles[1])
    precondition(auxiliaryAlias.identity == SIMD4(2,46,1,0))
    precondition(auxiliaryAlias.stampLayers == 8,"AUX aliases do not enter fill/glow layers")
    let boundary = try decodeClimbOverlayAtlasManifest(bytes([full(4294967295),["state":0,"alias":4294967295]]))
    precondition(boundary.holds[0].roles[1].state == 0 && boundary.holds[0].roles[1].identity == .max)
    let maximum = [full(0)] + (1..<32).map { ["state":$0,"alias":0] }
    let maximumManifest = try decodeClimbOverlayAtlasManifest(bytes(maximum))
    precondition(maximumManifest.holds[0].roles.count == 32)
    rejected(try bytes(maximum + [["state":32,"alias":0]]))
    // Prior expanded full rows remain readable but cannot serve as alias targets.
    _ = try decodeClimbOverlayAtlasManifest(bytes([full(42,13)]))
    rejected(try bytes([full(13),full(42,13),["state":43,"alias":42]]))
    for aliasRow: [String: Any] in [
      ["state":43,"alias":13,"color":[0,0,0]],
      ["state":43,"alias":13,"unknownOverride":true],
      ["state":43,"alias":NSNull()],
      ["state":13,"alias":13],
      ["state":43,"alias":43],
      ["state":43,"alias":99],
      ["state":43,"alias":"13"],
      ["state":43,"alias":true],
      ["state":43,"alias":13.5],
      ["state":43,"alias":4294967296],
    ] { rejected(try bytes([full(13),aliasRow])) }
    rejected(try bytes([["state":43,"alias":13],full(13)]))
    rejected(try bytes([full(13),["state":43,"alias":13],["state":44,"alias":43]]))
    rejected(try bytes([full(13)],second: [["state":43,"alias":13]]))
    let original = String(data: try bytes([full(13)]),encoding: .utf8)!
    for numeric in ["true","\"13\"","null","-1","4294967296","13.5","13.0","13e0"] {
      rejected(Data(original.replacingOccurrences(of: "\"state\":13",with: "\"state\":"+numeric).utf8))
      rejected(Data(original.replacingOccurrences(of: "\"identity\":13",with: "\"identity\":"+numeric).utf8))
    }
    print("Swift atlas aliases: descriptor, AUX, mirror, limits and malformed metadata passed")
  }
}
