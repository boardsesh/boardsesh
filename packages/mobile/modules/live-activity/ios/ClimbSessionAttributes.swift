import ActivityKit
import Foundation

@available(iOS 16.1, *)
struct ClimbSessionAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var climbName: String
        var climbDifficulty: String
        var angle: Int
        var currentIndex: Int
        var totalClimbs: Int
        var hasNext: Bool
        var hasPrevious: Bool
        var climbUuid: String
        /// Who currently drives the board, from THIS device's point of view:
        /// "connectedByMe" | "heldByPeer" | "disconnected". Optional so an older
        /// binary decoding a newer push (or vice-versa) never fails to decode;
        /// the widget treats `nil` as "connectedByMe" to preserve the pre-
        /// ownership behaviour during rollout.
        var boardConnection: String?
        /// Display name of the climber holding the board when
        /// `boardConnection == "heldByPeer"` (nil for anonymous holders and for
        /// the other states). Powers the "<name> is on the wall" affordance.
        var holderDisplayName: String?
    }

    var boardName: String
    var sessionId: String
}
