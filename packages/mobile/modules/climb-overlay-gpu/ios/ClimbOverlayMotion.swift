import Foundation

/// Pure motion policy, shared by the native view and its standalone tests.
enum ClimbOverlayMotion {
  static let editDuration: Double = 0.120
  static let editLift: Float = 0.12

  struct Selection {
    let lowerOffset: Int
    let upperOffset: Int
    let progress: Float
  }

  static func select(pagePosition: Double, centerPage: Double, hasPrevious: Bool,
                     hasNext: Bool, reduceMotion: Bool) -> Selection {
    guard !reduceMotion, pagePosition.isFinite, centerPage.isFinite else {
      return Selection(lowerOffset: 0,upperOffset: 0,progress: 0)
    }
    let delta = min(1,max(-1,pagePosition-centerPage))
    if delta < 0 && hasPrevious {
      return Selection(lowerOffset: -1,upperOffset: 0,progress: Float(1+delta))
    }
    if delta > 0 && hasNext {
      return Selection(lowerOffset: 0,upperOffset: 1,progress: Float(delta))
    }
    return Selection(lowerOffset: 0,upperOffset: 0,progress: 0)
  }

  /// The final compositor already weights the lower source by 1-p and the
  /// upper source by p. These extra scales make a changed role go fully dark
  /// before the other role lights, rather than inventing a third role colour.
  static func roleScales(_ progress: Float) -> (lower: Float, upper: Float) {
    let progress = min(1, max(0, progress.isFinite ? progress : 0))
    let lower = progress < 1 ? max(0, 1 - 2 * progress) / (1 - progress) : 0
    let upper = progress > 0 ? max(0, 2 * progress - 1) / progress : 0
    return (lower, upper)
  }

  static func editIllumination(elapsed: Double) -> Float {
    guard elapsed.isFinite, elapsed >= 0, elapsed < editDuration else { return 1 }
    let remaining = Float(1 - elapsed / editDuration)
    return 1 + editLift * remaining * remaining
  }
}
