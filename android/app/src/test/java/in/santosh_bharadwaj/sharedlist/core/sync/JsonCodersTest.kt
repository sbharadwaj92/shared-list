package `in`.santosh_bharadwaj.sharedlist.core.sync

import `in`.santosh_bharadwaj.sharedlist.core.networking.InstantIso8601MillisSerializer
import `in`.santosh_bharadwaj.sharedlist.core.networking.JsonCoders
import java.time.Instant
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Pin the wire format for [Instant] fields. The slice-D iOS bug surfaced
 * because Foundation's defaults silently truncated millisecond precision —
 * exactly the kind of failure that's invisible until two devices fight an
 * If-Match war over a fractional-second mismatch. These tests document the
 * three properties that matter for the Android port:
 *
 *  1. Write produces ALWAYS three fractional digits (so `.000Z` doesn't
 *     collapse to bare seconds).
 *  2. Round-trip preserves the millisecond value exactly.
 *  3. Decoding tolerates both fractional and bare-seconds inputs (so a
 *     defensive read against a future migration doesn't blow up).
 */
class JsonCodersTest {

    @Serializable
    data class Holder(
        @Serializable(with = InstantIso8601MillisSerializer::class)
        val ts: Instant,
    )

    @Test
    fun writesExactlyThreeFractionalDigitsEvenForZero() {
        // Backend emits `…56.000Z` for a `now()` that hits a whole-second
        // boundary. iOS's `.iso8601` format-style would render `…56Z`
        // (collapsed). The fixed-pattern formatter must NOT.
        val ts = Instant.parse("2026-05-05T12:34:56.000Z")
        val json = JsonCoders.Json.encodeToString(Holder(ts))
        assertEquals("""{"ts":"2026-05-05T12:34:56.000Z"}""", json)
    }

    @Test
    fun writesNonZeroMillisCorrectly() {
        val ts = Instant.parse("2026-05-05T12:34:56.789Z")
        val json = JsonCoders.Json.encodeToString(Holder(ts))
        assertEquals("""{"ts":"2026-05-05T12:34:56.789Z"}""", json)
    }

    @Test
    fun truncatesSubMillisToWholeMillis() {
        // Sanity-pin: `Instant.ofEpochSecond(s, 1_999_999)` is `~2.0ms`. We
        // want consistent millisecond truncation (NOT rounding) — same
        // behavior as Postgres `date_trunc('milliseconds', now())` so the
        // server and client agree on the exact boundary value when an
        // `If-Match` chain races a server-side bump.
        val ts = Instant.ofEpochSecond(1_700_000_000L, 1_999_999L)
        val json = JsonCoders.Json.encodeToString(Holder(ts))
        assertEquals("""{"ts":"2023-11-14T22:13:20.001Z"}""", json)
    }

    @Test
    fun roundTripPreservesValue() {
        val original = Instant.parse("2026-05-05T12:34:56.789Z")
        val encoded = JsonCoders.Json.encodeToString(Holder(original))
        val decoded = JsonCoders.Json.decodeFromString<Holder>(encoded)
        assertEquals(original, decoded.ts)
    }

    @Test
    fun decodesBareSecondsForward() {
        // A future migration or external producer might emit bare-seconds
        // form. The lenient decoder must accept it without throwing.
        val json = """{"ts":"2026-05-05T12:34:56Z"}"""
        val decoded = JsonCoders.Json.decodeFromString<Holder>(json)
        assertEquals(Instant.parse("2026-05-05T12:34:56Z"), decoded.ts)
    }
}
