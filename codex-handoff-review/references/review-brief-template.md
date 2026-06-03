# Review Brief Template

Use this when handing AI-generated code to Codex for review. Keep it factual and specific.

```markdown
# Review Brief

## Objective

[What the user asked for. Include the business goal, not only the files changed.]

## Required Behavior

- [Acceptance criterion 1]
- [Acceptance criterion 2]
- [Acceptance criterion 3]

## Changed Files

- `[path]`: [why it changed]

## Important Business Rules

- [Permissions, status rules, approval rules, save/load expectations, tenant boundaries, etc.]

## Data/API/UI Contracts

- [Request/response fields, database fields, component props, routes, events, or public method contracts.]

## Direct Impact Chain

- Init/default state:
- Existing data backfill:
- Save/submit input:
- Cancel/rollback behavior:
- Refresh/reload display:

## Validation Already Run

- [Command or manual check]:
- Result:
- Known unrelated baseline failures:

## Risks And Focus Areas

- [What Codex should challenge first.]

## Out Of Scope

- [What should not be changed or judged as missing.]

## Unknowns

- [Anything Claude could not verify.]
```
