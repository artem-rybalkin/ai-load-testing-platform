# Pattern: Pino Logger with Sensitive Field Redaction

## Context
Used in: all 6 services that handle `EnrichedTestRequest`/`TestRequest` objects — api-service, ai-service, results-service, worker-backend, worker-client, recorder-service (logger.ts in each).

analyser-service also configures pino `redact`, but with a different, domain-specific path set — see "analyser-service exception" below.

## Problem
Services log full request objects. If a test object is accidentally logged, it exposes envVars (credentials), testData, and csvData.

## Solution

```typescript
import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: ['envVars', 'testData', 'csvData'],
    censor: '[REDACTED]',
  },
});
```

## Usage

```typescript
// Safe — credentials redacted automatically even if test object is logged
logger.info({ test, testId }, 'Processing test');
// Output: { test: { ..., envVars: '[REDACTED]', ... }, testId: '...' }
```

## Key Rules
- Every service that touches `EnrichedTestRequest`/`TestRequest` MUST configure redact with these 3 paths
- This is defense-in-depth: safeTestResponse() strips them at API boundary too
- Pino redact works on nested paths and arrays (envVars anywhere in the log object)
- Add testId to every log call using `{ testId }` binding

## analyser-service exception

`services/analyser-service/src/logger.ts` does not handle `envVars`/`testData`/`csvData` and does not redact them. Instead it redacts fields specific to its own domain (comparison metrics, which can be large and are not secrets but are noisy/sensitive in logs):

```typescript
redact: { paths: ['metrics', 'previousMetrics'], censor: '[REDACTED]' },
```

These two paths are analyser-service-specific and are not used by any other service.
