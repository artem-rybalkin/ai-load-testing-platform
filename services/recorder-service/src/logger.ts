import pino from 'pino';

// Redact sensitive fields that may appear in captured headers or bodies.
const SENSITIVE_PATHS = ['envVars', 'testData', 'csvData'];

export const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'recorder-service' },
  redact: { paths: SENSITIVE_PATHS, censor: '[REDACTED]' },
});
