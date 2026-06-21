import ExpoModulesCore
import HealthKit
import os.log

/// Expo Module bridge that writes finished climbing sessions to Apple Health as
/// `HKWorkout`s. Direct port of the Capacitor `HealthKitPlugin` at repo-root
/// `mobile/ios/App/App/HealthKitPlugin.swift` — the ISO 8601 date parsing
/// fallbacks, the metadata keys, and the success+status authorization semantics
/// are preserved verbatim; only the outer bridge layer changes:
///
/// - `CAPPlugin` → `Module`
/// - `pluginMethods` declarations → `AsyncFunction` blocks in `definition()`
/// - `@objc func name(_ call: CAPPluginCall)` + `call.getX("k")` →
///   `AsyncFunction("name") { (opts: Record) in ... }`
/// - `call.resolve(...)` / `call.reject(...)` → `promise.resolve(...)` /
///   `promise.reject(code, message)`
///
/// New vs. the Capacitor plugin: an estimated active-energy-burned sample
/// (from the latest body-mass reading) and `.lap` workout events, both added
/// through `HKWorkoutBuilder` before `finishWorkout`.
public class HealthWorkoutsModule: Module {
    private let logger = Logger(subsystem: "com.boardsesh.app", category: "HealthWorkoutsModule")
    private let healthStore = HKHealthStore()

    // MET for indoor climbing/bouldering. The Compendium of Physical Activities
    // lists bouldering at roughly 4.8–5.8 METs; a whole-session duration spans
    // climbing plus rest between attempts, so we use the low-middle of the band
    // rather than a peak-effort value, which would overestimate calories.
    private let climbingMET = 5.0

    // Fallback body mass (kg) when the user has no recorded weight or hasn't
    // granted read access. Roughly an average adult; only used for the energy
    // estimate, never written back.
    private let fallbackBodyMassKg = 70.0

    // Parsing chain mirrors the Capacitor plugin (fractional ISO, plain ISO,
    // then a few SQL-style fallbacks). Formatters are created per call rather
    // than shared as statics: parseISO8601 runs from a detached Task and from
    // HealthKit query callbacks on arbitrary threads, and Apple only documents
    // DateFormatter (not ISO8601DateFormatter) as thread-safe. A handful of
    // allocations per save is irrelevant next to the HealthKit I/O.
    private static let fallbackFormats = [
        "yyyy-MM-dd'T'HH:mm:ss.SSSZ",
        "yyyy-MM-dd'T'HH:mm:ssZ",
        "yyyy-MM-dd HH:mm:ss.SSS",
        "yyyy-MM-dd HH:mm:ss",
    ]

    public func definition() -> ModuleDefinition {
        Name("HealthWorkouts")

        AsyncFunction("isAvailable") { () -> [String: Any] in
            ["available": HKHealthStore.isHealthDataAvailable()]
        }

        AsyncFunction("getAuthorizationStatus") { () -> [String: Any] in
            guard HKHealthStore.isHealthDataAvailable() else {
                return [
                    "status": "denied",
                    "workoutStatus": "denied",
                    "activeEnergyStatus": "denied",
                ]
            }
            // Read-only probe — never presents the consent sheet. UI uses this
            // on mount; requestAuthorization is reserved for explicit user
            // intent (it prompts undecided users).
            let workoutStatus = Self.statusString(
                self.healthStore.authorizationStatus(for: HKObjectType.workoutType())
            )
            let activeEnergyStatus = Self.statusString(
                self.healthStore.authorizationStatus(for: HKQuantityType(.activeEnergyBurned))
            )
            return [
                "status": workoutStatus,
                "workoutStatus": workoutStatus,
                "activeEnergyStatus": activeEnergyStatus,
            ]
        }

        AsyncFunction("requestAuthorization") { (promise: Promise) in
            self.requestAuthorization(promise: promise)
        }

        AsyncFunction("saveWorkout") { (options: SaveWorkoutOptions, promise: Promise) in
            self.saveWorkout(options: options, promise: promise)
        }
    }

    // MARK: - requestAuthorization

    private func requestAuthorization(promise: Promise) {
        guard HKHealthStore.isHealthDataAvailable() else {
            promise.resolve(["granted": false])
            return
        }

        let workoutType = HKObjectType.workoutType()
        let share: Set<HKSampleType> = [
            workoutType,
            HKQuantityType(.activeEnergyBurned),
        ]
        let read: Set<HKObjectType> = [
            workoutType,
            HKQuantityType(.bodyMass),
        ]

        healthStore.requestAuthorization(toShare: share, read: read) { [weak self] success, error in
            guard let self else {
                promise.resolve(["granted": false])
                return
            }
            if let error {
                self.logger.error("HealthKit auth error: \(error.localizedDescription, privacy: .public)")
                promise.resolve(["granted": false])
                return
            }
            // The success flag alone is `true` even when the user taps "Don't
            // Allow" — it only reports that the sheet completed. The old plugin
            // documents this; the real signal is the share authorization status
            // on the workout type.
            let status = self.healthStore.authorizationStatus(for: workoutType)
            let granted = success && status == .sharingAuthorized
            if !granted {
                self.logger.warning(
                    "HealthKit auth not granted. success=\(success), status=\(String(describing: status.rawValue))"
                )
            }
            let activeEnergyGranted =
                self.healthStore.authorizationStatus(for: HKQuantityType(.activeEnergyBurned)) == .sharingAuthorized
            promise.resolve(["granted": granted, "activeEnergyGranted": activeEnergyGranted])
        }
    }

    // MARK: - saveWorkout

    private func saveWorkout(options: SaveWorkoutOptions, promise: Promise) {
        guard HKHealthStore.isHealthDataAvailable() else {
            promise.reject("E_SAVE_FAILED", "HealthKit is not available on this device")
            return
        }

        guard let startDate = Self.parseISO8601(options.startDate),
              let endDate = Self.parseISO8601(options.endDate),
              endDate > startDate else {
            logger.error(
                "Invalid dates: startDate=\(options.startDate, privacy: .public) endDate=\(options.endDate, privacy: .public)"
            )
            promise.reject(
                "E_INVALID_DATES",
                "Invalid startDate/endDate: start=\(options.startDate), end=\(options.endDate)"
            )
            return
        }

        let durationSeconds = endDate.timeIntervalSince(startDate)
        logger.info(
            "Workout dates: start=\(options.startDate, privacy: .public) end=\(options.endDate, privacy: .public) duration=\(Int(durationSeconds))s"
        )

        var metadata: [String: Any] = [
            HKMetadataKeyExternalUUID: options.sessionId,
            HKMetadataKeyIndoorWorkout: true,
            HKMetadataKeyWorkoutBrandName: "Boardsesh",
            "BoardseshSessionId": options.sessionId,
            "BoardseshTotalSends": options.totalSends,
            "BoardseshTotalAttempts": options.totalAttempts,
            "BoardseshBoardType": options.boardType,
        ]
        if let hardestGrade = options.hardestGrade, !hardestGrade.isEmpty {
            metadata["BoardseshHardestGrade"] = hardestGrade
        }

        // Parse lap events up front; keep only those strictly inside the
        // session window. Out-of-range or unparseable entries are dropped.
        let laps: [WorkoutLap] = options.laps.filter { lap in
            guard let lapDate = Self.parseISO8601(lap.climbedAt) else { return false }
            return lapDate > startDate && lapDate < endDate
        }

        Task {
            do {
                if let existingWorkout = await self.findExistingWorkout(sessionId: options.sessionId) {
                    self.logger.info(
                        "Found existing climbing workout for session \(options.sessionId, privacy: .public)"
                    )
                    promise.resolve([
                        "workoutId": existingWorkout.uuid.uuidString,
                        "created": false,
                        "energyKilocalories": NSNull(),
                        "energySaved": false,
                        "lapCount": 0,
                    ])
                    return
                }

                let bodyMassKg = await self.latestBodyMassKilograms()
                let energyKilocalories = self.estimatedActiveEnergyKilocalories(
                    durationSeconds: durationSeconds,
                    bodyMassKg: bodyMassKg
                )
                var energySaved = false

                let configuration = HKWorkoutConfiguration()
                configuration.activityType = .climbing

                let builder = HKWorkoutBuilder(
                    healthStore: self.healthStore,
                    configuration: configuration,
                    device: nil
                )
                try await builder.beginCollection(at: startDate)
                try await builder.addMetadata(metadata)

                // Best-effort: the consent sheet lets the user grant Workouts
                // while toggling off Active Energy. requestAuthorization only
                // checks the workout type, so an energy write can still be
                // unauthorized here — that must never sink the workout itself.
                let energySample = HKQuantitySample(
                    type: HKQuantityType(.activeEnergyBurned),
                    quantity: HKQuantity(unit: .kilocalorie(), doubleValue: energyKilocalories),
                    start: startDate,
                    end: endDate
                )
                do {
                    try await builder.addSamples([energySample])
                    energySaved = true
                } catch {
                    self.logger.warning(
                        "Skipping active-energy sample (not authorized?): \(error.localizedDescription, privacy: .public)"
                    )
                }

                if !laps.isEmpty {
                    let lapEvents = laps.compactMap { lap -> HKWorkoutEvent? in
                        guard let lapDate = Self.parseISO8601(lap.climbedAt) else { return nil }
                        var lapMetadata: [String: Any] = [
                            "BoardseshTickUuid": lap.tickUuid,
                            "BoardseshClimbUuid": lap.climbUuid,
                            "BoardseshStatus": lap.status,
                            "BoardseshAttemptCount": lap.attemptCount,
                            "BoardseshBoardType": lap.boardType,
                        ]
                        if let climbName = lap.climbName, !climbName.isEmpty {
                            lapMetadata["BoardseshClimbName"] = climbName
                        }
                        if let grade = lap.grade, !grade.isEmpty {
                            lapMetadata["BoardseshGrade"] = grade
                        }
                        if let angle = lap.angle {
                            lapMetadata["BoardseshAngle"] = angle
                        }
                        return HKWorkoutEvent(
                            type: .lap,
                            dateInterval: DateInterval(start: lapDate, duration: 0),
                            metadata: lapMetadata
                        )
                    }
                    try await builder.addWorkoutEvents(lapEvents)
                }

                try await builder.endCollection(at: endDate)

                guard let workout = try await builder.finishWorkout() else {
                    promise.reject("E_SAVE_FAILED", "Failed to finish workout")
                    return
                }

                self.logger.info("Saved climbing workout for session \(options.sessionId, privacy: .public)")
                promise.resolve([
                    "workoutId": workout.uuid.uuidString,
                    "created": true,
                    "energyKilocalories": energyKilocalories,
                    "energySaved": energySaved,
                    "lapCount": laps.count,
                ])
            } catch {
                self.logger.error("Failed to save workout: \(error.localizedDescription, privacy: .public)")
                promise.reject("E_SAVE_FAILED", "Failed to save workout: \(error.localizedDescription)")
            }
        }
    }

    private static func statusString(_ status: HKAuthorizationStatus) -> String {
        switch status {
        case .sharingAuthorized:
            return "authorized"
        case .sharingDenied:
            return "denied"
        case .notDetermined:
            return "notDetermined"
        @unknown default:
            return "notDetermined"
        }
    }

    private func findExistingWorkout(sessionId: String) async -> HKWorkout? {
        await withCheckedContinuation { continuation in
            let predicate = HKQuery.predicateForObjects(
                withMetadataKey: HKMetadataKeyExternalUUID,
                allowedValues: [sessionId]
            )
            let sortByStartDate = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: false)
            let query = HKSampleQuery(
                sampleType: HKObjectType.workoutType(),
                predicate: predicate,
                limit: 1,
                sortDescriptors: [sortByStartDate]
            ) { [weak self] _, samples, error in
                if let error {
                    self?.logger.warning(
                        "Existing workout lookup failed: \(error.localizedDescription, privacy: .public)"
                    )
                }
                continuation.resume(returning: samples?.first as? HKWorkout)
            }
            healthStore.execute(query)
        }
    }

    // MARK: - Energy estimate

    /// Latest recorded body mass in kilograms, or the fallback when none exists
    /// or read access wasn't granted. A single most-recent sample is enough for
    /// a calorie estimate.
    private func latestBodyMassKilograms() async -> Double {
        let fallbackKilograms = fallbackBodyMassKg
        return await withCheckedContinuation { continuation in
            let bodyMassType = HKQuantityType(.bodyMass)
            let sortByEndDate = NSSortDescriptor(key: HKSampleSortIdentifierEndDate, ascending: false)
            let query = HKSampleQuery(
                sampleType: bodyMassType,
                predicate: nil,
                limit: 1,
                sortDescriptors: [sortByEndDate]
            ) { _, samples, _ in
                guard let sample = samples?.first as? HKQuantitySample else {
                    continuation.resume(returning: fallbackKilograms)
                    return
                }
                let kilograms = sample.quantity.doubleValue(for: .gramUnit(with: .kilo))
                continuation.resume(returning: kilograms)
            }
            healthStore.execute(query)
        }
    }

    /// kcal = MET * 3.5 * kg / 200 * minutes (the standard Compendium formula).
    private func estimatedActiveEnergyKilocalories(durationSeconds: TimeInterval, bodyMassKg: Double) -> Double {
        let minutes = durationSeconds / 60.0
        return climbingMET * 3.5 * bodyMassKg / 200.0 * minutes
    }

    // MARK: - Date parsing

    private static func parseISO8601(_ string: String) -> Date? {
        let isoWithFrac = ISO8601DateFormatter()
        isoWithFrac.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = isoWithFrac.date(from: string) { return date }

        let isoPlain = ISO8601DateFormatter()
        isoPlain.formatOptions = [.withInternetDateTime]
        if let date = isoPlain.date(from: string) { return date }

        // Fallback: try common non-ISO formats (e.g. SQL timestamp).
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        for format in fallbackFormats {
            formatter.dateFormat = format
            if let date = formatter.date(from: string) { return date }
        }

        return nil
    }
}

// MARK: - Argument Records

struct SaveWorkoutOptions: Record {
    @Field var sessionId: String = ""
    @Field var startDate: String = ""
    @Field var endDate: String = ""
    @Field var totalSends: Int = 0
    @Field var totalAttempts: Int = 0
    @Field var hardestGrade: String?
    @Field var boardType: String = ""
    @Field var laps: [WorkoutLap] = []
}

struct WorkoutLap: Record {
    @Field var tickUuid: String = ""
    @Field var climbedAt: String = ""
    @Field var climbUuid: String = ""
    @Field var climbName: String?
    @Field var grade: String?
    @Field var status: String = ""
    @Field var attemptCount: Int = 0
    @Field var boardType: String = ""
    @Field var angle: Int?
}
