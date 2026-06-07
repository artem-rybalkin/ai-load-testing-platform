# Pattern: Pino Logger with Sensitive Field Redaction

## Context
Used in: all 6 services (logger.ts in each)

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
- Every service MUST configure redact with these 3 paths
- This is defense-in-depth: safeTestResponse() strips them at API boundary too
- Pino redact works on nested paths and arrays (envVars anywhere in the log object)
- Add testId to every log call using `{ testId }` binding
