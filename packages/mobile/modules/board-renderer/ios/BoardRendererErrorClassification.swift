// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Boardsesh

import Foundation

/// Classifies the errors `BoardRendererModule`'s bounded whole-pipeline retry
/// (#4107) is allowed to treat as "the cache file/dir vanished, re-render once".
///
/// Foundation-only on purpose: this file is also compiled into the
/// `BoardseshTests` XCTest target (see `scripts/prepare-rn-ios-tests.mjs`), so
/// `BoardRendererErrorClassificationTests` can exercise it against errors a real
/// `Data.write(to:options:.atomic)` into a deleted directory actually throws —
/// without dragging ExpoModulesCore or the Rust renderer into the test build.
enum BoardRendererErrorClassification {
  /// How many `NSUnderlyingErrorKey` links to follow. Foundation nests at most
  /// a couple of levels in practice (e.g. a Cocoa write error wrapping the
  /// POSIX cause); the bound just guarantees termination on a pathological
  /// self-referencing chain.
  private static let maxUnderlyingErrorDepth = 4

  /// True when `error` means "the file or its directory isn't there" — the only
  /// failure shape the #4107 retry treats as a vanished, re-renderable cache
  /// entry:
  ///
  /// - `NSCocoaErrorDomain` / `NSFileNoSuchFileError` or
  ///   `NSFileReadNoSuchFileError` — what Foundation's file APIs report for a
  ///   missing path at the Cocoa layer, or
  /// - `NSPOSIXErrorDomain` / `ENOENT` — the lower-level POSIX shape.
  ///
  /// Foundation write failures don't always surface those at the top level: a
  /// Cocoa-domain wrapper (e.g. `NSFileWriteUnknownError`) can carry the real
  /// POSIX `ENOENT` in `userInfo[NSUnderlyingErrorKey]`, so the chain of
  /// underlying errors is unwrapped (bounded) and classified too.
  ///
  /// Everything else stays non-retryable: out-of-space and permission failures
  /// aren't fixed by re-rendering, and the three `"BoardRenderer"`-domain
  /// `NSError`s (Rust render failure, failed `CGImage` wrap, failed PNG
  /// encoding) are a different domain entirely — retrying a genuine encoder or
  /// render bug would waste work without fixing anything.
  static func isFileVanishedError(_ error: Error) -> Bool {
    var current = error as NSError
    for _ in 0..<maxUnderlyingErrorDepth {
      if matchesFileVanished(current) { return true }
      guard let underlying = current.userInfo[NSUnderlyingErrorKey] as? NSError else {
        return false
      }
      current = underlying
    }
    return false
  }

  private static func matchesFileVanished(_ nsError: NSError) -> Bool {
    if nsError.domain == NSCocoaErrorDomain,
      nsError.code == NSFileNoSuchFileError || nsError.code == NSFileReadNoSuchFileError
    {
      return true
    }
    if nsError.domain == NSPOSIXErrorDomain, nsError.code == Int(ENOENT) {
      return true
    }
    return false
  }
}
