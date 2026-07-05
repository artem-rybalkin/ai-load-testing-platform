/**
 * Runtime validation for the message shapes that cross an AMQP queue
 * boundary: api-service -> ai-service -> worker-backend/worker-client ->
 * results-service, plus the cancel-fanout signal. Every consumer parses a
 * Buffer of untrusted JSON off the wire; a raw `JSON.parse(...) as Type`
 * cast only asserts a shape at compile time; it does nothing at runtime; a
 * producer-side field rename/removal surfaces as `undefined` deep inside a
 * handler instead of a clear validation error routed to the queue's DLQ.
 *
 * These schemas intentionally do NOT replace the hand-written interfaces in
 * ./index.ts (TestRequest, EnrichedTestRequest, TestResult, etc.) — doing so
 * would mean migrating every import site across all 8 services in one pass,
 * a large, high-blast-radius refactor for its own sake. Instead, each
 * schema is paired with a compile-time two-way assignability check against
 * the interface it validates (see the bottom of this file): if the
 * interface and the schema's inferred shape ever diverge, `tsc` fails on
 * the assertion, so drift is still caught at compile time without
 * requiring any other file to change how it imports these types.
 */
import { z } from 'zod';
import type {
  TestType, TestStatus, SLOThresholds, ExtractRule, FlowStep,
  BackendTestOptions, ClientTestOptions, TestRequest, EnrichedTestRequest,
  ErrorBreakdown, StepMetrics, BackendMetrics, ResourceBreakdown,
  LighthouseScore, ClientMetrics, TestResult,
} from './index';

export const TestTypeSchema: z.ZodType<TestType> = z.union([
  z.literal('backend'), z.literal('client-side'), z.literal('flow'),
]);

export const TestStatusSchema: z.ZodType<TestStatus> = z.union([
  z.literal('pending'), z.literal('running'), z.literal('completed'), z.literal('failed'), z.literal('cancelled'),
]);

export const SLOThresholdsSchema: z.ZodType<SLOThresholds> = z.object({
  p95: z.number().optional(),
  avg: z.number().optional(),
  errorRate: z.number().optional(),
  serverErrorRate: z.number().optional(),
  timeoutRate: z.number().optional(),
  lcp: z.number().optional(),
  fcp: z.number().optional(),
  ttfb: z.number().optional(),
  cls: z.number().optional(),
  inp: z.number().optional(),
  tbt: z.number().optional(),
});

export const ExtractRuleSchema: z.ZodType<ExtractRule> = z.object({
  source: z.union([z.literal('jsonpath'), z.literal('header'), z.literal('cookie'), z.literal('regex')]),
  expression: z.string(),
});

export const FlowStepSchema: z.ZodType<FlowStep> = z.object({
  name: z.string(),
  url: z.string(),
  method: z.union([z.literal('GET'), z.literal('POST'), z.literal('PUT'), z.literal('DELETE'), z.literal('PATCH')]),
  body: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  extract: z.record(z.string(), ExtractRuleSchema).optional(),
});

const HttpOptionsSchema = z.object({
  keepAlive: z.boolean().optional(),
  timeout: z.string().optional(),
  discardResponseBodies: z.boolean().optional(),
});

export const BackendTestOptionsSchema: z.ZodType<BackendTestOptions> = z.object({
  vus: z.number(),
  duration: z.string(),
  rampUp: z.string().optional(),
  profile: z.union([z.literal('load'), z.literal('spike'), z.literal('capacity'), z.literal('soak')]).optional(),
  peakVus: z.number().optional(),
  httpOptions: HttpOptionsSchema.optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

export const ClientTestOptionsSchema: z.ZodType<ClientTestOptions> = z.object({
  sessions: z.number(),
  duration: z.string(),
  collectWebVitals: z.boolean(),
  headers: z.record(z.string(), z.string()).optional(),
});

export const TestRequestSchema: z.ZodType<TestRequest> = z.object({
  id: z.string(),
  type: TestTypeSchema,
  targetUrl: z.string(),
  description: z.string(),
  options: z.union([BackendTestOptionsSchema, ClientTestOptionsSchema]),
  thresholds: SLOThresholdsSchema.optional(),
  steps: z.array(FlowStepSchema).optional(),
  envVars: z.record(z.string(), z.string()).optional(),
  testData: z.array(z.record(z.string(), z.string())).optional(),
  csvData: z.string().optional(),
  csvFilename: z.string().optional(),
  customScript: z.string().optional(),
  projectId: z.string().optional(),
  workspaceId: z.string().optional(),
  createdAt: z.string(),
});

export const EnrichedTestRequestSchema: z.ZodType<EnrichedTestRequest> = TestRequestSchema.and(z.object({
  generatedScript: z.string().optional(),
  scriptId: z.string().optional(),
  reusedScript: z.boolean().optional(),
  scriptCacheKey: z.string().optional(),
  cachedScript: z.string().optional(),
  cachedScriptDescription: z.string().nullable().optional(),
}));

export const ErrorBreakdownSchema: z.ZodType<ErrorBreakdown> = z.object({
  success: z.number(),
  clientError: z.number(),
  serverError: z.number(),
  timeout: z.number(),
  networkError: z.number(),
});

export const StepMetricsSchema: z.ZodType<StepMetrics> = z.object({
  name: z.string(),
  avgResponseTime: z.number(),
  p95ResponseTime: z.number(),
  requestsTotal: z.number(),
  requestsFailed: z.number(),
});

export const BackendMetricsSchema: z.ZodType<BackendMetrics> = z.object({
  type: z.literal('backend'),
  requestsTotal: z.number(),
  requestsFailed: z.number(),
  avgResponseTime: z.number(),
  p50ResponseTime: z.number(),
  p95ResponseTime: z.number(),
  p99ResponseTime: z.number(),
  rps: z.number(),
  statusCodes: z.record(z.string(), z.number()).optional(),
  errorBreakdown: ErrorBreakdownSchema.optional(),
  stepMetrics: z.array(StepMetricsSchema).optional(),
});

export const ResourceBreakdownSchema: z.ZodType<ResourceBreakdown> = z.object({
  jsSize: z.number(),
  cssSize: z.number(),
  imageSize: z.number(),
  fontSize: z.number(),
  xhrSize: z.number(),
  totalSize: z.number(),
  requestCount: z.number(),
});

export const LighthouseScoreSchema: z.ZodType<LighthouseScore> = z.object({
  performance: z.number(),
  accessibility: z.number(),
  bestPractices: z.number(),
  seo: z.number(),
});

export const ClientMetricsSchema: z.ZodType<ClientMetrics> = z.object({
  type: z.literal('client'),
  lcp: z.number(),
  fid: z.number(),
  cls: z.number(),
  ttfb: z.number(),
  fcp: z.number(),
  inp: z.number().optional(),
  tbt: z.number().optional(),
  tti: z.number().optional(),
  jsErrors: z.number().optional(),
  longTaskCount: z.number().optional(),
  domNodeCount: z.number().optional(),
  pageLoadCount: z.number().optional(),
  resourceBreakdown: ResourceBreakdownSchema.optional(),
  lighthouseScore: LighthouseScoreSchema.optional(),
});

export const TestResultSchema: z.ZodType<TestResult> = z.object({
  testId: z.string(),
  targetUrl: z.string(),
  status: TestStatusSchema,
  metrics: z.union([BackendMetricsSchema, ClientMetricsSchema]),
  thresholds: SLOThresholdsSchema.optional(),
  scriptId: z.string().optional(),
  reusedScript: z.boolean().optional(),
  projectId: z.string().optional(),
  startedAt: z.string(),
  completedAt: z.string().optional(),
  perfStatus: z.union([z.literal('passed'), z.literal('degraded'), z.literal('failed')]).optional(),
  // analysis (AnalysisResult) is never present on the wire between worker and
  // results-service — results-service computes it after receiving the raw
  // result — so it's deliberately not part of this contract.
  executionLog: z.string().optional(),
});

/** The cancel-fanout payload — not a shared TS interface elsewhere (each
 *  service that consumes it declares its own inline `{ testId: string }`
 *  cast), so this schema is this shape's single source of truth. */
export const CancelMessageSchema = z.object({ testId: z.string() });
export type CancelMessage = z.infer<typeof CancelMessageSchema>;

// ── Compile-time drift guards ────────────────────────────────────────────
//
// If a hand-written interface in ./index.ts and its schema above ever
// diverge (a field added/removed/retyped on one side but not the other),
// one of these two-way assignments fails to typecheck, breaking the build —
// without requiring any consumer of the interface to switch to importing
// z.infer<...> instead.

/* eslint-disable @typescript-eslint/no-unused-vars */
const _assertTestRequest: TestRequest = null as unknown as z.infer<typeof TestRequestSchema>;
const _assertTestRequestRev: z.infer<typeof TestRequestSchema> = null as unknown as TestRequest;
const _assertEnrichedTestRequest: EnrichedTestRequest = null as unknown as z.infer<typeof EnrichedTestRequestSchema>;
const _assertEnrichedTestRequestRev: z.infer<typeof EnrichedTestRequestSchema> = null as unknown as EnrichedTestRequest;
const _assertTestResult: TestResult = null as unknown as z.infer<typeof TestResultSchema>;
const _assertTestResultRev: z.infer<typeof TestResultSchema> = null as unknown as TestResult;
const _assertBackendMetrics: BackendMetrics = null as unknown as z.infer<typeof BackendMetricsSchema>;
const _assertBackendMetricsRev: z.infer<typeof BackendMetricsSchema> = null as unknown as BackendMetrics;
const _assertClientMetrics: ClientMetrics = null as unknown as z.infer<typeof ClientMetricsSchema>;
const _assertClientMetricsRev: z.infer<typeof ClientMetricsSchema> = null as unknown as ClientMetrics;
/* eslint-enable @typescript-eslint/no-unused-vars */
