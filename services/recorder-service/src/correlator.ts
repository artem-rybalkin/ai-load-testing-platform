import { GoogleGenerativeAI } from '@google/generative-ai';
import { FlowStep, RecordedRequest, ExtractRule, ExtractSource } from '@alt/shared';
import { log } from './logger';

// ─── AI-powered correlation detection ─────────────────────────────────────────
//
// Sends request/response pairs to Gemini and asks it to identify values
// from response N that appear in request N+1 or later.  The model returns
// a JSON object we use to populate FlowStep.extract fields.

interface CorrelationEntry {
  sourceStepIndex: number;       // which response (0-based) contains the value
  variableName: string;          // suggested variable name (snake_case)
  source: ExtractSource;         // 'jsonpath' | 'header' | 'cookie' | 'regex'
  expression: string;            // extraction expression
  usedInStepIndices: number[];   // steps that use this variable
}

interface CorrelationResult {
  correlations: CorrelationEntry[];
}

const CORRELATION_PROMPT = (requestSummary: string) => `
You are an expert in HTTP traffic analysis and load testing.
Analyze the following HTTP request/response pairs from a recorded user session.
Identify "correlation points": places where a value from a response body or header
appears verbatim in a later request (authentication tokens, session IDs, CSRF tokens,
entity IDs, etc.).

For each correlation found, return an object with:
- sourceStepIndex: 0-based index of the response that produced the value
- variableName: a snake_case name for the extracted variable (e.g. "access_token", "csrf_token", "user_id")
- source: one of "jsonpath" (for JSON body), "header" (response header), "cookie" (Set-Cookie), "regex" (other)
- expression: the extraction expression (examples: "$.data.token", "X-Auth-Token", "session", "token=([^;]+)")
- usedInStepIndices: array of 0-based indices of later steps that use this value

Return ONLY valid JSON with this exact shape:
{"correlations":[...]}

If no correlations are found, return: {"correlations":[]}

HTTP traffic (JSON):
${requestSummary}
`.trim();

/** Build a compact summary of request/response pairs to send to Gemini */
function buildSummary(requests: RecordedRequest[]): string {
  const pairs = requests.slice(0, 15).map((r, i) => ({
    index: i,
    method: r.method,
    url: r.url,
    requestBody: r.body ? r.body.slice(0, 500) : undefined,
    responseStatus: r.responseStatus,
    // Only include response headers that commonly carry tokens
    responseHeaders: Object.fromEntries(
      Object.entries(r.responseHeaders).filter(([k]) =>
        /set-cookie|x-auth|authorization|token|location/i.test(k)
      )
    ),
    responseBody: r.responseBody ? r.responseBody.slice(0, 1000) : undefined,
  }));
  return JSON.stringify(pairs, null, 2);
}

/** Apply correlation entries back onto FlowStep[].extract */
function applyCorrelations(steps: FlowStep[], correlations: CorrelationEntry[]): FlowStep[] {
  const result = steps.map(s => ({ ...s, extract: { ...(s.extract ?? {}) } }));

  for (const corr of correlations) {
    if (corr.sourceStepIndex < 0 || corr.sourceStepIndex >= result.length) continue;

    const varName = corr.variableName.replace(/[^a-z0-9_]/gi, '_') || `var_${corr.sourceStepIndex}`;
    const rule: ExtractRule = { source: corr.source, expression: corr.expression };

    // Add extract rule to the source step
    result[corr.sourceStepIndex].extract = {
      ...result[corr.sourceStepIndex].extract,
      [varName]: rule,
    };

    log.debug({ varName, source: corr.source, expression: corr.expression, usedIn: corr.usedInStepIndices }, 'Correlation applied');
  }

  return result;
}

/** Run AI correlation detection; returns steps enriched with extract rules. */
export async function detectCorrelations(
  requests: RecordedRequest[],
  steps: FlowStep[],
): Promise<FlowStep[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    log.warn('GEMINI_API_KEY not set — skipping correlation detection');
    return steps;
  }
  if (requests.length < 2) {
    return steps; // need at least two exchanges to find correlations
  }

  const summary = buildSummary(requests);

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const result = await model.generateContent(CORRELATION_PROMPT(summary));
    const text = result.response.text().trim();

    // Extract JSON even if Gemini wraps it in markdown code fences
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      log.warn({ text }, 'Correlation response did not contain JSON');
      return steps;
    }

    const parsed: CorrelationResult = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed.correlations)) {
      return steps;
    }

    const enriched = applyCorrelations(steps, parsed.correlations);
    log.info({ correlationCount: parsed.correlations.length }, 'Correlation detection complete');
    return enriched;
  } catch (err) {
    log.warn({ err }, 'Correlation detection failed — returning steps without extraction rules');
    return steps;
  }
}
