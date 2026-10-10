# MCP simple mode

The ordinary manager is a compact list with enabled switch, plain status, Manage and Detect again, plus one Add MCP button. It combines typed integration registrations with existing canonical result routes. Advanced exposes exact endpoint, transport, tool/capability inventory, binding/auth reference and read-only manifest. No generic execution console exists.

Add choices:

1. Discover from apps: bounded known local Claude desktop configuration path; only supported entries become previews. No broad directory scan.
2. Connect by link: Name and MCP URL. Streamable HTTP only, HTTPS or loopback HTTP, no URL userinfo/query/fragment.
3. Import configuration: common mcpServers snippet, max 64 KiB and 32 entries. Local parsing into typed configuration; preview before Enable. Commands, args, env, headers, stdio, SSE and unknown fields are reported unsupported and never executed. Unsupported entry fields prevent partial execution of that entry.

Preview is server-held, expires after ten minutes, checks configuration fingerprint, applies once and deduplicates exact entries. Core must be stopped for changes. Health initializes MCP and lists tools with bounded timeout, no redirect following/retry and no tools/call. Authentication failures show Sign in required; unknown stays Not checked.

Limits: discovery currently covers one known application. Imported general MCP entries are configuration/inspection records; they do not automatically become canonical capability bindings or Authority grants. Authenticated exact result routes remain supported by the existing advanced typed configuration. A generic authenticated OAuth/stdio import wizard is not implemented. This is an explicit completeness limit, not a claim of arbitrary MCP execution support. Parser, preview lifecycle, disabled-state health, list-only behavior and 401 classification are exercised in tests/usability-closure.test.ts.
