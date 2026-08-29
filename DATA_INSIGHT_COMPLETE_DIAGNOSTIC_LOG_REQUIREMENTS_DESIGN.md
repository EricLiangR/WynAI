# Data Insight Complete Diagnostic Log

## 1. Purpose

The data insight service now persists a backend diagnostic record for each newly accepted `InsightInput v1`. The record is keyed by `insightId` so an operator can reconstruct the request, execution path, model calls, evidence, result, and failure or degraded reason without a UI export.

This is an operational replay facility, not a user-facing report export. The current phase intentionally keeps real input, prompts, evidence, and model responses for one-to-one investigation.

## 2. Scope

- Persistence directory: `insight-diagnostics/` (configurable with `WYN_AI_INSIGHT_DIAGNOSTIC_DIR`).
- Record schema: `wynai.insight-diagnostic/v1`.
- Query endpoint: `GET /api/data-insights/{insightId}/diagnostics`.
- Full IDs and unique ID prefixes are accepted. Ambiguous prefixes return `409 INSIGHT_DIAGNOSTIC_PREFIX_AMBIGUOUS`.
- No UI entry and no new report export format are added.
- Existing records without diagnostics are lazily captured as `legacy.snapshot`; that snapshot contains available input, versions, runs, and audit data but cannot recreate model payloads that predate this feature.

## 3. Diagnostic record

```json
{
  "schema": "wynai.insight-diagnostic/v1",
  "id": "ins-...",
  "insightId": "ins-...",
  "actor": "user-or-anonymous",
  "organizationId": "org-...",
  "source": { "type": "independent-query", "sourceId": "...", "traceId": "..." },
  "events": [
    {
      "id": "evt-...",
      "type": "input.accepted",
      "at": "2026-08-28T06:00:00.000Z",
      "runId": "ir-...",
      "data": {}
    }
  ]
}
```

Events are append-only and ordered by persistence time. The event data is retained as JSON and is not reduced to hashes or summaries.

## 4. Event contract

The implementation records these event families:

1. `input.accepted`: complete normalized `InsightInput v1`, source, idempotency result.
2. `run.created` and `run.transition`: run mode, status, datasets, question, skill references, and metadata.
3. `generation.started`: generation prompt, input, and gateway snapshot.
4. `evidence.pack.created`: evidence pack, business fact pack, quality gates, and active skills.
5. `gateway.attempt`: operation, provider/model, endpoint host, request messages/payload, response status/payload, duration, timeout flags, retry context, and error.
6. `llm.stage.planner`, `llm.stage.critic`, `llm.stage.narrator`, `llm.stage.narrator-repair`: complete stage messages, parsed output or error, duration, and model.
7. `orchestration.completed`: complete orchestration object and stage audit.
8. `result.document.saved`: complete `InsightDocument`, provider/model/status, and any explore run.
9. `generation.finished`, `generation.failed`, `explore.completed`, `run.failed`: terminal outcome and diagnostics.
10. `legacy.snapshot`: available records for an insight created before diagnostic capture was enabled.

## 5. Access and security

The endpoint reuses the insight actor/organization access boundary. It is intended for backend operators and service-to-service diagnostics; no frontend control is exposed. API keys are never placed in the diagnostic request payload. Because the current decision is to retain real business data and model content, production deployment still requires a restricted operator role, access audit, retention/rotation policy, storage quota, and encryption at rest before broad external exposure.

## 6. Acceptance criteria

- A newly registered insight can be queried by full ID and a unique prefix.
- A failed or degraded generation retains all events written before failure and has a terminal event.
- Provider retries and response payloads are individually visible.
- A process restart reloads diagnostic records.
- An old insight returns a clearly marked `legacy.snapshot` instead of falsely claiming full historical model replay.
- Diagnostic persistence failures do not fail the user-facing insight request.

