package `in`.santosh_bharadwaj.sharedlist.core.networking

import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException
import java.time.temporal.ChronoUnit
import kotlinx.serialization.KSerializer
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.Json

/**
 * Wire-format JSON helpers. The ENTIRE Android sync stack — Mutator queue
 * payloads, drainer payloads, ApiClient request/response decoders — must
 * route through [Json] here. The single load-bearing piece is the custom
 * [Instant] serializer that emits ISO-8601 with millisecond fractional
 * seconds, matching the backend's wire shape.
 *
 * Why this matters (the iOS Phase 7 slice D bug, restated for Kotlin):
 * The backend's `/sync` feed emits timestamps via Postgres `to_jsonb` →
 * `JSON.stringify(Date)` → `2026-05-05T12:34:56.789Z` — millisecond
 * precision. The `If-Match` header expects the same shape. Two layers of
 * Kotlin's defaults will *silently* corrupt that if used naively:
 *
 *  1. **kotlinx.serialization has no built-in `Instant` serializer**.
 *     The user must supply one. The path of least resistance — a
 *     `String` field plus `Instant.parse(...)` at the call site — works
 *     on the read side but loses type-safety and forces every payload
 *     to do its own parsing. We define a contextual / explicit
 *     `@Serializable(with = …)` serializer instead.
 *  2. **`Instant.toString()` truncates trailing zero fractional digits**.
 *     For an instant whose nano-of-second is exactly 1_000_000 (1 ms),
 *     `Instant.toString()` returns `…001Z` — fine. But for an instant
 *     constructed from a backend timestamp ending in `.000Z`,
 *     `Instant.toString()` returns the bare-seconds form `…56Z`,
 *     dropping the fractional component entirely. Sending that as
 *     `If-Match` to a backend that has `…56.000Z` on disk is a 409
 *     storm waiting to happen.
 *
 * The serializer below uses a [DateTimeFormatter] pinned to ISO-8601
 * with exactly 3 fractional digits on the way OUT (so `.000Z` never
 * collapses). On the way IN it parses with the lenient
 * `DateTimeFormatter.ISO_INSTANT` which accepts both fractional and
 * bare-seconds forms — the backend always emits fractional, but a
 * defensive read against a future migration shouldn't blow up.
 *
 * Public so test code (Mutator/Drainer tests) can encode and decode
 * payloads through the same configuration that production uses.
 */
public object JsonCoders {
    /**
     * Pre-built [Json] instance. Single shared instance is fine —
     * kotlinx.serialization's `Json` is documented as thread-safe and
     * intended to be reused.
     *
     * Configuration:
     *   - `ignoreUnknownKeys = true` so a future backend field addition
     *     doesn't break older clients. Mirrors the iOS APIClient setup.
     *   - `explicitNulls = false` so an absent field decodes as `null`
     *     and an `Instant?` property serialized as `null` re-emits as
     *     the JSON literal `null`. The Mutator's three-state
     *     `OptionalChange` for the `checked` field is built on top of
     *     this via JsonElement — see `Mutator.kt`.
     *   - `encodeDefaults = false` so optional fields with default
     *     values stay out of the wire body unless explicitly set.
     */
    public val Json: Json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
        encodeDefaults = false
    }
}

/**
 * kotlinx.serialization adapter for `java.time.Instant`. Use as
 * `@Serializable(with = InstantIso8601MillisSerializer::class)` on
 * any `Instant` field that crosses the wire.
 *
 * We avoid `kotlinx-datetime` (which has its own `Instant` type) on
 * purpose — Room's TypeConverters and JDK 8 time interop are smoothest
 * when we stay on `java.time.Instant` end-to-end. Adding a parallel
 * universe of types just for serialization would be a bigger lift than
 * a 30-line custom serializer.
 */
public object InstantIso8601MillisSerializer : KSerializer<Instant> {
    private val outFormatter: DateTimeFormatter =
        DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss.SSS'Z'")
            .withZone(ZoneOffset.UTC)

    override val descriptor: SerialDescriptor =
        PrimitiveSerialDescriptor("Instant", PrimitiveKind.STRING)

    override fun serialize(encoder: Encoder, value: Instant) {
        // Truncate to milliseconds first so fractional-digit stability is
        // guaranteed — without this, a wider-precision input (e.g. an
        // Instant built from System.nanoTime() in a test) would round
        // unevenly and break exact-equality assertions.
        val truncated = value.truncatedTo(ChronoUnit.MILLIS)
        encoder.encodeString(outFormatter.format(truncated))
    }

    override fun deserialize(decoder: Decoder): Instant {
        val raw = decoder.decodeString()
        return parseLenient(raw)
    }

    /**
     * Parse-side lenience: try the strict fractional-millis format
     * first, then fall back to `ISO_INSTANT`'s built-in flexibility
     * (handles both fractional and bare-seconds shapes). The backend
     * always emits fractional today, so the common path is the first
     * branch.
     */
    private fun parseLenient(raw: String): Instant {
        return try {
            Instant.from(outFormatter.parse(raw))
        } catch (_: DateTimeParseException) {
            Instant.parse(raw)
        }
    }
}
