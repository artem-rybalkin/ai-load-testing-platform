# Reference Code Specs — Cookie Session Auth

**ARCHIVED — superseded by [`docs/original-code-specs-auth-tenancy.md`](./original-code-specs-auth-tenancy.md).**

This document described the original HMAC-signed-cookie session scheme (`signSession`/`verifySession`,
`SessionPayload { projectId, username, projectName }`). That scheme has since been replaced by a
DB-backed opaque-token session mechanism (`createSession`/`getSession`/`revokeSession`/`switchSessionTeam`
in `services/results-service/src/session.ts`, `getApiSession` in `services/api-service/src/session.ts`).

All content that remains accurate and useful — including a corrected, source-verified description of the
current session token mechanism — has been merged into `docs/original-code-specs-auth-tenancy.md`,
Section A.9 ("Session Token Mechanism"). The rest of this document's claims (signing algorithm, cookie
tamper edge cases, HMAC comparison) describe code that no longer exists and should not be used as a
reference.

This file is kept in place (rather than deleted) in case anything still links to it by filename. A
repo-wide search at archival time found no other files referencing this filename.
