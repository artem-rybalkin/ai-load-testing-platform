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
- compareDescriptions() defaults to REGENERATE on any AI error (safe fallback)
