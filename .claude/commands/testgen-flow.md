---
name: testgen-flow
description: Rosetta test generation workflow — MUST apply when generating test cases from tickets, Jira stories, or requirements. Produces TestRail-compatible test scenarios.
tags: ["workflow", "testgen", "test-cases", "generation"]
baseSchema: docs/schemas/workflow.md
---

<testgen_flow>

<description>
Test case generation workflow: config loading → data collection from Jira/Confluence → gap and contradiction analysis → question generation → requirements document generation → test case generation → export to TestRail.
</description>

<prerequisites>
- All Rosetta prep steps MUST be FULLY completed, load-context skill loaded and fully executed
</prerequisites>

<instructions>
MUST ACQUIRE `workflows/testgen-flow.md` FROM KB and FULLY EXECUTE EXACTLY, ALL PHASES AND STEPS, USING SUBAGENTS AS DEFINED
</instructions>

</testgen_flow>
