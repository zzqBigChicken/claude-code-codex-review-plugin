# Claude Handoff Instruction

Add this to Claude-side project instructions when Claude should trigger Codex review after editing code.

```markdown
After code changes, prepare a concise Codex review brief before final delivery.

The brief must include:
- Objective
- Required behavior and acceptance criteria
- Changed files and why
- Important business rules
- Data/API/UI contracts
- Direct impact chain
- Validation already run
- Risks/focus areas
- Out of scope
- Unknowns

Then invoke Codex in read-only review mode if available:

`/codex:adversarial-review --background`

Paste the brief after the command and ask Codex to review the current diff against it.

If Codex CLI/plugin is unavailable, do not claim Codex reviewed the change. Report: "Codex handoff review was not executed" and include the reason.
```
