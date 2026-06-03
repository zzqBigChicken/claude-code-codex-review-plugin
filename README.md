# Codex Handoff Review Skill

Make Codex review AI-generated code against the business context that produced it.

This repository packages a Codex skill for a common multi-agent workflow:

1. Claude writes or edits code.
2. Claude creates a handoff brief that captures the user request, business rules, acceptance criteria, changed files, validation, and risks.
3. Codex reviews the diff against that brief in read-only mode.

The important point: Codex does not automatically know the Claude conversation. This skill makes the handoff explicit so review results are based on both the code and the intended behavior.

## What It Provides

- `codex-handoff-review/SKILL.md`: Codex review procedure and severity model.
- `codex-handoff-review/references/review-brief-template.md`: Required handoff brief template.
- `codex-handoff-review/references/claude-handoff-instruction.md`: A Claude-side instruction snippet.
- `codex-handoff-review/scripts/run-codex-review.ps1`: Optional read-only wrapper around `codex exec`.

## When To Use

Use this when:

- Claude Code writes code and you want Codex to review it.
- Codex writes code and should self-review against explicit requirements.
- A PR was created by an AI agent and the reviewer needs more than a raw diff.
- Business logic, permissions, save/load flows, data contracts, or edge cases matter.

Do not rely on this as a replacement for tests, CI, or human approval on high-risk changes.

## Installation

Copy the skill folder into your Codex skills directory:

```powershell
Copy-Item -Recurse .\codex-handoff-review $env:USERPROFILE\.codex\skills\
```

If your Codex installation uses a custom `CODEX_HOME`, copy it there instead:

```powershell
Copy-Item -Recurse .\codex-handoff-review "$env:CODEX_HOME\skills\"
```

Restart Codex after installing the skill.

## Local Claude Code Flow

Add the snippet in `codex-handoff-review/references/claude-handoff-instruction.md` to your Claude project instructions.

Claude should finish a code change by producing a brief like:

```markdown
Objective:
Required behavior:
Changed files:
Important business rules:
Data/API/UI contracts:
Known risks:
Validation already run:
Out of scope:
```

Then run Codex review through the Codex companion plugin:

```text
/codex:adversarial-review --background
Review the current diff against this handoff brief:
[paste brief]
```

Or use the local wrapper:

```powershell
.\codex-handoff-review\scripts\run-codex-review.ps1 -Repo D:\Code\project -BriefPath .\review-brief.md
```

The wrapper fails clearly if `codex` is not installed or available on `PATH`.

## GitHub Flow

For PR-based work, put the handoff brief in one of these places:

- PR body
- Linked issue
- `docs/review-brief.md`
- OpenSpec change document

Then run Codex review with your preferred GitHub integration, such as Codex Cloud review or a workflow that invokes Codex CLI. The review agent should be told to use `$codex-handoff-review`.

## Review Standard

The skill asks Codex to check:

- Requirement compliance
- Business logic and state transitions
- Permissions, tenancy, and auth boundaries
- API/model/schema compatibility
- Save, load, cancel, refresh, retry, and rollback behavior
- Error, null, empty, concurrent, and idempotent paths
- Missing or weak validation

Output starts with findings and uses these severities:

- `BLOCKER`
- `HIGH`
- `MEDIUM`
- `LOW`
- `VERIFICATION-GAP`

## Limitations

- Codex cannot inspect hidden Claude reasoning.
- If the brief is missing, business-logic compliance is not knowable.
- Large diffs can still hide issues.
- The workflow improves review coverage but does not prove correctness.

## Security

Do not put secrets, passwords, tokens, private keys, or customer data into the handoff brief. Use short descriptions and local file references when sensitive evidence is needed.
