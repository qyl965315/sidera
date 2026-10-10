# R1 UI Completeness Addendum — No Console in Normal Human Operation

Human decision:
PowerShell / console must be removed from the normal visible product interaction layer.

Product rule:
- Normal Human operation happens in the Sidera UI.
- CLI/PowerShell remains only for recovery, diagnostics, automation, developer maintenance, or unsupported advanced service work.
- A normal user must not be instructed to type commands for setup, configuration, permission changes, Node/Host management, Chief binding, work submission, recovery, monitoring, or stop/restart.
- Normal startup should be one launch action (shortcut/launcher). A console window may exist internally only if technically necessary, but it should not be the interactive control surface and ideally should be hidden/detached.
- Startup/configuration failures should surface in the UI with actionable status, not as terminal-only text.
- Runtime logs should be viewable from System/Advanced UI rather than requiring PowerShell tailing.
- If an operation is not legitimately Human-executable, show it in UI as actor-gated/unavailable; do not send the Human to PowerShell as the normal workaround.
- README quick-start should describe UI-first operation. CLI commands belong under Advanced/Recovery.

Acceptance:
1. From a clean candidate, ordinary user launches Sidera once and completes all supported normal Human setup/operation without typing into PowerShell.
2. No normal UI flow says “run this command”.
3. Core start/stop/restart, setup, permissions, Host configuration, Chief binding, New Work, monitoring and supported recovery are UI-accessible.
4. CLI-only capabilities are explicitly classified as recovery/developer/actor-ineligible, not missing normal product controls.
5. If possible in R1, provide a quiet Windows launcher that opens Workbench without leaving an interactive terminal window; otherwise document this as the only remaining presentation defect and make it non-interactive.
