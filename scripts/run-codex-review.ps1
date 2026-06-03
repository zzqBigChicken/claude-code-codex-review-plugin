param(
    [string]$Repo = (Get-Location).Path,
    [string]$BriefPath,
    [string]$Focus,
    [string]$BaseRef,
    [switch]$AllowNoBrief,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

function Fail($Message, $Code) {
    Write-Error $Message
    exit $Code
}

$codex = Get-Command codex -ErrorAction SilentlyContinue
if (-not $codex) {
    Fail "codex CLI was not found on PATH. Install/login to Codex or run review manually." 127
}

$git = Get-Command git -ErrorAction SilentlyContinue
if (-not $git) {
    Fail "git was not found on PATH. Cannot collect repository context." 127
}

$repoPath = (Resolve-Path -LiteralPath $Repo).Path
$insideWorkTree = & git -C $repoPath rev-parse --is-inside-work-tree 2>$null
if ($LASTEXITCODE -ne 0 -or $insideWorkTree -ne "true") {
    Fail "Repo path is not inside a Git work tree: $repoPath" 2
}

$brief = ""
if ($BriefPath) {
    $resolvedBrief = (Resolve-Path -LiteralPath $BriefPath).Path
    $brief = Get-Content -LiteralPath $resolvedBrief -Raw -Encoding UTF8
}

if ([string]::IsNullOrWhiteSpace($brief) -and [string]::IsNullOrWhiteSpace($Focus) -and -not $AllowNoBrief) {
    Fail "No handoff brief was provided. Pass -BriefPath, -Focus, or -AllowNoBrief for a code-only review." 2
}

$baseLine = if ($BaseRef) { "Compare against base ref: $BaseRef" } else { "Review the current working tree diff." }
$briefLine = if ($brief) { $brief } else { "No brief provided. Mark business-logic compliance as unable to determine." }
$focusLine = if ($Focus) { $Focus } else { "No extra focus provided." }

$prompt = @"
Use the codex-handoff-review standard from the installed plugin or repository documentation.

Operate read-only. Do not modify files.

$baseLine

Handoff brief:
$briefLine

Additional focus:
$focusLine

Review instructions:
1. Read applicable AGENTS.md/CLAUDE.md guidance.
2. Inspect git status and diff.
3. Use rg to check changed public methods, fields, routes, components, permissions, and contracts.
4. Report findings first with BLOCKER/HIGH/MEDIUM/LOW/VERIFICATION-GAP.
5. If the brief is missing or incomplete, say which business-logic claims are unable to determine.
"@

$codexArgs = @(
    "exec",
    "--cd", $repoPath,
    "--sandbox", "read-only",
    $prompt
)

if ($DryRun) {
    Write-Output "codex $($codexArgs -join ' ')"
    exit 0
}

& $codex.Name @codexArgs
exit $LASTEXITCODE
