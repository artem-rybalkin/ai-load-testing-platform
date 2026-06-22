# one-prompt-test-creation — Implementation Plan

Status: Draft — pending user review (Phase 4 HITL gate)
See `one-prompt-test-creation-SPECS.md` for WHAT/scope/rationale — this file is HOW/sequencing only.

Request size: **LARGE** (multiple areas: shared types, results-service, api consumption, UI,
docs — 11 files touched, no single area covers it).

## Phase A — Shared types

1. `packages/shared/src/index.ts` — add `ChatMessage`, `ParsedTestIntent`, `ChatParseResponse`.
2. `npm run build:shared`.

## Phase B — Backend: `POST /chat/parse`

3. `services/results-service/src/app.ts` — new route, modeled on AI-9's structure
   (`getEffectiveAiProviderSetting` instead of the global-only call — see SPECS' deliberate
   deviation), with its own prompt-builder helper function (not inline in the route, for testability).
4. `services/results-service/src/__tests__/api.test.ts` — new test block covering: `ready` response
   shape, `needsClarification` response shape, `redirectToFlowBuilder` response shape (incl.
   asserting `incrementGeminiUsage` is still called for this outcome), `503` no provider configured,
   `429` quota exceeded, `500` malformed Gemini JSON (both the no-brace-match and the
   brace-matched-but-invalid-JSON cases), per-team provider override actually used (mock
   `getEffectiveAiProviderSetting`/team override row, assert it's honored — this is the regression
   test for the deliberate AI-9 deviation), and a >20-message history is truncated before the
   prompt is built (assert the mocked Gemini call received ≤20 messages' worth of content).

## Phase C — UI: chat page

5. `services/ui/lib/api.ts` — `parseChatPrompt(messages: ChatMessage[]): Promise<ChatParseResponse>`
   fetch wrapper, plus re-export the new shared types.
6. `services/ui/app/chat/page.tsx` — new page: message list, input, send handler, preview-card
   rendering on `ready`, clarification-bubble rendering on `needsClarification`,
   redirect-to-FlowBuilder messaging on `redirectToFlowBuilder` (concrete target: confirm/add
   `?type=flow` query-param support on `app/page.tsx`, reusing the existing `?useScriptTemplate=`
   deep-link precedent — see SPECS), "Run Test" → `createTest()` → append status bubble with
   reconnect handling (one-shot `GET /results/:testId` re-fetch on socket reconnect, per SPECS).
7. `services/ui/app/App.tsx` — one lazy route.
8. `services/ui/app/components/Sidebar.tsx` — one `NAV` entry.
9. `services/ui/__tests__/ChatPage.test.tsx` — new test file: renders input, sends message, shows
   assistant reply, renders preview card on `ready`, renders clarification prompt on
   `needsClarification`, redirect message + working link on `redirectToFlowBuilder`, "Run Test"
   calls `createTest` and shows a status bubble, mocked WS event updates the bubble, simulated
   disconnect/reconnect triggers the one-shot status re-fetch instead of leaving the bubble stale.

## Phase D — Docs

10. `CLAUDE.md` — document the new endpoint (API Endpoints section) and the new UI page
    (Repository Structure + relevant feature section), following the file's existing density/style.
11. `docs/TODO.md` — mark the "one prompt" MEGA feature item in-progress/done once shipped; add a
    new explicit follow-up item for flow/multi-step inference (the deferred "Phase 2").
12. `docs/api.md` / `docs/how-to/test-types.md` — add `POST /chat/parse` if these docs already
    enumerate AI endpoints at this level of detail (confirm during implementation; skip if out of
    the existing docs' granularity).

## Sequencing notes

- B before C: the UI needs the real response shape to build against; stub/mock it only if B is
  blocked, otherwise build B first.
- A before B and C: both depend on the shared types compiling.
- Tests are written alongside each phase's code (B3↔B4, C-page↔C-tests), not deferred to a separate
  pass — matches this repo's existing convention (every service change in recent history ships
  with its tests in the same commit).

## Explicitly not in this plan

- Flow/multi-step inference (deferred per SPECS).
- Persistent chat history (deferred per SPECS).
- Field-level editable preview form (deferred per SPECS — chat-correction loop instead).
- Any change to `POST /tests`, `checkTestQuota`, or script-generation — this feature is additive
  only, calling existing, unmodified code paths.

## HITL gates in this plan

- **Phase 4 (this review)** — user approves specs + plan before any code is written.
- **Phase 8** — user approves the implementation before tests are considered "the right tests."
  Not yet reached.
