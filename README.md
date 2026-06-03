# Claude Code Codex Review Plugin

Claude Code plugin that automatically runs a Codex review gate after AI-generated code changes.

This plugin exists for one problem: Claude Code can write code from a long conversation, but Codex only sees the repository unless the context is handed over. The plugin wires that handoff into Claude Code's `Stop` hook and asks Codex to review the final diff before Claude stops.

## Why This Exists

Without a handoff gate, Claude can finish a coding task before another reviewer has checked whether the diff still matches the original intent. This plugin turns Codex into a second-pass reviewer at the exact moment Claude Code tries to stop.

```text
Claude Code session starts
-> SessionStart hook records the starting Git state
-> Claude Code changes files
-> Stop hook runs
-> Codex reviews visible transcript context + session delta/current Git diff
-> ALLOW lets Claude stop
-> BLOCK sends the issue back into Claude Code
```

## What It Does

When Claude Code tries to stop:

1. `SessionStart` records the starting Git status and diff for the Claude Code session.
2. `Stop` checks whether the current directory is a Git repository with local changes.
3. If there are changes, it reads recent user/assistant transcript text from the current Claude session.
4. It loads the bundled `codex-handoff-review` review standard.
5. It runs `codex exec` in read-only sandbox mode.
6. Codex reviews changes after the session baseline first, then falls back to the full current Git working tree when the session delta cannot be isolated.
7. If Codex reports `BLOCK`, Claude is prevented from stopping and must continue fixing or explaining the issue.

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
git clone https://github.com/zzqBigChicken/claude-code-codex-review-plugin.git
cd claude-code-codex-review-plugin
claude plugin marketplace add . --scope user
claude plugin install codex-handoff-review@codex-handoff-review --scope user
```

After enabling the plugin, restart or reload Claude Code so hooks are picked up.

## Configuration

The default behavior is strict: if Codex cannot run, times out, exits with an error, or returns an invalid prefix, the hook blocks Claude from stopping.

Set environment variables before launching Claude Code to tune that behavior:

| Variable | Values | Default | Effect |
| --- | --- | --- | --- |
| `CODEX_HANDOFF_REVIEW_SKIP` | `1`, `true`, `yes`, `on` | unset | Disable the hook. |
| `CODEX_HANDOFF_REVIEW_FAIL_MODE` | `block`, `allow` | `block` | Global fallback for review failures. |
| `CODEX_HANDOFF_REVIEW_ON_CODEX_UNAVAILABLE` | `block`, `allow` | fail mode | Behavior when `codex` is not on `PATH`. |
| `CODEX_HANDOFF_REVIEW_ON_TIMEOUT` | `block`, `allow` | fail mode | Behavior when Codex times out. |
| `CODEX_HANDOFF_REVIEW_ON_CODEX_ERROR` | `block`, `allow` | fail mode | Behavior when Codex exits non-zero. |
| `CODEX_HANDOFF_REVIEW_ON_UNEXPECTED_OUTPUT` | `block`, `allow` | fail mode | Behavior when output does not start with `ALLOW:` or `BLOCK:`. |
| `CODEX_HANDOFF_REVIEW_MAX_TRANSCRIPT_CHARS` | number | `20000` | Recent transcript text passed to Codex. |
| `CODEX_HANDOFF_REVIEW_MAX_BASELINE_DIFF_CHARS` | number | `50000` | Baseline diff chars recorded at `SessionStart`. |
| `CODEX_HANDOFF_REVIEW_MAX_BASELINE_CHARS` | number | `50000` | Baseline chars included in the Codex prompt. |
| `CODEX_HANDOFF_REVIEW_MAX_OUTPUT_CHARS` | number | `8000` | Review text included in hook block reason. |
| `CODEX_HANDOFF_REVIEW_TIMEOUT_MS` | number | `900000` | Codex execution timeout. |
| `CODEX_HANDOFF_REVIEW_CODEX_COMMAND` | command path/name | `codex` | Override the Codex executable. |
| `CODEX_HANDOFF_REVIEW_CODEX_ARGS` | JSON string array | `[]` | Prefix arguments before `exec`; mainly useful for wrappers and tests. |

Example fail-open setup:

```powershell
$env:CODEX_HANDOFF_REVIEW_FAIL_MODE = "allow"
claude
```

## How Results Appear

- `BLOCK`: Claude Code shows the hook block reason, including Codex's review summary. Claude must continue before ending the turn.
- `ALLOW`: Claude is allowed to stop.
- Latest full output is written to plugin data when `CLAUDE_PLUGIN_DATA` is available:

```text
${CLAUDE_PLUGIN_DATA}/latest-review.md
```

The hook also writes timestamped review files in the same directory.

Baseline files are written under:

```text
${CLAUDE_PLUGIN_DATA}/baselines/
```

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

## Development

This repository has no runtime npm dependencies.

```powershell
npm run validate
npm test
claude plugin validate .
```

The smoke test creates a temporary Git repo and fake `codex` command, then verifies both `ALLOW:` and `BLOCK:` paths without calling the real Codex CLI.

## Important Limits

- This is not formal verification.
- Codex still cannot see hidden Claude reasoning.
- Codex receives recent visible transcript text, the last assistant message, optional brief files, and Git facts.
- The session baseline helps separate pre-existing changes from current-session changes. It cannot perfectly reconstruct a per-message patch if the repository starts dirty and Claude edits the same lines later.
- For exact per-task review, start Claude Code from a clean Git state or write a task-specific `review-brief.md`.
- The hook passes recent visible Claude transcript text to Codex. Do not include secrets in prompts.
- Very large or vague conversations can still produce incomplete review context.
- Tests, CI, and human review remain necessary for high-risk changes.

## Security

Do not put secrets, passwords, tokens, private keys, customer data, or production credentials into Claude prompts, handoff briefs, or review output. The plugin deliberately ignores tool result bodies when extracting transcript context, but user and assistant text can still contain sensitive information.

## License

MIT
