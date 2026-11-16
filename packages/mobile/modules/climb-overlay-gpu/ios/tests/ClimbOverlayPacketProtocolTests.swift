import Foundation
@main enum ClimbOverlayPacketProtocolTests {
  static func main() throws {
    func failure(_ status: Int32,_ scope: String?,staticConfig: Bool = false) {
      do { try checkClimbOverlayPacketStatus(status,staticConfig: staticConfig);preconditionFailure("Failure accepted") }
      catch let error as ClimbOverlayPacketFailure { precondition(error.event?.1 == scope) }
      catch { preconditionFailure("Unexpected failure") }
    }
    failure(-3,nil,staticConfig: true);failure(-4,nil);failure(-5,"context",staticConfig: true)
    failure(-6,"context");failure(-2,"frame");failure(-2,"static",staticConfig: true)
    func decode(_ root: [String: Any]) throws -> ClimbOverlayPacketHeader {
      let decoder = JSONDecoder();decoder.keyDecodingStrategy = .convertFromSnakeCase
      return try decoder.decode(ClimbOverlayPacketHeader.self,from: JSONSerialization.data(withJSONObject: root))
    }
    let scene: [String: Any] = ["offset":0,"bytes":224,"count":1,"max_reach":40,"stamp_layers":4,"tile_directory":257]
    var root: [String: Any] = ["version":1,"contractSha256":ClimbOverlayPacketLayout.contractSha256,
      "width":32,"height":32,"scenes":[scene,scene,scene],"present":[true,false,true],
      "current_roles":[[UInt32.max,47]],"changed_count":1,"columns":1,"tileEdge":32,"descriptorBytes":224,"uniformBytes":144]
    try decode(root).validate(descriptorPayloadBytes: 672,resourcePayloadBytes: 1036)
    func rejected(_ malformed: [String: Any]) {
      do { try decode(malformed).validate(descriptorPayloadBytes: 672,resourcePayloadBytes: 1036);preconditionFailure("Malformed packet accepted") } catch {}
    }
    root["current_roles"] = [[-1,47]];rejected(root)
    root["current_roles"] = [[1.2,47]];rejected(root)
    root["current_roles"] = [[1,47]];root["width"] = Int.max;rejected(root)
    root["width"] = 32;root["present"] = ["true",false,true];rejected(root)
    root["present"] = [true,false,true];var invalid = scene;invalid["offset"] = Int.max;root["scenes"] = [invalid,scene,scene];rejected(root)
    precondition(climbOverlayPacketDrained(before: 1,after: 1,nativeJobs: 0,gpuCommands: 0,rustDrained: true))
    precondition(!climbOverlayPacketDrained(before: 1,after: 2,nativeJobs: 0,gpuCommands: 0,rustDrained: true))
    precondition(!climbOverlayPacketDrained(before: 1,after: 1,nativeJobs: 1,gpuCommands: 0,rustDrained: true))
    precondition(!climbOverlayPacketDrained(before: 1,after: 1,nativeJobs: 0,gpuCommands: 1,rustDrained: true))
    precondition(!climbOverlayPacketDrained(before: 1,after: 1,nativeJobs: 0,gpuCommands: 0,rustDrained: false))
    print("Swift packet protocol: silent cancellation, scoped failures, UInt32 roles and checked packet bounds passed")
  }
}
