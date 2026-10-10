# Report presentation model

Two independent controls: detail (Brief / Detailed) and precision (Overview / Exact). Default is Brief + Overview. Presentation is pure; it cannot mutate canonical facts.

| Mode | Included information |
|---|---|
| Brief + Overview | Outcome, what changed, Human attention, next step; no internal IDs |
| Detailed + Overview | Above plus work steps, services, outputs, blockers and evidence summary in plain categories |
| Brief + Exact | Four summary fields plus compact canonical states, exact timestamps/IDs, evidence references and uncertainty boundary |
| Detailed + Exact | Expanded work and canonical records, runs, effects and evidence |

Unknown or unreadable records never become success. Recorded completion does not prove external delivery. Overview coarsens wording only. Exact distinguishes canonical_records from projected presentation states; if canonical records are unavailable it says UNKNOWN rather than pretending the UI projection is canonical. IDs and technical detail appear only in Exact. Existing authorization/redaction boundaries still apply to live snapshots.

Copy uses bounded desktop clipboard IPC. Export uses the native save dialog and UTF-8 text. Errors produce no success message and are not retried. Packaged smoke exercised all four modes plus English, intercepted clipboard writes to preserve the Human clipboard, selected a local evidence export target and compared its bytes with copied text. Screenshots are in usability-evidence/screenshots/report-*.png. tests/usability-closure.test.ts verifies four-mode independence, unknown truth and canonical exact states/timestamps/evidence.
