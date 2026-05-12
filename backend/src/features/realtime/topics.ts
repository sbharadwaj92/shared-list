// Pub/sub topic naming.
//
// Bun's `ws.subscribe(topic)` / `server.publish(topic, msg)` is keyed on a
// plain string. We could just inline the strings at every call site, but a
// typo (`"lists:<id>"` vs `"list:<id>"`) would silently route to a topic
// nobody is subscribed to, and the only symptom would be "events disappear."
// Centralising the format here makes that bug impossible.
//
// We use `list:<uuid>` as the topic granularity rather than per-item topics
// because the natural client subscription unit is "this list" — when a user
// opens a list detail view in Phase 14, they'll subscribe once and care
// about every item-level event on it. Per-item subscriptions would multiply
// the topic count by ~100x for no benefit.

export const listTopic = (listId: string): string => `list:${listId}`;
