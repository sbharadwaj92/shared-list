import Foundation

// JSON encoder / decoder factories that emit ISO8601 with millisecond
// fractional seconds — the format the backend's read feed uses
// (`date_trunc('milliseconds', now())` truncated, then serialized).
//
// Why we needed our own: `JSONEncoder.DateEncodingStrategy.iso8601` and
// `JSONDecoder.DateDecodingStrategy.iso8601` both wrap an
// `ISO8601DateFormatter` whose default `formatOptions` is
// `.withInternetDateTime` — second precision only, no fractional
// seconds. That meant every `Date` field we sent (including
// `If-Match` cursors and rename payload `ifMatch`) was rounded to the
// nearest second on the way out, even when the backend's row had
// millisecond precision. Two consecutive renames within the same
// second would then chain into a coarse `If-Match` value the server
// no longer matched, producing 409 storms with no underlying
// conflict — a real protocol bug, not just a test bug.
//
// We use a single shared formatter (rather than a custom Codable
// strategy per type) because (a) the strategy is one line of setup
// per `JSONEncoder/JSONDecoder` instance and (b) ISO8601DateFormatter
// is thread-safe in practice on Apple platforms.
//
// Decoding is permissive: try fractional-seconds first, fall back to
// bare-seconds. The backend always emits fractional, but a future
// migration or an external producer might not.

enum JSONCoders {
    /// Encoder configured for the wire format the backend expects.
    /// Use this everywhere we send `Date` over HTTP — APIClient,
    /// Mutator's queue payload encoding, and any future call site.
    static func makeEncoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(Self.iso8601MillisFormatter.string(from: date))
        }
        return encoder
    }

    /// Decoder configured to accept fractional-seconds AND bare-seconds
    /// ISO8601. Use this everywhere we read `Date` from HTTP responses.
    static func makeDecoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let raw = try container.decode(String.self)
            // Try fractional first — the backend always emits this
            // shape today, so we match the common case in one
            // formatter call.
            if let date = Self.iso8601MillisFormatter.date(from: raw) {
                return date
            }
            if let date = Self.iso8601SecondsFormatter.date(from: raw) {
                return date
            }
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "expected ISO8601 date string, got: \(raw)"
            )
        }
        return decoder
    }

    /// Shared formatter for emit + parse. Holding a single static
    /// instance is fine — `ISO8601DateFormatter` is documented as
    /// thread-safe on Apple platforms (it's an `NSFormatter` subclass
    /// with internal locking). Swift 6 doesn't know that, so we
    /// override the strict-concurrency check with
    /// `nonisolated(unsafe)`. The "unsafe" tag is appropriate: the
    /// safety claim is "Apple's runtime synchronizes internally,"
    /// which the compiler can't verify but which is part of the
    /// formatter's documented contract.
    nonisolated(unsafe) static let iso8601MillisFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    /// Fallback parser for second-precision strings. We don't emit in
    /// this shape — it exists so a defensive read against a non-
    /// backend producer (or a future migration) doesn't blow up.
    /// Same `nonisolated(unsafe)` rationale as above.
    nonisolated(unsafe) static let iso8601SecondsFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
}
