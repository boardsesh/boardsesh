import Foundation
import UIKit
import os.log
import SDWebImage
import SDWebImageWebPCoder

// MARK: - ThumbnailFetcher

/// Fetches climb hold-overlay thumbnails from the server and caches them in
/// the App Group shared container so Live Activities can display them. The
/// request intentionally omits `include_background=1`; bundled board photos
/// must not be fetched over the network from native widget code. Instead the
/// holds overlay is composited on top of the bundled board-background webp(s)
/// staged by `LiveActivityModule.startSession` (the no-network-board-art rule),
/// so the cached thumbnail the widget renders carries the full board photo.
actor ThumbnailFetcher {

    // MARK: - Configuration

    /// Maximum number of cached thumbnails before eviction kicks in.
    static let maxCachedThumbnails = 10

    /// Subdirectory inside the shared container where thumbnails are stored.
    static let thumbnailsDirectory = "thumbnails"

    /// Bumped when the cached thumbnail's content contract changes, so a build
    /// with new compositing logic discards thumbnails written by older builds
    /// instead of serving them stale. The App Group container survives app
    /// updates, so without this an upgrading user keeps seeing the previous
    /// build's images. v1 = overlay-only (no board art); v2/v3 = on-device
    /// compositing of the bundled board art behind the holds overlay, which never
    /// rendered correctly in production (v2 decoded the bundled webp via Apple
    /// ImageIO, which fails on the lossy VP8 art; v3 switched to libwebp but still
    /// fell back to overlay-only). v4 = the server returns the fully composited
    /// thumbnail (include_background=1), so the board photo always shows. v5 =
    /// the render now passes dim_background=0.18 (board photo darkened behind the
    /// holds for readability), so v4 thumbnails are visually stale and must be
    /// refetched. The cache key is the climbUuid (not the URL), so the new param
    /// alone would otherwise keep serving the old image. Mirrors
    /// `RENDERER_VERSION` in use-native-climb-render.ts, which solved the same
    /// transition in-app.
    static let cacheVersion = 5

    // MARK: - Dependencies

    private let urlSession: URLSession
    private let fileManager: FileManager
    private let sharedDefaults: UserDefaults?
    private let sharedContainerUrl: URL?
    private let logger = Logger(subsystem: "com.boardsesh.app", category: "ThumbnailFetcher")

    /// Guards the one-per-process stale-cache purge.
    private var didPurgeStaleCache = false

    // MARK: - In-flight deduplication

    /// Prevents duplicate fetches for the same climb UUID.
    private var inFlightTasks: [String: Task<URL?, Never>] = [:]

    /// Decoded board-background layers keyed by file path, so a multi-set board
    /// and adjacent-thumbnail pre-fetches don't re-read the same files from disk
    /// on every composite. Pruned to the active board's paths in
    /// `compositeWithBoardBackground`, so it holds only the current board's
    /// handful of layers. Lives in the main-app process (this actor is owned by
    /// LiveActivityManager), not the memory-constrained widget extension.
    private var backgroundLayerCache: [String: UIImage] = [:]

    // MARK: - Init

    init(
        urlSession: URLSession = .shared,
        fileManager: FileManager = .default,
        sharedDefaults: UserDefaults? = SharedConstants.sharedDefaults,
        sharedContainerUrl: URL? = SharedConstants.sharedContainerUrl
    ) {
        self.urlSession = urlSession
        self.fileManager = fileManager
        self.sharedDefaults = sharedDefaults
        self.sharedContainerUrl = sharedContainerUrl
    }

    // MARK: - Public API

    /// Builds the thumbnail URL for a given queue item using board details
    /// stored in shared UserDefaults.
    func buildThumbnailURL(for item: SharedQueueItem) -> URL? {
        guard let defaults = sharedDefaults else { return nil }
        return SharedQueueState.boardRenderUrl(for: item, from: defaults)
    }

    /// Fetches a thumbnail for the given queue item and returns a file URL
    /// pointing to the cached image in the shared container.
    ///
    /// Returns `nil` if any step fails (network error, missing config, etc.).
    func fetchThumbnail(for item: SharedQueueItem) async -> URL? {
        // Drop thumbnails written by an older build before any cache hit, so a
        // version bump (e.g. overlay-only → board-composited) forces a re-render.
        purgeStaleCacheIfNeeded()

        // Return cached file if it already exists.
        if let cached = cachedFileURL(for: item.climbUuid), fileManager.fileExists(atPath: cached.path) {
            // Touch the file so eviction treats it as recently used.
            try? fileManager.setAttributes(
                [.modificationDate: Date()],
                ofItemAtPath: cached.path
            )
            return cached
        }

        // Deduplicate in-flight requests for the same climb.
        if let existing = inFlightTasks[item.climbUuid] {
            return await existing.value
        }

        let task = Task<URL?, Never> { [weak self] in
            guard let self else { return nil }
            return await self._fetchAndSave(item: item)
        }

        inFlightTasks[item.climbUuid] = task
        defer { inFlightTasks.removeValue(forKey: item.climbUuid) }
        return await task.value
    }

    /// Pre-fetches thumbnails for the current item and its immediate
    /// neighbors in the queue (indices currentIndex-1, currentIndex,
    /// currentIndex+1).
    func preFetchAdjacentThumbnails(
        queue: [SharedQueueItem],
        currentIndex: Int
    ) async {
        let indices = [currentIndex - 1, currentIndex, currentIndex + 1]
            .filter { $0 >= 0 && $0 < queue.count }

        await withTaskGroup(of: Void.self) { group in
            for index in indices {
                let item = queue[index]
                group.addTask { [weak self] in
                    _ = await self?.fetchThumbnail(for: item)
                }
            }
        }
    }

    /// Clears the thumbnail cache once per process when the stored cache version
    /// differs from `cacheVersion` — i.e. after an app update whose compositing
    /// contract changed. Without this, the App Group container (which survives
    /// updates) would keep serving a prior build's thumbnails (e.g. overlay-only
    /// images from before board compositing) straight from the cache check.
    private func purgeStaleCacheIfNeeded() {
        guard !didPurgeStaleCache else { return }
        didPurgeStaleCache = true

        let storedVersion = sharedDefaults?.integer(forKey: SharedConstants.thumbnailCacheVersionKey) ?? 0
        guard storedVersion != Self.cacheVersion else { return }

        if let directory = thumbnailsDirectoryURL(),
           let files = try? fileManager.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil, options: .skipsHiddenFiles) {
            for file in files {
                try? fileManager.removeItem(at: file)
            }
            logger.notice("Purged \(files.count) stale thumbnail(s) (cache version \(storedVersion, privacy: .public) → \(Self.cacheVersion, privacy: .public))")
        }
        sharedDefaults?.set(Self.cacheVersion, forKey: SharedConstants.thumbnailCacheVersionKey)
    }

    /// Removes the oldest thumbnails when the cache exceeds `maxCachedThumbnails`.
    func evictOldThumbnails() {
        guard let directory = thumbnailsDirectoryURL() else { return }

        guard let files = try? fileManager.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: [.contentModificationDateKey],
            options: .skipsHiddenFiles
        ) else { return }

        guard files.count > Self.maxCachedThumbnails else { return }

        // Sort oldest first by modification date.
        let sorted = files.sorted { lhs, rhs in
            let lhsDate = (try? lhs.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
            let rhsDate = (try? rhs.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
            return lhsDate < rhsDate
        }

        let countToRemove = sorted.count - Self.maxCachedThumbnails
        for file in sorted.prefix(countToRemove) {
            try? fileManager.removeItem(at: file)
        }
    }

    // MARK: - Internal Helpers

    /// Returns the file URL where a thumbnail for the given climb UUID
    /// would be stored, or `nil` if the shared container is unavailable.
    func cachedFileURL(for climbUuid: String) -> URL? {
        guard let directory = thumbnailsDirectoryURL() else { return nil }
        return directory.appendingPathComponent("\(climbUuid).webp")
    }

    /// Returns the thumbnails directory URL inside the shared container,
    /// creating the directory if it does not exist.
    func thumbnailsDirectoryURL() -> URL? {
        guard let container = sharedContainerUrl else { return nil }
        let directory = container.appendingPathComponent(Self.thumbnailsDirectory)

        if !fileManager.fileExists(atPath: directory.path) {
            try? fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        }

        return directory
    }

    // MARK: - Private

    private func _fetchAndSave(item: SharedQueueItem) async -> URL? {
        guard let remoteURL = buildThumbnailURL(for: item) else { return nil }
        guard let fileURL = cachedFileURL(for: item.climbUuid) else { return nil }

        do {
            let (data, response) = try await urlSession.data(from: remoteURL)

            guard let httpResponse = response as? HTTPURLResponse,
                  (200...299).contains(httpResponse.statusCode)
            else {
                return nil
            }

            // 2.0: the server returns the fully composited thumbnail (board photo
            // behind the holds overlay, via include_background=1 in boardRenderUrl),
            // matching the legacy Capacitor app. Persist it directly — no on-device
            // webp decode/composite. The bundled-board-art compositing below is
            // retained but unused, pending the "offline board art" revisit issue.
            try data.write(to: fileURL, options: .atomic)

            // Evict after writing so we stay within the cache limit.
            // Note: called within the actor, so file I/O runs on the actor's
            // serial executor. The cache is small (maxCachedThumbnails=10),
            // keeping this synchronous to avoid unnecessary suspension points.
            evictOldThumbnails()

            return fileURL
        } catch {
            // Network or I/O error -- return nil gracefully.
            return nil
        }
    }

    // MARK: - Background Compositing

    /// Bundled board-background webp file paths staged by `startSession`
    /// (`SharedConstants.boardBackgroundPathsKey`). Empty when no bundled
    /// background resolved for the active board.
    private func stagedBackgroundPaths() -> [String] {
        sharedDefaults?.stringArray(forKey: SharedConstants.boardBackgroundPathsKey) ?? []
    }

    /// Decoded background layer for a path, memoized in `backgroundLayerCache`.
    ///
    /// The bundled board art is lossy VP8 webp, which Apple's ImageIO
    /// (`UIImage(contentsOfFile:)`) does not reliably decode — it returns nil, so
    /// the composite was silently dropping the board photo and caching the
    /// holds-only overlay. Decode webp through libwebp (`SDImageWebPCoder`, the
    /// same coder expo-image falls back to for these files) instead. Call the
    /// coder directly rather than via `SDImageCodersManager.shared`: expo-image's
    /// registered webp coder defaults to Apple's ImageIO codec, which would fail
    /// the same way. Non-webp paths (defensive) fall back to `UIImage(data:)`.
    private func backgroundLayer(at path: String) -> UIImage? {
        if let cached = backgroundLayerCache[path] { return cached }
        guard let data = fileManager.contents(atPath: path) else { return nil }
        let image: UIImage?
        if SDImageWebPCoder.shared.canDecode(from: data) {
            image = SDImageWebPCoder.shared.decodedImage(with: data, options: nil)
        } else {
            image = UIImage(data: data)
        }
        guard let decoded = image else { return nil }
        backgroundLayerCache[path] = decoded
        return decoded
    }

    /// Drops all cached background layers. Called on a board/session change so
    /// the previous board's decoded images don't linger until the next composite
    /// (the only other place the cache is pruned) — e.g. when a new session
    /// starts but no thumbnail is requested before the app backgrounds.
    func clearBackgroundLayerCache() {
        backgroundLayerCache.removeAll()
    }

    /// Largest dimension (px) of the cached composite. The widget never shows
    /// the thumbnail larger than the 80×100pt lock-screen image (~240×300px at
    /// 3×), so capping the long side here keeps the PNG small without visible
    /// loss — and bounds it regardless of the server overlay's native size.
    private static let maxCompositeDimension: CGFloat = 384

    /// Draws the holds overlay on top of the staged board-background layer(s),
    /// returning encoded PNG data. Returns `nil` when there's no usable
    /// background (so the caller keeps the raw overlay) — never throws.
    ///
    /// Background and overlay fill the same frame: the server renders the overlay
    /// in the board's coordinate space and each bundled background is that same
    /// board image, so an identical fill rect keeps the climb circles aligned
    /// over the holds. The canvas is the overlay aspect ratio scaled down to fit
    /// `maxCompositeDimension` (never up), at `scale = 1` so points map 1:1 to px.
    ///
    /// PNG, with a non-opaque context, is required — NOT JPEG. The bundled board
    /// art is a per-set hold render on transparency (measured 74–90% fully
    /// transparent pixels), not an opaque board photo, and the server overlay is
    /// likewise transparent. The composite must keep its alpha so the widget's
    /// dark `activityBackgroundTint` shows through; flattening to JPEG would turn
    /// the transparent board into a solid black block. PNG + the downscale above
    /// is the simplest alpha-preserving output (we could now re-encode webp via the
    /// linked `SDImageWebPCoder`, but the downscaled PNG is already tiny), and the
    /// cache also stays bounded to `maxCachedThumbnails`.
    private func compositeWithBoardBackground(overlayData: Data) -> Data? {
        let paths = stagedBackgroundPaths()
        // Evict cached layers for boards we've navigated away from (and clear
        // entirely when nothing is staged) so the cache tracks the active board.
        let activePaths = Set(paths)
        backgroundLayerCache = backgroundLayerCache.filter { activePaths.contains($0.key) }

        // These notices are the on-device diagnostic for "board photo missing":
        // they pinpoint whether JS staged paths, and whether they decoded.
        guard !paths.isEmpty else {
            logger.notice("composite skipped: no board-background paths staged → holds-only overlay")
            return nil
        }
        guard let overlay = UIImage(data: overlayData) else {
            logger.error("composite skipped: server overlay failed to decode")
            return nil
        }

        let backgroundLayers = paths.compactMap { backgroundLayer(at: $0) }
        guard !backgroundLayers.isEmpty else {
            logger.error("composite skipped: \(paths.count, privacy: .public) staged path(s) but 0 decoded via SDImageWebPCoder — first: \(paths.first ?? "?", privacy: .public)")
            return nil
        }
        logger.notice("composite: \(backgroundLayers.count, privacy: .public)/\(paths.count, privacy: .public) background layer(s) under overlay")

        let nativeSize = overlay.size
        guard nativeSize.width > 0, nativeSize.height > 0 else { return nil }

        // Downscale only — preserve aspect ratio, never upscale a small overlay.
        let downscale = min(1, Self.maxCompositeDimension / max(nativeSize.width, nativeSize.height))
        let size = CGSize(
            width: (nativeSize.width * downscale).rounded(),
            height: (nativeSize.height * downscale).rounded()
        )

        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = false

        let renderer = UIGraphicsImageRenderer(size: size, format: format)
        let composed = renderer.image { _ in
            let rect = CGRect(origin: .zero, size: size)
            for layer in backgroundLayers {
                layer.draw(in: rect)
            }
            overlay.draw(in: rect)
        }
        return composed.pngData()
    }
}
