# PATTERNS/CHANGES.md

> Pattern files describe facts about the code (ports, retry counts, redact paths, which services implement a pattern) that drift as the code changes. Whenever a change to a pattern file corrects or updates one of these factual claims, add an entry here — this log should not go stale while the patterns it tracks keep changing.

## 2026-06-03
- Initial patterns extracted during Rosetta workspace initialization

## (this audit — exact date not available; see git log for the commit date)
- `fastify-service-health.md`: added `recorder-service` and `ai-service` to the Context line; both implement `/health` but were missing from the service list (recorder-service has a full health endpoint, ai-service is worker-style "health only" checking RabbitMQ connectivity).
- `pino-redact-logger.md`: documented that `analyser-service` uses a different, domain-specific redact path set (`['metrics', 'previousMetrics']`) instead of the standard `['envVars', 'testData', 'csvData']` used by the other 6 services; this was previously undocumented and contradicted the "every service MUST" wording in Key Rules.
