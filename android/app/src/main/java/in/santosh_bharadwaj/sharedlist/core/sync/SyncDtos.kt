package `in`.santosh_bharadwaj.sharedlist.core.sync

import `in`.santosh_bharadwaj.sharedlist.core.networking.InstantIso8601MillisSerializer
import java.time.Instant
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

// Wire types that mirror `backend/src/features/sync/schemas.ts`.
//
// Same naming convention as the auth DTOs: data-class names match the
// backend's Zod schema names, JSON keys match the wire camelCase, dates
// (de)serialize via the explicit [InstantIso8601MillisSerializer] so the
// fractional-millisecond precision the backend emits is preserved.
//
// We keep these DTOs distinct from the Room `@Entity` types in
// `SyncEntities.kt` for two reasons:
//   1. Wire shapes change with the protocol; persistence shapes change
//      with the local store. Coupling the two means a protocol field
//      rename forces a Room migration even when the local cache is
//      unaffected.
//   2. Room entities are reference types tied to schema rules
//      (annotations, primary key shape); DTOs are plain Kotlin
//      `@Serializable` value classes that move freely between coroutines.
//
// Conversion (DTO → entity, applied through the LWW guard) lives in the
// [SyncEngine], not on the DTOs — keeping the persistence write side in
// one place.

@Serializable
public data class ListDto(
    public val id: String,
    public val name: String,
    public val createdBy: String,
    @Serializable(with = InstantIso8601MillisSerializer::class)
    public val createdAt: Instant,
    @Serializable(with = InstantIso8601MillisSerializer::class)
    public val updatedAt: Instant,
    @Serializable(with = InstantIso8601MillisSerializer::class)
    public val deletedAt: Instant? = null,
)

@Serializable
public data class ItemDto(
    public val id: String,
    public val listId: String,
    public val text: String,
    /**
     * Wire field name from the backend: `checked` (a nullable timestamp).
     * We deserialize into a Kotlin property called `checkedAt` for
     * clarity at the call site — `checked: null` vs `checkedAt: null`
     * is the same boolean signal but the latter reads more naturally
     * next to `createdAt` / `updatedAt`. The [SerialName] remaps the
     * JSON key.
     */
    @SerialName("checked")
    @Serializable(with = InstantIso8601MillisSerializer::class)
    public val checkedAt: Instant? = null,
    public val position: Int,
    public val createdBy: String,
    @Serializable(with = InstantIso8601MillisSerializer::class)
    public val createdAt: Instant,
    @Serializable(with = InstantIso8601MillisSerializer::class)
    public val updatedAt: Instant,
    @Serializable(with = InstantIso8601MillisSerializer::class)
    public val deletedAt: Instant? = null,
)

@Serializable
public data class ListMemberDto(
    public val listId: String,
    public val userId: String,
    public val role: String,
    @Serializable(with = InstantIso8601MillisSerializer::class)
    public val createdAt: Instant,
    @Serializable(with = InstantIso8601MillisSerializer::class)
    public val updatedAt: Instant,
    @Serializable(with = InstantIso8601MillisSerializer::class)
    public val deletedAt: Instant? = null,
)

/**
 * Response envelope shared across the three feeds. Generic on `Row` so
 * we get one decoder per resource without re-stating the `serverTime`
 * pattern.
 *
 * kotlinx.serialization handles the generic dispatch via the `KSerializer`
 * passed at deserialization time — the call site at the SyncEngine reads
 * `Json.decodeFromString<SyncResponseDto<ListDto>>(body)` and the compiler
 * synthesizes the right serializer.
 */
@Serializable
public data class SyncResponseDto<Row>(
    @Serializable(with = InstantIso8601MillisSerializer::class)
    public val serverTime: Instant,
    public val rows: List<Row>,
)

/**
 * 409 conflict envelope returned by PATCH endpoints (slice C.1
 * contract). `latest` is the server's current row, which the drainer
 * applies through the SyncEngine's LWW upsert before retrying.
 */
@Serializable
public data class ConflictBodyDto<Row>(
    public val latest: Row,
)
