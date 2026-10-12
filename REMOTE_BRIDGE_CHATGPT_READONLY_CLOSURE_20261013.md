# Sidera → self-hosted Remote Bridge R0 · ChatGPT read-only E2E (2026-10-13)

## Final observed status

**PHASE-1 CHATGPT READ-ONLY CONNECTED / PASS**.

The exact supported client path has been executed from the user's *current ChatGPT conversation*:

`mcp__Sidera__sidera_capabilities({operation:"remote.bridge.read.text"})` → registered read-only tool;
`mcp__Sidera__sidera_invoke({operation:"remote.bridge.read.text",arguments:{path:"README.txt",maxBytes:2048}})`
→ existing authenticated Sidera Gateway 8788 → canonical Chief token and active Session on Sidera Core 8765
→ Sidera Remote Bridge self-hosted 127.0.0.1:47311 → actual Windows disk file → this Chat.

Actual result: `ok=true, outcome=COMPLETED, status=ok, bridgeOperation=fs.read_text`, 648 characters. Independent `remote.bridge.list({path:".",depth:1})` returned two real entries (README.txt and readonly-info.js). Traversal `../gateway.json` and Windows absolute `D:/Windows/win.ini` were denied by `BRIDGE_RELATIVE_PATH_REQUIRED`; neither reads nor writes happened. These negative calls manifest as tool errors to the ChatGPT connector, not fabricated success.

**No Remote Desktop Commander was used for those ChatGPT→Bridge client calls.** RDC was used for original source editing and gateway deployment only.

## Production and code evidence

- Sidera source commit: `3209938a97dea38f13fd6dc199386ddac06d13b2`.
- New canonical operations: `remote.bridge.list` and `remote.bridge.read.text`; both declared `readOnlyHint:true`. No write or process operations registered.
- Sidera full regression after new operations and catalog update: **435/435 PASS**, 0 failed, 0 skipped.
- Candidate local Core→Bridge real loopback test: PASS (list 2, read 648, invalid paths rejected).
- Gateway CLI `check` before and after code deployment: 82 canonical operations, exact ChatGPT Edge reachable.
- Gateway restarted only after exact code-only backup and SHA preflight. Production code checksums match candidate; original `gateway.json` and `runtime-spec.json` SHA unchanged; no SQLite/credential editing or new Node/Grant.
- New live Gateway: PID was 62472 at post-deploy observation, listening 8788. Core 8765 and Bridge 47311 retained. This is an observation, not a permanent process identifier.
- Checkpoint/rollback: `D:\Sidera-R1-checkpoints\remote-bridge-readonly-deploy-20261013\`, with original canonical-mcp.ts and manifest.
- Underlying first-party Bridge source: `D:\Sidera-Remote-Bridge`; R0 full suite 101/101 PASS from an independent Windows process.
- Current Bridge deployment's sole permitted filesystem root: `D:\Sidera-Remote-Bridge\config\readonly\workspace`.
- Credential is not in source, model tool arguments, this report, or deployment manifest. Service reads the private local credential file.

## Security and scope

The Gateway's original OAuth ingress is reused; no public Bridge port or new cloud relay was created. The new tool checks the exact existing Chief Node and active Core Session, and the original Gateway-owned Chief binding metadata. The Bridge itself requires a separate read-only bearer token with `fs.read` scope. File path stays relative to the small fixed non-sensitive allowlist and is rechecked by the Bridge.

This phase is **not** blanket filesystem access. No `fs.write_text`, arbitrary shell, `process.start`, broad project root, or Human grant minting is available from ChatGPT through this integration.

## Remaining independent HOLD

- Sidera real `Chief → Operator → original Chat` M0 is still `BLOCKED / NO_AVAILABLE_AUTHORIZED_NODE`: Codex `authority_denied`, exact Host unknown. The working new read-only tool **does not** cure dispatch.
- Gateway's original-provider exact Conversation/session correlation remains separately **UNVERIFIED**, even though this Chat's actual authenticated MCP call visibly returned a Bridge result.
- Read-only Bridge scope covers only the small approved test workspace. Expanding to actual user repositories or arbitrary disk paths requires explicit allowlist/Authority review.
- Bridge's current local token expires 2026-10-19 (UTC recorded in local private metadata). Rotate through controlled local configuration before then.
- Gateway and Bridge are running as local processes; boot/logon auto-recovery and wider remote operations are not yet accepted.

**No claim of full RDC replacement is made. Partial local read/list replacement from this Chat is demonstrated.**
