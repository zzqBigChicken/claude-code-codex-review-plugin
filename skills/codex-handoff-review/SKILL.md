---
name: codex-handoff-review
description: Use when reviewing AI-generated code, Claude-written changes, Codex-written changes, PR diffs, or local uncommitted diffs that must be checked against explicit handoff context, business rules, acceptance criteria, edge cases, permissions, data flow, or verification gaps.
---

# Codex Handoff Review

## Overview

Review the implementation against explicit handoff context plus the actual diff. Do not assume the reviewer can see hidden Claude reasoning; rely on visible transcript text, a brief, PR body, issue, spec, test, or command text.

## Core Rule

Code facts outrank the brief, and the brief outranks guesses. If the brief and transcript are missing or vague, review code quality and likely risks, but mark business-logic compliance as **unable to determine**.

## Workflow

1. Identify the review target: local working tree, staged diff, branch diff, PR diff, or named files.
2. Locate handoff context in this order: user-provided text, `review-brief.md`, PR body/linked issue, OpenSpec/spec docs, tests, `AGENTS.md`, recent visible transcript.
3. If no handoff context exists, ask for it when interactive. In non-interactive gate mode, block only when business-logic compliance cannot be determined for meaningful code changes.
4. Read project rules before judging: closest `AGENTS.md`, `CLAUDE.md`, README/CI scripts if relevant.
5. Inspect the diff and referenced call chain. Use `rg` for changed methods, fields, routes, components, SQL tables, permissions, and public contracts.
6. Compare implementation to the context:
   - Required behavior and acceptance criteria
   - Save/load/refresh/cancel/retry/state transitions
   - Permissions, tenant boundaries, auth, approval flow
   - API/model/schema compatibility
   - Error handling, null/empty states, concurrency, idempotency
   - Tests and verification actually run
7. Report findings first. Do not rewrite or patch code during review unless explicitly asked.

## Handoff Brief

Use `references/review-brief-template.md` when the context is not already explicit.

Minimum viable brief:

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

## Gate Protocol

For automatic hook review, the final answer must begin with exactly one of:

```text
ALLOW:
```

```text
BLOCK:
```

Use `BLOCK:` for `BLOCKER`, `HIGH`, or an inability to determine business-logic compliance because required context is missing.

## Severity

Use these labels:

- `BLOCKER`: Likely incorrect behavior, data loss, security/permission issue, broken public contract, or requirement not implemented.
- `HIGH`: Serious edge case, cross-module regression risk, missing required validation, or likely production failure path.
- `MEDIUM`: Maintainability or coverage issue that can hide a defect but is not clearly breaking.
- `LOW`: Small clarity issue or non-blocking cleanup.
- `VERIFICATION-GAP`: Required check was not run or cannot be trusted.

## Output Format

```markdown
ALLOW: no blocker/high findings found
```

or:

```markdown
BLOCK: concise reason

Findings:
- [SEVERITY] file:line - Problem. Why it matters. Suggested fix.

Context Coverage:
- Brief/transcript present: yes/no
- Requirements matched: ...
- Unknowns: ...

Validation:
- Reviewed diff: ...
- Reference checks: ...
- Tests/build/lint considered: ...
```

## Common Mistakes

- Treating Codex as if it saw hidden Claude reasoning.
- Reviewing only style while ignoring the required business flow.
- Trusting generated tests without checking whether they assert the real acceptance criteria.
- Calling a review "passed" when required context is missing.
- Modifying files during a review-only run.
