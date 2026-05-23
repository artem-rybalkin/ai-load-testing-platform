import pino from 'pino';

// Redact sensitive fields that appear in EnrichedTestRequest / TestRequest to prevent
// credentials and parameterization data from leaking into structured logs.
const SENSITIVE_PATHS = ['envVars', 'testData', 'csvData'];

export const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'api-service' },
  redact: { paths: SENSITIVE_PATHS, censor: '[REDACTED]' },
});
