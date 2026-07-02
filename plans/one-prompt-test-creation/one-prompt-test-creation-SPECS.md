# one-prompt-test-creation — Tech Specs

Status: Implemented — see docs/AI-FEATURES.md § 13 for the living reference
Traces to: `TODO.md` (root) → MEGA Features → "Natural language 'one prompt' test creation"; `docs/ASSUMPTIONS.md` K5

Note: v1 scope below (backend/client-side only, no flow inference) reflects this feature at initial
ship. Flow/multi-step inference from context (Swagger/HAR/docs attachments, `flowReady` outcome)
shipped as a follow-up 2026-06-28 — see `docs/AI-FEATURES.md` § 13 for the current behavior.

## WHAT

A new "Chat" tab in the UI where a user describes a test in free-text, in a multi-turn
conversation. Gemini parses the conversation into a structured test config (type, URL,
load/session options, thresholds). If required info is missing or ambiguous, the assistant
asks a clarifying follow-up in the same thread instead of failing. Once a config is ready,
the assistant shows a read-only preview card; the user either confirms ("Run Test") or replies
with a correction ("make it 100 VUs instead") which re-parses with the correction folded in.
Confirming calls the existing `POST /tests` unchanged — no new test-execution path, only a new
*parsing* step in front of it.

## Scope (v1)

- **In scope**: `backend` and `client-side` test types only. Single target URL. VUs/sessions,
  duration, load profile, SLO thresholds extraction. Multi-turn clarification. Preview-then-confirm.
  Live status tracking in the chat thread after the test starts (reuses existing WebSocket events).
- **Out of scope (deferred)**: `flow` (multi-step) test inference — flagged by the user as a
  "Phase 2" follow-up investigation; add a `TODO.md` (root) entry, do not attempt step extraction
  in v1. If the assistant detects multi-step intent ("login then checkout"), it must redirect the
  user to the existing Flow Builder rather than guess at endpoints.
- **Out of scope (deferred)**: editable preview *form* (field-by-field editing UI). v1's "preview
  before run" is satisfied via read-only preview + chat-based correction (multi-turn already
  covers this — "make it 100 VUs" is simpler to build than a full options-editing form and is
  consistent with the conversational UX). Flag this as a design simplification for user sign-off,
  not a blocking question — a fast-follow inline-edit form can be added later if the chat-correction
  loop proves clunky in practice.
- **Out of scope**: persisting chat history across page reloads/sessions (v1: React state only,
  lost on refresh — same effort tier as everything else in v1; FlowBuilder's localStorage-session
  pattern is a precedent if this needs hardening later).

## New Shared Types (`packages/shared/src/index.ts`)

```ts
interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

interface ParsedTestIntent {
  type: 'backend' | 'client-side'
  targetUrl: string
  description: string          // human-readable summary; becomes TestRequest.description
  options: BackendTestOptions | ClientTestOptions
  thresholds?: SLOThresholds
}

type ChatParseResponse =
  | { status: 'needsClarification'; question: string }
  | { status: 'ready'; config: ParsedTestIntent }
  | { status: 'redirectToFlowBuilder'; reason: string }   // multi-step intent detected
```

## New Endpoint — `POST /chat/parse` (results-service)

Modeled on the existing AI-9 pattern (`app.ts:1532-1569`, `GET /results/suggest-settings`), with
one deliberate deviation: **use the per-team-aware provider resolution, not the global-only one.**

- Body: `{ messages: ChatMessage[] }` — client sends the full conversation each turn (stateless
  server, consistent with how `POST /results/suggest-thresholds` etc. are already stateless).
  Server caps the prompt to the **last 20 messages** before building the Gemini prompt (truncate
  oldest first) — bounds both context-window risk and per-call token cost on a long back-and-forth;
  the client may keep showing full history in the UI regardless, only the server-side prompt is capped.
- Provider resolution: `getEffectiveAiProviderSetting(pool, request.projectId)` — **not**
  `getAiProviderSetting(pool)` (the global-only call AI-9 uses). This is a deliberate correction,
  not a copy of AI-9's gap — per-team AI provider overrides (Phase C, already shipped) should apply
  here like every other newer AI endpoint.
- `503 { error: 'No AI provider configured' }` if `isProviderConfigured` fails for the resolved chain.
- Quota: `checkGeminiQuota(pool, request.projectId)` before the call → `429` on violation;
  `incrementGeminiUsage(pool, request.projectId)` after a successful call. Same daily cap as every
  other Gemini-backed endpoint — a multi-turn chat burns quota faster than a single-click "Suggest"
  button; call this out to the user as a known tradeoff, no mitigation planned for v1.
- Rate limit: route `config.rateLimit` using `AI_RATE_LIMIT_MAX` (same as AI-9), registered per-route.
- Prompt construction: include the full message history, explicit instructions to (a) return JSON
  matching `ParsedTestIntent` when confident, (b) return `{ needsClarification, question }` when a
  required field (URL above all) is missing/ambiguous, (c) return `{ redirectToFlowBuilder, reason }`
  when the user's intent clearly spans multiple sequential steps/endpoints.
- Response parsing: same defensive pattern as AI-9 — regex-extract the `{...}` block, `JSON.parse`
  inside the same `try/catch` that already wraps the handler (AI-9's `!match` guard alone does not
  catch a `JSON.parse` throw on malformed-but-brace-matched text; carry the existing handler-level
  `catch` forward, don't repeat AI-9's narrower guard). Both the "no brace match" and the
  "`JSON.parse` throws" cases return `500 { error: 'AI returned unexpected response' }`, matching
  AI-9's existing status code exactly.
- `redirectToFlowBuilder` still consumes one Gemini call (the call already happened by the time the
  model decides multi-step intent), so `incrementGeminiUsage` runs for this outcome too, same as
  `ready`/`needsClarification` — there is no free/uncounted outcome.
- `targetUrl` from a `ready` response is **not** trusted blindly — the existing `POST /tests`
  validation (`new URL()`, http/https-only) is the real gate. This endpoint only proposes a config;
  it never calls a worker or writes to the DB directly.

## UI

- **Nav**: one entry added to `Sidebar.tsx`'s `NAV` array (`{ href: '/chat', icon: '💬', label: 'Chat' }`).
- **Route**: one lazy route in `App.tsx`, same pattern as existing pages.
- **Page** (`app/chat/page.tsx`): message list (user bubbles right-aligned, assistant left-aligned,
  matching no existing visual precedent — first chat-style UI in this codebase, plain Tailwind).
  Text input + send button at the bottom. When a `ready` response arrives, render a preview card
  inline in the assistant's message (type badge, URL, options, thresholds) with **Run Test** /
  **Keep chatting** actions. **Run Test** calls the existing `createTest()` from `lib/api.ts` —
  unchanged, no new client-side test-submission code path.
- **Live status**: after `createTest()` succeeds, append a status bubble subscribed to the existing
  `useResultsSocket` hook, filtered to the new `testId`'s `test:status` events; bubble text updates
  pending → running → completed/failed; links to `/results/:testId` once available. If the socket
  disconnects mid-test, the bubble shows a "reconnecting…" state (reuses `useResultsSocket`'s
  existing reconnect-with-backoff) rather than silently going stale; on reconnect, re-fetch the
  test's current status via the existing `GET /results/:testId` once (not polling) to cover any
  terminal event that landed while disconnected — `useResultsSocket` itself does not replay missed
  events, so a one-shot fetch-on-reconnect is required to avoid a bubble stuck on "running" forever.
- **Flow redirect target**: implementation must check whether `app/page.tsx` already supports a
  type-preselection query param (it already supports `?useScriptTemplate=<id>` for the Library
  page's deep-link, per the existing precedent) — reuse that pattern by adding `?type=flow` support
  to `page.tsx` if it doesn't already exist, and link `redirectToFlowBuilder` to `/?type=flow`. Do
  not leave this as "or similar" during implementation — confirm and use one concrete route.
- **No existing modal/dialog component to reuse** — confirmed via codebase search, none exists today.
  This is a new (simple) UI pattern, not a refactor of an existing one.

## Security / Risk Notes

- No new script-injection surface: this endpoint never generates or executes a script — it only
  produces a `TestRequest`-shaped config that flows through the existing, already-validated
  `POST /tests` → AI-service → script-generation pipeline unchanged.
- Free-text user input goes to Gemini as a prompt, same class of exposure as every other AI feature
  in this codebase (AI-1 through AI-17) — no new PII/secrets handling concern beyond what already
  exists; recorder-service's `redactPII()` precedent is not applicable here (that's for *recorded
  traffic bodies*, not user-typed chat text) and is out of scope for this feature.
- `checkTestQuota` and the global rate limit on `POST /tests` apply unchanged to any test created
  via this flow — no quota-bypass risk introduced.

## Open implementation note for reviewer/user attention

AI-9 (`suggest-settings`) currently uses the global-only `getAiProviderSetting`, not the per-team
`getEffectiveAiProviderSetting` — a pre-existing inconsistency, not something this feature
introduces, but this spec deliberately does *not* copy that gap. Worth a separate small fix to
AI-9 itself at some point, tracked as a `TODO.md` (root) item, not in this feature's scope.
