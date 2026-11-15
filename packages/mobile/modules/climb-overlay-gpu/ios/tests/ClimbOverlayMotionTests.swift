import Foundation

/// Run with swiftc plus ../ClimbOverlayMotion.swift. No Expo runtime needed.
@main enum ClimbOverlayMotionTests {
  static func main() {
    for step in 0...1000 {
      let progress = Float(step)/1000
      let scales = ClimbOverlayMotion.roleScales(progress)
      let oldRole = (1-progress)*scales.lower
      let newRole = progress*scales.upper
      precondition(oldRole >= 0 && oldRole <= 1 && newRole >= 0 && newRole <= 1)
      precondition(oldRole*newRole == 0,"A changed hold must never show a third role colour")
    }
    precondition(ClimbOverlayMotion.roleScales(0).lower == 1)
    precondition(ClimbOverlayMotion.roleScales(1).upper == 1)
    let midpoint = ClimbOverlayMotion.roleScales(0.5)
    precondition(midpoint.lower == 0 && midpoint.upper == 0)
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
    precondition(abs(ClimbOverlayMotion.editIllumination(elapsed: 0)-1.12)<0.0001)
    precondition(abs(ClimbOverlayMotion.editIllumination(elapsed: 0.06)-1.03)<0.0001)
    precondition(ClimbOverlayMotion.editIllumination(elapsed: 0.12)==1)
    precondition(ClimbOverlayMotion.editIllumination(elapsed: 10)==1)
    precondition(ClimbOverlayMotion.editIllumination(elapsed: .nan)==1)
    print("Motion guards passed: 1,001 role positions, pager endpoints, missing neighbour, Reduce Motion, 120ms settle")
  }
}
