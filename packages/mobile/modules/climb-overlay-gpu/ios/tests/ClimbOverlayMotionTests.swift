import Foundation

/// Run with swiftc plus ../ClimbOverlayMotion.swift. No Expo runtime needed.
@main enum ClimbOverlayMotionTests {
  static func main() {
    for step in 0...1000 {
      let progress = Float(step)/1000
      for center in [Float(0),0.2,0.5,0.8,1] {
        let reveal = ClimbOverlayMotion.revealProgress(progress,centerX: center,mirrored: false)
        let mirrored = ClimbOverlayMotion.revealProgress(progress,centerX: 1-center,mirrored: true)
        precondition(abs(reveal-mirrored)<0.00001,"Mirror must preserve screen-space direction")
        precondition(reveal>=0 && reveal<=1)
        let oldRole = ClimbOverlayMotion.holdWeight(reveal: reveal,membership: 2,upper: false)
        let newRole = ClimbOverlayMotion.holdWeight(reveal: reveal,membership: 2,upper: true)
        precondition(oldRole>=0 && oldRole<=1 && newRole>=0 && newRole<=1)
        precondition(oldRole*newRole==0,"A changed hold never shows two role colours together")
        precondition(ClimbOverlayMotion.holdWeight(reveal: reveal,membership: 1,upper: false)==1)
        precondition(ClimbOverlayMotion.holdWeight(reveal: reveal,membership: 1,upper: true)==0)
        if step==0 { precondition(reveal==0) }
        if step==1000 { precondition(reveal==1) }
      }
    }
    let left = ClimbOverlayMotion.revealProgress(0.5,centerX: 0.2,mirrored: false)
    let right = ClimbOverlayMotion.revealProgress(0.5,centerX: 0.8,mirrored: false)
    precondition(right>left,"Next enters from the right")
    precondition(ClimbOverlayMotion.ownershipDistance(distance: 0,reach: 10,weight: 0.001)>1000,
      "Almost invisible holds cannot steal the existing glow even at distance zero")
    precondition(ClimbOverlayMotion.ownershipDistance(distance: 3,reach: 10,weight: 1)==3)
    precondition(ClimbOverlayMotion.ownershipDistance(distance: 0,reach: 10,weight: 0).isInfinite)
    let faintRunner = ClimbOverlayMotion.ownershipDistance(distance: 0,reach: 10,weight: 0.001)
    precondition(ClimbOverlayMotion.mergeDistance(actualNearest: 2,nearestScore: 2,runnerScore: faintRunner)>1000,
      "A faint same-colour runner cannot bulge the existing glow")
    precondition(ClimbOverlayMotion.mergeDistance(actualNearest: 2,nearestScore: 2,runnerScore: 3)==3)
    let forward = ClimbOverlayMotion.select(pagePosition: 12.25,centerPage: 12,
      hasPrevious: true,hasNext: true,reduceMotion: false)
    precondition(forward.lowerOffset == 0 && forward.upperOffset == 1 && forward.progress == 0.25)
    let back = ClimbOverlayMotion.select(pagePosition: 11.25,centerPage: 12,
      hasPrevious: true,hasNext: true,reduceMotion: false)
    precondition(back.lowerOffset == -1 && back.upperOffset == 0 && back.progress == 0.25)
    let end = ClimbOverlayMotion.select(pagePosition: 99,centerPage: 12,
      hasPrevious: true,hasNext: true,reduceMotion: false)
    precondition(end.progress == 1)
    let missing = ClimbOverlayMotion.select(pagePosition: 13,centerPage: 12,
      hasPrevious: true,hasNext: false,reduceMotion: false)
    precondition(missing.lowerOffset == 0 && missing.upperOffset == 0 && missing.progress == 0)
    let reduced = ClimbOverlayMotion.select(pagePosition: 12.75,centerPage: 12,
      hasPrevious: true,hasNext: true,reduceMotion: true)
    precondition(reduced.lowerOffset == 0 && reduced.upperOffset == 0 && reduced.progress == 0)
    precondition(ClimbOverlayMotion.editDuration == 0.250)
    precondition(ClimbOverlayMotion.editReachScale(elapsed: 0) == 1)
    precondition(abs(ClimbOverlayMotion.editReachScale(elapsed: 0.080)-1.20)<0.0001)
    precondition(ClimbOverlayMotion.editReachScale(elapsed: 0.250)==1)
    precondition(ClimbOverlayMotion.editReachScale(elapsed: 10)==1)
    precondition(ClimbOverlayMotion.editReachScale(elapsed: .nan)==1)
    precondition(ClimbOverlayMotion.editReachScale(elapsed: -1)==1)
    var previous: Float = 1
    for millisecond in 0...250 {
      let scale = ClimbOverlayMotion.editReachScale(elapsed: Double(millisecond)/1000)
      precondition(scale>=1 && scale<=1.20,"Expansion stays within immutable atlas padding")
      if millisecond<=80 { precondition(scale>=previous,"Expand to peak") }
      else { precondition(scale<=previous,"Contract monotonically to normal") }
      previous=scale
    }
    var pulse = ClimbOverlayMotion.EditorPulse()
    pulse.schedule()
    precondition(pulse.reachScale(at: 100)==1,"Preparation delay cannot consume the pulse")
    precondition(pulse.present(at: 100))
    precondition(!pulse.present(at: 101),"Repeated drawable readiness cannot restart the clock")
    precondition(abs(pulse.reachScale(at: 100.08)-1.20)<0.0001)
    pulse.cancel()
    precondition(pulse.reachScale(at: 100.08)==1 && !pulse.present(at: 102),
      "Cancellation restores normal reach and rejects delayed presentation")
    pulse.schedule()
    precondition(pulse.present(at: 200))
    pulse.schedule()
    precondition(pulse.reachScale(at: 200.08)==1,"Rapid edits replace, never queue, the pulse")
    pulse.cancel()
    precondition(!pulse.present(at: 201),"Suppressed pending edits cannot start later")
    print("Motion guards passed: reveal direction/mirror/roles, ownership, pager endpoints, and presentation-started 250ms reach expansion/cancellation")
  }
}
