# Codex Handoff Review Plugin

Automatically run a Codex review gate when Claude Code finishes a turn after code changes.

This plugin exists for one problem: Claude can write code from a long conversation, but Codex only sees the repository unless the context is handed over. The plugin wires that handoff into Claude Code's `Stop` hook.

## What It Does

When Claude Code tries to stop:

1. The plugin checks whether the current directory is a Git repository with local changes.
2. If there are changes, it reads recent user/assistant transcript text from the current Claude session.
3. It loads the bundled `codex-handoff-review` review standard.
4. It runs `codex exec` in read-only sandbox mode.
5. If Codex reports `BLOCK`, Claude is prevented from stopping and must continue fixing or explaining the issue.

No manual `/codex:review` command is required after the plugin is installed and enabled.

## Repository Layout

```text
.claude-plugin/plugin.json
hooks/hooks.json
scripts/codex-handoff-review-stop.mjs
scripts/run-codex-review.ps1
skills/codex-handoff-review/SKILL.md
skills/codex-handoff-review/agents/openai.yaml
skills/codex-handoff-review/references/review-brief-template.md
skills/codex-handoff-review/references/claude-handoff-instruction.md
```

## Requirements

- Claude Code with plugin and hook support.
- Codex CLI available as `codex` on `PATH`.
- Codex authenticated locally.
- Git repository workspace.

## Install

Clone this repository, then install it as a Claude Code plugin from the local path.

```powershell
git clone https://github.com/zzqBigChicken/codex-handoff-review-skill.git
cd codex-handoff-review-skill
claude --plugin-dir .
```

If you use Claude Code's plugin marketplace flow, add this repository as a plugin source and install `codex-handoff-review`.

After enabling the plugin, restart or reload Claude Code so hooks are picked up.

## How Results Appear

- `BLOCK`: Claude Code shows the hook block reason, including Codex's review summary. Claude must continue before ending the turn.
- `ALLOW`: Claude is allowed to stop.
- Latest full output is written to plugin data when `CLAUDE_PLUGIN_DATA` is available:

```text
${CLAUDE_PLUGIN_DATA}/latest-review.md
```

The hook also writes timestamped review files in the same directory.

## Review Standard

The hook asks Codex to check:

- Requirement compliance
- Business logic and state transitions
- Permissions, tenancy, and auth boundaries
- API/model/schema compatibility
- Save, load, cancel, refresh, retry, and rollback behavior
- Error, null, empty, concurrent, and idempotent paths
- Missing or weak validation

Codex must start its final answer with:

```text
ALLOW:
```

or:

```text
BLOCK:
```

The hook blocks Claude only when Codex returns `BLOCK` or when Codex cannot run for a changed Git working tree.

## Optional Manual Review

You can still run the bundled wrapper manually:

```powershell
.\scripts\run-codex-review.ps1 -Repo D:\Code\project -BriefPath .\review-brief.md
```

Use `-DryRun` to verify the generated command without starting Codex:

```powershell
.\scripts\run-codex-review.ps1 -Repo D:\Code\project -AllowNoBrief -DryRun
```

## Important Limits

- This is not formal verification.
- Codex still cannot see hidden Claude reasoning.
- The hook passes recent visible Claude transcript text to Codex. Do not include secrets in prompts.
- Very large or vague conversations can still produce incomplete review context.
- Tests, CI, and human review remain necessary for high-risk changes.

## Security

Do not put secrets, passwords, tokens, private keys, customer data, or production credentials into Claude prompts, handoff briefs, or review output. The plugin deliberately ignores tool result bodies when extracting transcript context, but user and assistant text can still contain sensitive information.
