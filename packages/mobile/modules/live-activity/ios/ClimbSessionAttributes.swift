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
        var queueItemUuid: String? = nil
        var mirrored: Bool? = nil
        var supportsMirroring: Bool? = nil
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
        /// Bumped by `updateRestTimer` so ActivityKit sees a changed state and
        /// re-renders; the rest timer itself lives in the App Group
        /// (`SharedConstants.restTimerKey`). Nil from server pushes and the
        /// native builders, which is harmless: the widget reads the App Group.
        var restRevision: Int? = nil
        /// Bumped when this phone's drive (2.7) changes, the
        /// same way `restRevision` is; the drive itself lives in the App Group
        /// (`SharedConstants.lightingWindowKey`), so a server push that leaves
        /// this out can't wipe the countdown. Optional so an older binary, or
        /// the backend's push, decodes without it.
        var lightingRevision: Int? = nil
    }

    var boardName: String
    var sessionId: String
}
