# Clean Windows validation

Use a disposable Windows x64 account/VM with no Node installation. Copy the complete Phase 2 candidate folder and verify SHA256SUMS before running. The unsigned installer can trigger Windows reputation warnings; it has no verified publisher identity.

1. Double-click the installer EXE. Confirm per-user installation, Start Menu shortcut and optional desktop shortcut. Do not supply administrator rights.
2. Launch from Start Menu. Verify Setup opens and no terminal window appears. Add a declared Node using Setup; login and provider installation are completed in their owning products. Re-check Integrations. Configuration must not claim authentication, ModelBinding or Presence.
3. Verify Work and monitoring; System diagnostics must show versions and a data directory. Export diagnostics and confirm no private conversation, tokens, credential values or runtime database is included.
4. System -> Updates must show "Update feed not configured" in this candidate. Do not create a fake server.
5. During an actual Host turn, Quit safely must refuse until the canonical stop gate succeeds. Starting the installer while Sidera is open must refuse without terminating Sidera or replacing files.
6. Quit safely, reinstall/upgrade, and confirm retained Setup/data. Uninstall through Windows Installed Apps and confirm data is retained. Reinstall and confirm recovery. Explicit data removal is outside this candidate; remove data only through a separate deliberate Human action.
7. Extract the portable ZIP into a new directory. Double-click Sidera.exe with no installed Node. Repeat first-run, no-terminal, diagnostic and stop checks.
8. Record OS version, architecture, installation directory, shortcut/uninstall results, screenshots, diagnostic summary, hashes and whether validation ran inside a disposable VM. A same-machine fresh directory is not fresh OS evidence.

An optional developer harness `fresh-machine.cjs` can be run with the portable `resources/node.exe` to install silently into a new `validation-install` folder. It validates extraction only and writes `fresh-install-result.json`; it does not substitute for the UI checklist or claim VM evidence. The main acceptance script `installer-smoke.mjs` in the source checkout additionally launches the installed UI and checks upgrade/uninstall preservation using isolated private data.
