# R1 onboarding simplification

Date: 2026-10-06. Status: local implementation and onboarding validation complete; unpublished.

## Result

The product Add Codex dialog no longer asks for an executable, internal locator, model, or isolation directories. An ordinary user can click Codex, leave the optional work folder blank, and save the configuration through Connect Codex. The desktop visual test exercised this actual UI and local endpoint in a fresh isolated Sidera profile without entering any filesystem path.

Installation, saved configuration, authentication, Presence and actual provider conversation remain separate facts. The UI says Installed / Sign-in unverified before configuration and Configured / Sign-in unverified afterwards. It does not claim Connected merely because a file or configuration exists.

## Changes

- `core/installed-detection.ts`: read-only discovery of known native executable basenames. Codex checks up to 32 immediate version/hash directories under LOCALAPPDATA/OpenAI/Codex/bin, up to 128 PATH entries, and known npm vendor executable layouts. Grok and Antigravity use their exact native basenames on PATH. No recursive whole-machine scan, program execution, credential inspection, authentication inference or automatic installation.
- Native `codex.exe` is preferred over `codex.cmd`. Wrapper-only discovery reports installed but unsupported, and cannot save an automatic executable configuration.
- `core/local-setup.ts`: strict automatic setup input accepts only supported adapter choice and an optional work folder. It generates separate workspace, user, temporary and Codex configuration directories under LOCALAPPDATA/Sidera/isolated-hosts/<unique-id>. Directory creation follows the existing stopped-Core and Host replacement checks. Existing configurations are not replaced.
- Internal configuration locator is generated as `installed://<canonical-node-id>/<canonical-session-id>` after identifiers are allocated. It is shown read-only in Advanced as Internal locator. This is a precise Sidera configuration declaration, not a claim that Codex has returned a provider thread ID.
- Model uses `auto`; the Codex adapter omits the model argument in this case so the owning product chooses its default. Explicit existing model values remain explicit.
- `core/desktop-management.ts`: first-time discovery is independent of saved configurations. Advanced evidence includes discovery records and exact saved adapter options; browser redaction still applies.
- `ui/src/ProductApp.tsx`: ordinary executable setup asks only for an optional work folder, with a leave-blank explanation. Advanced shows readable adapter, internal locator, executable, model and directory values plus a collapsed raw record. The vague official-guidance action has been replaced with installation or sign-in instructions.
- Main action varies with state: Connect Codex when a supported native executable is detected; View installation options when missing; Detect again when configured or when only an unsupported wrapper was found. Sign-in instructions remain secondary when installed. There is no fabricated owning-product login launcher.
- The normal product setup requires no terminal or PowerShell.

## Progressive disclosure audit

| Service | Ordinary choice | Advanced or limitation |
| --- | --- | --- |
| Codex | Optional work folder; contextual primary action | Detected executable, canonical configuration locator, generated directories, auto model and exact adapter |
| Grok | Optional work folder; contextual primary action | PATH native detection and generated user/work directories; exact records retained |
| DeepSeek | Display name, configured local credential explanation | API URL and credential environment reference moved into Advanced; no secret pasted into the dialog |
| Gemini | Owning-product setup explanation | Native detection is bounded, but safe default provider/model/settings contracts are unavailable; automatic setup stays unavailable |
| GLM | Owning-product setup explanation | Existing native-service SDK setup has no safe automatic install/default contract; restriction preserved |
| DSH | Owning-product setup explanation | Script entry and owning-product installation contract remain restricted |
| MCP | Choose external conversation or result service | Exact edge/locator and return-route implementation details retain existing disclosure and typed validation |

The routed product UI uses ProductApp. Older unmounted developer form components remain in the source tree; their technical forms are not the ordinary product route.

## Current machine evidence

Read-only discovery found the supported native candidate:

`C:\Users\13cheng4\AppData\Local\OpenAI\Codex\bin\f544b3844e0f14e9\codex.exe`

It also found `C:\Users\13cheng4\AppData\Roaming\npm\codex.cmd` and distinguished it from the native executable. `installed=true`, `supported=true`, `wrapperOnly=false`, `signIn=UNVERIFIED`. These are bounded file/layout facts, not an app-server protocol or login verification.

Evidence: `desktop-evidence/onboarding/machine-detection.json`.

## Validation

| Check | Result |
| --- | --- |
| npm run check | PASS |
| npm test | PASS, 268/268; full output in desktop-evidence/onboarding/core-tests.txt |
| New bounded detection and automatic configuration behavior tests | PASS, 2/2; missing, wrapper-only, exact native basename, unknown sign-in, generated directories, canonical identifiers and replacement protection |
| npm --prefix desktop test | PASS, 13/13 |
| npm --prefix ui run build | PASS, typecheck and Vite production build |
| npm --prefix ui run test:smoke | PASS; seven service dialogs, ordinary disclosure audit, zh/en navigation, exact review gate and uncertain-operation protection |
| ui/scripts/localization-coverage.mjs | PASS, 383 paired literal calls and 54 legacy dictionary keys |
| desktop/onboarding-visual.mjs | PASS; real detected state, path-free configuration save, generated advanced details and explicit missing-installation simulation; no renderer errors |

The first sandboxed Electron launch failed due to Windows AppContainer ACL restrictions, and the first sandboxed full suite encountered a Chromium fixture timeout. No ACL changes or sandbox-disable flags were applied. The desktop visual test and full test suite were rerun outside the restricted execution sandbox and passed. Production Electron security settings were not changed.

## Screenshots

- `desktop-evidence/onboarding/codex-detected.png`: actual current-machine discovery, empty isolated Sidera profile, Advanced closed.
- `desktop-evidence/onboarding/codex-not-installed-simulation.png`: explicitly intercepted read-only missing-installation response; primary installation action. No executable was removed from the machine.
- `desktop-evidence/onboarding/codex-advanced.png`: actual path-free UI configuration saved in the isolated test profile, showing generated identifiers and directories read-only.
- `desktop-evidence/onboarding/visual.json`: provenance and renderer error result.

Screenshots were visually inspected. Advanced details wrap long paths and scroll within the dialog; normal setup exposes no internal locator or isolation field.

## Boundaries

This validates discovery and configuration onboarding, not authenticated Codex execution. The generated Sidera locator is not a provider-issued Codex thread identifier; actual provider session creation/enrollment must continue through existing owning-product and canonical runtime operations. No login, provider thread, verified model binding, Presence, Authority or completed task is inferred or manufactured by this change. The screenshot test saved configuration but did not launch Codex or start Core.

No new safe automatic login contract was available. Gemini, GLM and DSH were kept explicitly limited rather than inventing defaults or launch actions. DeepSeek continues to use the existing local credential-reference contract; this change does not add a key-management flow.

No publication, release packaging, deployment, update-feed change or external service call was performed. Existing runtime profiles were not modified; the visual test used temporary Sidera profiles and unique Sidera-managed isolation directories, retained as local debugging artifacts.
