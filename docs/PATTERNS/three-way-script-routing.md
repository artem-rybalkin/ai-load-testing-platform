# Pattern: Three-way Script Routing with Cache

## Context
Used in: api-service/src/index.ts (POST /tests handler)

## Problem
Script generation is expensive (Gemini API call). Scripts should be reused when the test URL/type matches, but only if the user's description still matches the cached script's intent.

## Decision Tree

```
POST /tests
  │
  ├─ customScript provided? → bypass cache, send direct to worker queue
  │
  ├─ type === 'client-side'? → bypass cache, send direct to worker queue
  │    (worker-client always runs its own native Puppeteer flow — it never
  │     reads generatedScript/scriptId, so cache/generation would be wasted
  │     Gemini quota on output nothing consumes)
  │
  ├─ findExistingScript(targetUrl, type)?
  │    │
  │    ├─ NO (cache miss)
  │    │    └─ publish to ai-requests → ai-service generates via Gemini
  │    │
  │    └─ YES (cache hit)
  │         ├─ no description provided OR flow test
  │         │    └─ inject k6 options → send direct to worker queue
  │         │       incrementUsedCount(scriptId)
  │         │
  │         └─ description provided
  │              └─ publish to ai-requests with:
  │                 cachedScript, cachedScriptDescription, cachedScriptId
  │                 → ai-service calls compareDescriptions()
  │                   REUSE → forward to worker, mark reusedScript: true
  │                   REGENERATE → generate new script
```

## Key Rules
- `findExistingScript` does NOT auto-increment used_count (explicit increment only)
- incrementUsedCount called in api-service on direct bypass (path 2)
- incrementUsedCount called in worker-backend/saveScript on confirmed REUSE (path 3 REUSE)
- Flow tests always use SHA-256 hash of steps JSON as target_url ('flow:<hex16>')
- customScript bypasses cache entirely and is not stored in DB
- client-side (Puppeteer) tests bypass cache entirely too (added 2026-07-12), regardless of description or cache state
- compareDescriptions() defaults to REGENERATE on any AI error (safe fallback)
