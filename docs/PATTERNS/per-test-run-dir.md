# Pattern: Per-test Run Directory Isolation

## Context
Used in: worker-backend/src/index.ts

## Problem
At WORKER_CONCURRENCY > 1, multiple k6 tests run in the same worker simultaneously. Flat tmpdir files (data.json, data.csv, script.js) collide across concurrent tests.

## Solution

```typescript
import os from 'os';
import path from 'path';
import fs from 'fs/promises';

async function runK6Test(testId: string, script: string, testData?: object, csvData?: string) {
  // Isolated directory per test run
  const runDir = path.join(os.tmpdir(), `k6-run-${testId}`);
  await fs.mkdir(runDir, { recursive: true });

  const scriptPath = path.join(runDir, 'script.js');
  await fs.writeFile(scriptPath, script);

  if (testData) {
    await fs.writeFile(path.join(runDir, 'data.json'), JSON.stringify(testData));
  }
  if (csvData) {
    await fs.writeFile(path.join(runDir, 'data.csv'), Buffer.from(csvData, 'base64'));
  }

  try {
    await executeK6(scriptPath, runDir);
  } finally {
    // Always clean up
    await fs.rm(runDir, { recursive: true, force: true });
  }
}
```

## Key Rules
- Always use `testId` in the directory name for uniqueness
- Use `/tmp` (world-writable) — node user can write without special permissions
- Always clean up in `finally` block to prevent disk accumulation
- k6 must be invoked with CWD set to `runDir` so `open('./data.json')` resolves correctly
