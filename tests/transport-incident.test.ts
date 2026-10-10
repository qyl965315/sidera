import test from "node:test";
import assert from "node:assert/strict";
import { incidentHeaders, nativeIncident } from "../hythes/transport-incident.ts";

test("incident capture keeps correlation and 429 metadata without credentials or prompt bodies", () => {
  const event = nativeIncident({ status_code: 429, tunnel_request_id: "req_fixture", cmd_request_id:"command_fixture",trace_id:"trace_fixture",error_code: "fixture_limit",
    error_message: "Bearer fixture-secret sk-fixture-secret", prompt: "PRIVATE PROMPT", response_body: "PRIVATE BODY",
    response_headers: { Authorization: "Bearer hidden", "Set-Cookie": "private", "Retry-After": "60",
      "X-Request-ID": "req_fixture", "CF-Mitigated": "challenge", "X-Ratelimit-Remaining-Requests": "0" } });
  assert.equal(event.status, 429); assert.equal(event.retryAfter, "60");
  assert.equal(event.commandRequestId,"command_fixture");assert.equal(event.traceId,"trace_fixture");
  assert.equal(event.responseHeaders["cf-mitigated"], "challenge");
  assert.equal(event.responseHeaders["x-ratelimit-remaining-requests"], "0");
  assert.equal(event.originalHttpBodyAvailable, false);
  const stored = JSON.stringify(event);
  for (const secret of ["fixture-secret", "sk-fixture-secret", "PRIVATE PROMPT", "PRIVATE BODY", "Set-Cookie", "Authorization"])
    assert.equal(stored.includes(secret), false);
  assert.deepEqual(incidentHeaders({ cookie: "private", "content-type": "application/json" }), { "content-type": "application/json" });
});
