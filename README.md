# Sidera

Sidera is a local-first workspace for running real, authorized computer work with durable evidence.
A Human owns intent and root authority; Nodes execute exact bounded work; every effect is journaled and uncertain outcomes are reconciled instead of blindly replayed.

## What works today
- Built-in local executor (peregrine-local): real file writes and bounded Node processes inside a Core-owned contained workspace, with SHA-256 evidence and exactly-once request semantics.
- Desktop workbench: first use, project and node setup, permission review with native Human confirmation, task monitoring and evidence, local execution panel.
- Core: constitutional Authority, Effect gate, Shared History, responsibility and reconciliation, crash recovery that never fabricates success.
- Optional adapters for external Hosts and for the open Executor/Bridge plugin protocol. No private bridge is required for the built-in path.

## Requirements and development
- Windows 11 x64, Node.js 24 or newer for source use.
- Run: npm install ; npm test (full Core suite) ; npm --prefix ui run build ; npm run desktop.
- Local product E2E: node scripts/e2e-local-executor.ts.

## License
Apache License 2.0. Third-party dependency licenses are listed in THIRD_PARTY_NOTICES.md.
