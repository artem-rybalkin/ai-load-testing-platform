import pino from 'pino';

// Redact sensitive fields that may appear in recorder-service structured log calls.
// Exported so test code can instantiate a logger with the exact same redact config
// and verify that captured auth tokens do not leak into log output.
export const SENSITIVE_PATHS = [
  // Generic service config fields (kept for consistency with infra log aggregators)
  'envVars',
  'testData',
  'csvData',
  // Recorder-specific: captured request headers can contain auth credentials.
  // If a debug log statement ever includes a raw RecordedRequest's headers object,
  // these paths prevent bearer tokens and API keys from appearing in plaintext.
  'requestHeaders.authorization',
  'requestHeaders["x-api-key"]',
  'requestHeaders["x-auth-token"]',
  'requestHeaders["x-csrf-token"]',
  // Response headers can carry Set-Cookie with session tokens
  'responseHeaders["set-cookie"]',
  // fast-redact paths only match the literal key hierarchy — the above only
  // protects a top-level `{ envVars, requestHeaders, ... }` log object. A
  // one-level wildcard also covers the common `{ test: { envVars } }` /
  // `{ request: { requestHeaders } }` shape of logging a whole object as a field.
  '*.envVars',
  '*.testData',
  '*.csvData',
  '*.requestHeaders.authorization',
  '*.requestHeaders["x-api-key"]',
  '*.requestHeaders["x-auth-token"]',
  '*.requestHeaders["x-csrf-token"]',
  '*.responseHeaders["set-cookie"]',
];

export const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'recorder-service' },
  redact: { paths: SENSITIVE_PATHS, censor: '[REDACTED]' },
});
