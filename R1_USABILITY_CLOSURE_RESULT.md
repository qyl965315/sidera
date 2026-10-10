# R1 usability closure result

USABILITY_READY_WITH_LIMITS

Unreleased local candidate: `candidates/r1-usability-20261007/portable/Sidera.exe`, `Sidera-0.1.0-usability-x64-setup.exe`, and `Sidera-0.1.0-usability-x64-portable.zip`. Both executables are unsigned.

Checks: TypeScript PASS; backend 276/276; OAuth/Gateway 25/25; desktop 13/13; focused usability/approval 7/7; UI build and smoke PASS; packaged isolated smoke PASS with 13 screenshots; privacy PASS; source/payload consistency PASS; portable ZIP integrity PASS; icon preserved.

OAuth/reconnect: the Gateway was controlled-reloaded after the OAuth metadata fix. Public metadata now advertises only `authorization_code`, public-client token auth method `none`, and PKCE `S256`. Local and public `/healthz` and `/readyz` return HTTP 200 with `ready=true`. After reload, this supervising ChatGPT conversation successfully completed a `sidera.status` connector round-trip. Exact Human-owned Primary/Chief binding is still NOT ESTABLISHED: `chief.frontend_prepare` was rejected with `Chief binding required`.

Limits: Grok lacks a verified ACP contract; stale ZCode is unavailable; Gemini requires attested default-model identity before dispatch. General MCP import supports configuration and inspection, not implicit canonical tool grants. Native cancellation was exercised through an intercepted OS handler; positive approval remains fixture evidence. The installer was built but not installed into the real Human profile. No GitHub publication or external model work occurred.

SHA256:

`677183e1fbbb4eb48a855bd9e97e2773e6ed196102bcae64b346151e77604146`  portable/Sidera.exe

`4351a68d9f33b91d37572231078481ff56b76f45a55488976597ece1c38169e6`  Sidera-0.1.0-usability-x64-setup.exe

`83a5b23d7fee0442b596faffa3c6ad6ae0443f0ccbe878d45de0ac78de6c58de`  Sidera-0.1.0-usability-x64-portable.zip
