# ChatGPT Edge session-correlation evidence — 2026-10-11

## Scoped implementation

`hythes/gpt-mcp.ts` passes an Edge-only observer into canonical MCP tool
registration. The observer runs from the installed MCP SDK ToolCallback
`extra._meta` after the local bearer middleware accepts the request. It never
reads `arguments["openai/session"]`.

`hythes/gpt-session-correlation.ts` accepts only non-empty UTF-8 strings at
most 512 bytes without control characters. It emits a process-local HMAC
fingerprint, never the raw `openai/session` or `openai/subject` value. Every
outcome records `authority: NOT_A_GRANT`, `humanAct: false`, `effect: false`,
and `claimUsable: false`; rejected or absent metadata is unavailable for
correlation and cannot block an otherwise authenticated generic MCP request.

## Machine evidence

`tests/gpt-mcp-edge-health.test.ts` sends real loopback Streamable HTTP MCP
`tools/call` requests through the authenticated boundary. It verifies same
session fingerprint equality, different-session separation, absence handling,
malformed metadata rejection, argument-spoof resistance, redaction, and the
unchanged bearer-over-Origin rule.

## Core integration handoff

No Core request-contract type is added in this scoped change. The correlation
object remains process-local Edge diagnostics and is deliberately never passed
to Core. If a future, separately authorized Core feature needs correlation, it
must define a new evidence-only input that excludes raw IDs and still cannot
select a Node, Project Chief, Grant, HumanSemanticAct, or Effect. It must not
reuse this process-local HMAC fingerprint across process restarts as a durable
identity.

## Boundary still held

This is a local authenticated protocol witness only. No live ChatGPT remote
ingress, tunnel traversal, product Conversation binding, return route, Human
act, Core grant, or production credential was exercised. `connectorE2E` stays
`HOLD`; the diagnostic metadata is not an identity proof or authorization.
