package `in`.santosh_bharadwaj.sharedlist.core.sync

import androidx.room.TypeConverter
import java.time.Instant

/**
 * Room can only persist a small set of native types (Long, String, etc.).
 * Anything else needs a [TypeConverter] that maps the Kotlin type to and
 * from a primitive. We register one pair per non-primitive column type
 * touched by [SyncDatabase].
 *
 * Why epoch-millis Long for [Instant] (instead of ISO-8601 String):
 *   1. The reconciler does range queries — `WHERE updatedAt > :since` — and
 *      SQLite indexes integer columns trivially. Lexicographic comparisons
 *      on ISO-8601 strings happen to work because the format is sortable,
 *      but Long is the dialectally correct shape.
 *   2. Instant ↔ Long is loss-free at millisecond precision (the wire's
 *      precision floor). String round-tripping would risk re-introducing
 *      the truncation bug `JsonCoders` exists to prevent.
 *   3. Smaller storage footprint — 8 bytes vs ~24 bytes per timestamp at
 *     three timestamps per row.
 *
 * Public so test code can reuse the converters in test-only databases
 * built via Room's in-memory builder.
 */
public object SyncTypeConverters {
    @TypeConverter
    @JvmStatic
    public fun instantToEpochMillis(value: Instant?): Long? = value?.toEpochMilli()

    @TypeConverter
    @JvmStatic
    public fun epochMillisToInstant(value: Long?): Instant? = value?.let(Instant::ofEpochMilli)
}
