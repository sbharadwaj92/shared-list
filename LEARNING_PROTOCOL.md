# Learning Protocol

This is a learning project. Shipping is a side effect; the goal is to **understand the systems you build deeply enough to explain them, defend them, and break them on purpose**. PLAN.md governs *what* gets built; this file governs *how* you ensure you actually learned it.

The protocol applies to every phase in PLAN.md. It is cross-cutting and lives outside the phase descriptions so it can evolve without re-touching PLAN.md.

---

## Per-phase deliverables

At the end of every phase, alongside meeting the "Done" criteria in PLAN.md, produce a single file at `docs/learning/phase-NN.md` (where `NN` is zero-padded — `phase-04.md`, etc.) containing three sections:

### 1. Teach-back (~500 words)

Write the teach-back for an imaginary junior dev who knows TypeScript / Swift / Kotlin at a junior level but has never seen this project. Cover:

- **What this phase built**, in plain prose, not a bulleted list of files.
- **Why it matters** in the context of the larger system. What does the next phase depend on?
- **How the pieces fit together** — the data flow, the lifecycle, the request path. Diagrams welcome but not required; what matters is that the prose stands alone.

Constraint: **no copy-paste from PLAN.md.** PLAN.md is your blueprint; the teach-back is your synthesis. If you find yourself reproducing a PLAN.md bullet, you're summarizing, not teaching.

The hard test: read it back a week later. If it still makes sense without re-reading the code, you understood it. If you're confused by your own writing, the phase isn't done yet — re-open it, fix the gap, then re-write the teach-back.

### 2. Rejected alternatives (1–2 entries)

During the phase you will make small judgment calls that PLAN.md doesn't pre-decide — a library choice, a folder layout, a query shape, an error-handling pattern. Pick the 1–2 most consequential decisions you made *during* the phase and document them as:

```
**Decision**: <what you chose>
**Rejected**: <what you considered but didn't pick>
**Why**: <one sentence on the trade-off>
```

Decisions PLAN.md already made (e.g. "Hono not Fastify") don't count — those are inherited, not yours. The point is to surface the *micro*-decisions execution forces.

### 3. Break-it session log (optional but recommended)

Spend 2–3 hours intentionally breaking what you just built. Suggested attacks per phase are seeded in the per-phase prompts below. Log briefly:

- **What I broke**: the action you took (pulled WiFi mid-request, sent malformed JWT, killed Postgres mid-transaction, etc.).
- **What happened**: observed behavior — error message, log lines, UI state, recovery time.
- **What I learned**: failure mode you didn't expect, or confirmation of a behavior PLAN.md assumed.
- **What I changed (if anything)**: code, retry logic, error message, log line.

This section can be skipped on phases where breaking is hard to design (e.g. Phase 1 repo bootstrap), but **don't skip it on the sync engine, auth, or WebSocket phases** — those are precisely the phases where understanding failure modes *is* the learning.

---

## Cadence

- The learning file is part of the phase's "Done" criteria. A phase is not Done until `docs/learning/phase-NN.md` is committed.
- If you're tempted to skip the learning file to "save time," that's a signal you don't understand what you built — slow down, don't speed up.
- Re-read the previous phase's teach-back at the start of the next phase. If you don't remember it, the previous phase wasn't actually learned, just shipped.
- At end of every block (Foundation / Auth / Sync / Realtime / CRUD / Polish), re-read all teach-backs in that block as a single document. The block should tell a coherent story.

---

## Per-phase seeded prompts

These are starting points — questions worth answering in the teach-back, plus suggested break-it experiments. Don't treat the prompts as a checklist; use them as a thinking aid. If a prompt doesn't apply to your phase outcome, ignore it. If you have better questions, follow those instead.

### Phase 1 — Repo + tooling bootstrap

**Teach-back questions**:
- Why a monorepo with Bun workspaces instead of three separate repos? What concrete pain would the alternative cause?
- What does `lefthook` actually do at commit time, and what would happen if you didn't have it?
- What does `mkcert` solve that self-signed certs don't?

**Break-it**: skip. Phase outcome is too thin to break meaningfully.

### Phase 2 — Backend skeleton

**Teach-back questions**:
- Trace a request from `curl` → Caddy → Hono → response. What does each layer do?
- Why is the config module Zod-validated at startup? What failure mode does that prevent?
- Why is Pino structured-JSON instead of plain text? Who consumes the JSON?

**Break-it**: kill the Postgres container while the backend is running. What does the next request return? What does the log say? Now point the backend at a wrong DB password and restart — does it fail at boot or at first query?

### Phase 3 — Backend schema + migrations

**Teach-back questions**:
- Why UUID v7 over UUID v4 or auto-increment integers? What property do you gain, and what's the cost?
- What does the `updated_at` trigger guarantee that application code couldn't?
- Soft delete vs. hard delete: what does each cost you in this app's specific shape?

**Break-it**: write a query that bypasses the `activeItems()` helper and does `db.select().from(items)` directly. What surprising data do you see? Now run the daily purge job manually and observe what's deleted.

### Phase 4 — Backend auth

**Teach-back questions**:
- Why argon2id over bcrypt? Why is parameter tuning (memory cost, parallelism) different from simply "a strong hash"?
- What does single-flight refresh actually prevent? Walk through the failure mode if it's missing.
- Reuse-detection on refresh tokens: what does it cost a *legitimate* user, and is that cost acceptable?
- Why is the access token 15 min and not 1 min or 24 hr? What's the trade-off?

**Break-it**: capture a refresh token from one device. Use it twice in quick succession via `curl`. Observe the second response and check the DB state. Now log in with the same credentials on three "devices" (curl sessions) and trigger reuse-detection on one — what happens to the others, and how long until they notice?

### Phase 5 — iOS auth

**Teach-back questions**:
- Why the `AppContainer` pattern over singletons? What does it buy you in tests, and what does it buy you in SwiftUI Previews?
- How does `RootView`'s switch-on-`AuthState.status` work in concrete terms — what triggers a re-render when `signedOut` becomes `signedIn(User)`?
- What does Keychain offer over `UserDefaults` for the refresh token, in concrete attack-resistance terms?

**Break-it**: kill the app mid-login (force-quit) and re-open. What state are you in? Now log in, force-quit the backend, and try to make a request — what does the user see, and how does the app recover when the backend returns?

### Phase 6 — Android auth

**Teach-back questions**:
- Compare iOS `Keychain` vs. Android `EncryptedSharedPreferences`. Where are they similar, where do they differ in trust model?
- `StateFlow<UiState>` vs. iOS `@Observable` — same shape on the surface, but what's actually different about how they propagate?
- Why is `applicationId` underscored (`in.santosh_bharadwaj.sharedlist`) when the iOS bundle is hyphenated?

**Break-it**: same scenarios as Phase 5 on Android. Additionally: trigger a refresh-token rotation while the device is in airplane mode, then come back — does the app recover gracefully?

### Phase 7 — Backend sync protocol + iOS sync engine in tandem

**Teach-back questions**:
- Why does `?since=` have to return soft-deleted rows? What breaks if it doesn't?
- Walk through what the iOS mutation queue does when you mutate, lose network, mutate again, regain network. Where exactly is the queue persisted, and what guarantees survival across app restart?
- `If-Match` conditional writes: what specific race do they prevent? Construct a concrete two-client scenario.
- Last-write-wins is not "correct" in the strict sense — what's the data loss scenario, and why is it acceptable for this app?

**Break-it**: airplane mode → make 5 mutations → kill app → reopen → re-enable network. Did all 5 land? In order? Now go online, make a mutation, and *while the request is in flight*, kill the network. What does the queue look like? What does the server have?

### Phase 8 — Android persistence + sync engine

**Teach-back questions**:
- What did you have to change about the protocol because of Android specifics, vs. what was inherited cleanly from Phase 7?
- Compare Room's `@Entity` lifecycle to SwiftData's `@Model`. Where does Room expose details that SwiftData hides, and is that better or worse?
- Why is the mutation queue table in Room (not in DataStore or SharedPreferences)?

**Break-it**: same scenarios as Phase 7 on Android. Additionally: rotate the device mid-sync. Does the sync engine survive a config change? If you used `viewModelScope`, does that even apply to your sync engine, or is it elsewhere?

### Phase 9 — Cross-platform sync verification

**Teach-back questions**:
- Construct the worst-case concurrent-edit scenario for two devices on the same item. What happens? What user-visible artifact does it leave?
- Why does the `?since=` reconciliation pull happen *before* re-subscribing on WS reconnect, not after?
- Both clients share the same protocol, but their sync engines are independent codebases. What's the cost of that vs. a shared cross-platform sync library?

**Break-it**: two real devices, both online. User A goes offline, deletes item X. User B online, edits item X's text. User A comes back online. What state does each device end up in, and is that what you'd expect?

### Phase 10 — Backend WebSocket server + push infrastructure

**Teach-back questions**:
- Why one WS connection per user with subscribe/unsubscribe messages, instead of one connection per list?
- APNs sandbox vs. prod: what's actually different in the bytes on the wire, and why does Apple separate them?
- pg-boss vs. an in-memory job queue: what does pg-boss specifically buy you in this app's failure model?

**Break-it**: connect via `wscat`, subscribe to a list, then have the backend crash and restart. What happens to your subscription? Now subscribe but never send a heartbeat — does the server detect a dead client, and how long does it take?

### Phase 11 — iOS WebSocket + push receiver

**Teach-back questions**:
- `URLSessionWebSocketTask` is async/await on the surface. What's it actually doing on the network — is the connection persistent, what triggers a frame, who owns the read loop?
- Heartbeat ping/pong: what failure does it detect that the OS doesn't surface itself?
- Why does the app close the WS on background and reopen on foreground, rather than holding it open?

**Break-it**: open WS, lock the phone for 5 minutes, unlock. What happened to the connection? What does the resubscribe flow look like? Now toggle airplane mode quickly — does the exponential backoff actually back off, or does it spam reconnects?

### Phase 12 — Android WebSocket + push receiver

**Teach-back questions**:
- Doze mode and App Standby: what do they do to your WS connection, and how is that different from iOS backgrounding?
- Ktor's WebSocket client vs. iOS `URLSessionWebSocketTask` — where is the API genuinely different, beyond syntax?
- `FirebaseMessagingService.onMessageReceived` runs on what thread? What can you do in there, and what must you not do?

**Break-it**: enable Doze (`adb shell dumpsys deviceidle force-idle`) with the app open. What happens to the WS? What happens to FCM messages — high-priority and normal-priority?

### Phase 13 — Lists CRUD on backend + iOS + Android

**Teach-back questions**:
- Trace a "create list" from the iOS button tap all the way to the Android device showing the new list. List every component touched.
- The mutation goes through `SyncEngine`, not directly through `APIClient`. Why? What would break if you went directly?
- The view reads from SwiftData/Room, not from network responses. Why? What property does that give you?

**Break-it**: create a list on device A while device B is offline. Bring device B online. Now create a list on device B *first*, then have device A do the same. Any visible glitch?

### Phase 14 — Items CRUD on backend + iOS + Android

**Teach-back questions**:
- `items.position` is integer with last-write-wins. Construct the concurrent-reorder scenario that produces a visible glitch. Is it acceptable?
- What does it mean for the UI to be "instant" given the SyncEngine roundtrip? Where does the optimism come from?
- Soft-delete on items: what does the UI need to do differently when an item flips to `deleted_at != NULL`?

**Break-it**: two devices on the same list, both reorder items concurrently. Take screenshots. Now check an item on device A while device B is editing the same item's text — who wins?

### Phase 15 — Sharing flow

**Teach-back questions**:
- Why an 8-char join code instead of email invites or deep links? What did you give up to avoid those?
- The rate limiter is in-memory. What attack does that fail to stop, and is that acceptable?
- What happens to a code that's accepted twice in flight? Walk through the DB transaction.

**Break-it**: generate a code. Try to brute-force it (write a small script that hammers the endpoint). Does the rate limiter catch you? Now generate a code, accept it, then try to accept it again — does the second request return a clear error?

### Phase 16 — In-context push permission + notification UX

**Teach-back questions**:
- Why is the permission asked in-context (when joining/creating a shared list) instead of at app launch? What does the data say about acceptance rates?
- iOS `UNUserNotificationCenter` vs. Android `POST_NOTIFICATIONS` runtime permission: where do they differ in the user model?
- The backend excludes the actor from the push fan-out. How is "actor" identified, and what happens if that identification is wrong?

**Break-it**: deny notification permission. What does the app do? Now grant it, deny it again from system Settings, and reopen the app — does the toggle reflect reality?

### Phase 17 — Settings + profile

**Teach-back questions**:
- Sign-out clears local data. What exactly does it clear, and what does it leave? Why?
- "Change password" — what happens to existing access tokens and refresh tokens? Is the user logged out everywhere, or just on this device?

**Break-it**: change password on device A. Wait. Try to use device B (which still has old tokens). What happens, and how soon?

### Phase 18 — Sync hardening + edge cases

**Teach-back questions**:
- Of all the edge cases you fuzzed, which one surprised you most? Why?
- The exponential backoff has jitter and a max delay cap. What's jitter for, and what would happen without the cap?
- "Last synced X ago" indicator — what's the source of truth for "X ago," and what edge case does it gloss over?

**Break-it**: write a fuzz harness that randomly picks (mutate / delete / reorder / go offline / go online) actions for two simulated clients. Run for an hour. Any divergence?

### Phase 19 — Optional level-ups

No prescribed prompts — pick a level-up that interests you and define your own learning goals up front. The teach-back then becomes "what I picked, why, what I learned, what I'd do differently next time."

---

## Anti-patterns to avoid

- **Summary-as-teach-back**: bulleting what you did instead of explaining how it works. If your teach-back can be diff'd against PLAN.md and looks similar, redo it.
- **Vague generalities**: "I learned a lot about WebSockets" is not learning, it's a pat on the back. The teach-back must be specific enough that someone could re-derive your decisions from it.
- **Skipping break-it on the hard phases**: if you skip break-it on Phase 7 (sync) or Phase 4 (auth), you're trading the most valuable learning of the whole project for a shipping milestone.
- **Backfilling**: writing the learning file weeks later, from memory. The friction was the point. If you couldn't write it at the time, you didn't actually understand it then.

---

## Files this protocol creates

- `docs/learning/phase-01.md` through `docs/learning/phase-19.md` — one per phase
- This file (`LEARNING_PROTOCOL.md`) — created at end of Phase 1 alongside `KNOWN_DEBT.md`
