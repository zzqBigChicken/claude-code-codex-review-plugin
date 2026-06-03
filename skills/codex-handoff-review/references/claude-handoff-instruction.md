# Claude Handoff Instruction

Add this to Claude-side project instructions when Claude should make Codex's stop-time review more precise.

```markdown
After code changes, include a concise Codex review brief in the final response before stopping.

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

The Codex Handoff Review plugin will automatically run at Stop time when local Git changes exist.
If Codex blocks the stop, continue fixing or clearly explain the remaining blocker.
```
