#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { discoverGitWorkTrees, gitChangedFiles, hasGitChanges } from "./repo-discovery.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(SCRIPT_DIR, "..");
const SKILL_PATH = path.join(PLUGIN_ROOT, "skills", "codex-handoff-review", "SKILL.md");
const DEFAULT_MAX_TRANSCRIPT_CHARS = 20000;
const DEFAULT_MAX_CODEX_OUTPUT_CHARS = 8000;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_FAIL_MODE = "block";
const DEFAULT_MAX_BASELINE_CHARS = 50000;
const DEFAULT_MAX_CHANGED_FILES = 80;
const DEFAULT_MAX_TRACKED_FILES = 80;
const DEFAULT_HISTORY_LIMIT = 100;
const SECRET_PATTERNS = [
  { name: "GitHub token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g },
  { name: "GitHub fine-grained token", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { name: "OpenAI API key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: "Private key", pattern: /-----BEGIN (?:RSA |OPENSSH |EC |DSA |)?PRIVATE KEY-----/g },
  { name: "Password assignment", pattern: /\b(?:password|passwd|pwd)\b\s*[:=]\s*["']?[^"'\s]{8,}/gi },
  { name: "API key assignment", pattern: /\b(?:api[_-]?key|secret[_-]?key|access[_-]?key|client[_-]?secret)\b\s*[:=]\s*["']?[^"'\s]{12,}/gi }
];

function envFlag(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function envChoice(name, allowed, fallback) {
  const value = String(process.env[name] || "").toLowerCase();
  return allowed.includes(value) ? value : fallback;
}

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function readStdinJson() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function commandExists(command, cwd) {
  if (path.isAbsolute(command)) {
    return fs.existsSync(command);
  }
  const checker = process.platform === "win32" ? "where" : "command";
  const args = process.platform === "win32" ? [command] : ["-v", command];
  const result = spawnSync(checker, args, { cwd, encoding: "utf8", shell: process.platform !== "win32" });
  return result.status === 0;
}

function jsonArrayEnv(name) {
  const value = process.env[name];
  if (!value) {
    return [];
  }
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error(`${name} must be a JSON array of strings.`);
  }
  return parsed;
}

function codexInvocation() {
  return {
    command: process.env.CODEX_HANDOFF_REVIEW_CODEX_COMMAND || "codex",
    prefixArgs: jsonArrayEnv("CODEX_HANDOFF_REVIEW_CODEX_ARGS")
  };
}

function run(command, args, cwd, options = {}) {
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: options.timeout ?? 30000,
    input: options.input,
    maxBuffer: 10 * 1024 * 1024
  });
}

function gitOutput(cwd, args) {
  const result = run("git", args, cwd);
  if (result.status !== 0) {
    return "";
  }
  return result.stdout || "";
}

function gitCurrentBranch(cwd) {
  return gitOutput(cwd, ["branch", "--show-current"]).trim();
}

function gitBaseRef(cwd) {
  const configured = process.env.CODEX_HANDOFF_REVIEW_BASE_REF;
  if (configured) {
    return configured;
  }
  const branch = gitCurrentBranch(cwd);
  return branch && branch !== "master" ? "origin/master" : "";
}

function currentDiff(cwd) {
  return gitOutput(cwd, ["diff", "--no-ext-diff"]);
}

function branchDiffStat(cwd, baseRef) {
  if (!baseRef) {
    return "";
  }
  return gitOutput(cwd, ["diff", "--stat", `${baseRef}...HEAD`]);
}

function contentToText(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      if (part && part.type === "text" && typeof part.text === "string") {
        return part.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function transcriptEntryToText(entry) {
  const message = entry?.message;
  if (message?.role === "user" || message?.role === "assistant") {
    const text = contentToText(message.content).trim();
    return text ? `${message.role.toUpperCase()}:\n${text}` : "";
  }

  if ((entry?.role === "user" || entry?.role === "assistant") && entry.content) {
    const text = contentToText(entry.content).trim();
    return text ? `${entry.role.toUpperCase()}:\n${text}` : "";
  }

  return "";
}

function readRecentTranscript(transcriptPath, maxChars) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return "";
  }

  const lines = fs.readFileSync(transcriptPath, "utf8").split(/\r?\n/).filter(Boolean);
  const chunks = [];
  let total = 0;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let parsed;
    try {
      parsed = JSON.parse(lines[index]);
    } catch {
      continue;
    }

    const text = transcriptEntryToText(parsed);
    if (!text) {
      continue;
    }

    chunks.push(text);
    total += text.length;
    if (total >= maxChars) {
      break;
    }
  }

  return chunks.reverse().join("\n\n---\n\n").slice(-maxChars);
}

function readOptionalBrief(cwd) {
  const candidates = [
    "review-brief.md",
    "docs/review-brief.md",
    ".claude/review-brief.md",
    ".codex/review-brief.md"
  ];

  for (const candidate of candidates) {
    const fullPath = path.join(cwd, candidate);
    if (!fs.existsSync(fullPath)) {
      continue;
    }
    const stat = fs.statSync(fullPath);
    if (!stat.isFile() || stat.size > 128 * 1024) {
      continue;
    }
    return { path: candidate, text: fs.readFileSync(fullPath, "utf8") };
  }

  return null;
}

function dataRoot() {
  return process.env.CLAUDE_PLUGIN_DATA || path.join(os.tmpdir(), "codex-handoff-review");
}

function cleanupHistory(root) {
  const limit = envNumber("CODEX_HANDOFF_REVIEW_HISTORY_LIMIT", DEFAULT_HISTORY_LIMIT);
  const entries = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^\d{4}-.*\.md$/.test(entry.name))
    .map((entry) => {
      const fullPath = path.join(root, entry.name);
      return { fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs);

  for (const entry of entries.slice(limit)) {
    fs.rmSync(entry.fullPath, { force: true });
  }
}

function sessionKey(sessionId) {
  return String(sessionId || "default").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function samePath(left, right) {
  function normalize(value) {
    const resolved = path.resolve(value || "");
    try {
      return fs.realpathSync.native(resolved);
    } catch {
      return resolved;
    }
  }

  const leftPath = normalize(left);
  const rightPath = normalize(right);
  return process.platform === "win32" ? leftPath.toLowerCase() === rightPath.toLowerCase() : leftPath === rightPath;
}

function readSessionBaseline(hookInput, cwd) {
  const sessionId = hookInput.session_id || process.env.CLAUDE_CODE_SESSION_ID || "default";
  const fullPath = path.join(dataRoot(), "baselines", `${sessionKey(sessionId)}.json`);
  if (!fs.existsSync(fullPath)) {
    return null;
  }

  const baseline = JSON.parse(fs.readFileSync(fullPath, "utf8"));
  return samePath(baseline.cwd, cwd) ? baseline : null;
}

function readSessionTracker(hookInput) {
  const sessionId = hookInput.session_id || process.env.CLAUDE_CODE_SESSION_ID || "default";
  const fullPath = path.join(dataRoot(), "sessions", `${sessionKey(sessionId)}.json`);
  if (!fs.existsSync(fullPath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(fullPath, "utf8"));
}

function trimBlock(text, maxChars) {
  const value = String(text || "").trim();
  return value.length > maxChars ? `${value.slice(0, maxChars)}\n...[truncated]` : value;
}

function baselineBlock(baseline) {
  if (!baseline) {
    return "No SessionStart baseline was found. Review the current Git working tree diff.";
  }

  const maxChars = Number(process.env.CODEX_HANDOFF_REVIEW_MAX_BASELINE_CHARS || DEFAULT_MAX_BASELINE_CHARS);
  return `SessionStart baseline captured at ${baseline.capturedAt}.

Use this baseline to separate pre-existing dirty-worktree changes from changes made during the current Claude Code session. Review the session delta first. If the delta cannot be isolated reliably, say so and review the full current working tree as a fallback.

Baseline git status:
${trimBlock(baseline.status, maxChars)}

Baseline git diff --stat:
${trimBlock(baseline.diffStat, maxChars)}

Baseline git diff --name-status:
${trimBlock(baseline.nameStatus, maxChars)}

Baseline git diff:
${trimBlock(baseline.diff, maxChars)}`;
}

function changedFilesBlock(files) {
  if (!files.length) {
    return "No changed files detected.";
  }
  const maxFiles = envNumber("CODEX_HANDOFF_REVIEW_MAX_CHANGED_FILES", DEFAULT_MAX_CHANGED_FILES);
  const visible = files.slice(0, maxFiles);
  const suffix = files.length > visible.length ? `\n...and ${files.length - visible.length} more file(s).` : "";
  return visible.map((file) => `- ${file}`).join("\n") + suffix;
}

function trackedFilesBlock(tracker) {
  const files = tracker?.touchedFiles || [];
  if (!files.length) {
    return "No Claude file tool edits were recorded for this session.";
  }
  const maxFiles = envNumber("CODEX_HANDOFF_REVIEW_MAX_TRACKED_FILES", DEFAULT_MAX_TRACKED_FILES);
  const visible = files.slice(0, maxFiles);
  const suffix = files.length > visible.length ? `\n...and ${files.length - visible.length} more tracked file(s).` : "";
  return visible.map((file) => `- ${file}`).join("\n") + suffix;
}

function autoBrief({ hookInput, transcript, brief, baseline, changedFiles, tracker }) {
  if (brief) {
    return "Explicit brief file was provided; use it as the primary handoff brief.";
  }

  const lastAssistantMessage = String(hookInput.last_assistant_message ?? "").trim();
  const transcriptPresent = Boolean(transcript);
  const baselinePresent = Boolean(baseline);
  const trackedCount = tracker?.touchedFiles?.length || 0;
  const changedCount = changedFiles.length;

  return [
    "Auto-generated handoff brief:",
    `- Objective source: infer from recent visible transcript and last assistant message.`,
    `- Last assistant summary: ${lastAssistantMessage || "not provided"}`,
    `- Transcript available: ${transcriptPresent ? "yes" : "no"}`,
    `- Session baseline available: ${baselinePresent ? "yes" : "no"}`,
    `- Claude file-tool edits recorded: ${trackedCount}`,
    `- Current changed files: ${changedCount}`,
    "- Review priority: files recorded by PostToolUse first, then current Git changed files, then relevant call chains.",
    "- If business rules are not visible in transcript/brief/code, report the missing context according to the missing-context policy."
  ].join("\n");
}

function reviewMetadata({ cwd, rawOutput, outputPath, baseline, tracker, changedFiles, baseRef, reviewRepos }) {
  const firstLine = firstMeaningfulLine(rawOutput);
  const decision = firstLine.startsWith("BLOCK:") ? "block" : firstLine.startsWith("ALLOW:") ? "allow" : "unknown";
  return {
    decision,
    firstLine,
    workspace: cwd,
    outputPath,
    generatedAt: new Date().toISOString(),
    baseRef: baseRef || null,
    reviewRepos: reviewRepos || [cwd],
    hasBaseline: Boolean(baseline),
    trackedFiles: tracker?.touchedFiles || [],
    changedFiles
  };
}

function scanSecrets(label, text) {
  const findings = [];
  const value = String(text || "");
  for (const rule of SECRET_PATTERNS) {
    const matches = value.match(rule.pattern);
    if (matches?.length) {
      findings.push(`${label}: ${rule.name}`);
    }
  }
  return findings;
}

function secretScanFindings({ transcript, brief, lastAssistantMessage, diff }) {
  if (!envFlag("CODEX_HANDOFF_REVIEW_SECRET_SCAN", true)) {
    return [];
  }

  return [
    ...scanSecrets("transcript", transcript),
    ...scanSecrets("last assistant message", lastAssistantMessage),
    ...(brief ? scanSecrets(`brief ${brief.path}`, brief.text) : []),
    ...scanSecrets("current git diff", diff)
  ];
}

function buildPrompt({ cwd, hookInput, transcript, brief, baseline, changedFiles, tracker, generatedBrief, baseRef, branchStat, failOnMissingContext, skillText }) {
  const lastAssistantMessage = String(hookInput.last_assistant_message ?? "").trim();
  const briefBlock = brief ? `Brief file (${brief.path}):\n${brief.text}` : "No review brief file found.";
  const transcriptBlock = transcript || "No recent transcript text recovered.";
  const lastAssistantBlock = lastAssistantMessage || "No last assistant message provided by hook input.";
  const baselineText = baselineBlock(baseline);
  const changedFilesText = changedFilesBlock(changedFiles);
  const trackedFilesText = trackedFilesBlock(tracker);

  return `You are running as a read-only Codex review gate for Claude Code.

Use the following review standard:

${skillText}

Gate protocol:
- Inspect the current Git working tree in: ${cwd}
- Review the actual diff and relevant call chain.
- Prefer files recorded by Claude file-tool tracking when deciding the session's primary review target.
- If a base ref is present, use it as branch/PR context, not as a replacement for working-tree review.
- If a SessionStart baseline is present, prioritize changes made after that baseline; pre-existing dirty-worktree changes are context unless they directly affect the session delta.
- Use the brief/transcript as intent context, but trust code facts over prose.
- Do not modify files.
- If there are BLOCKER or HIGH findings, start the final answer with exactly "BLOCK:".
- Missing-context policy: ${failOnMissingContext ? "BLOCK when business-logic compliance cannot be determined for a meaningful code change." : "ALLOW with a VERIFICATION-GAP when business-logic compliance cannot be determined solely because context is missing."}
- Otherwise start the final answer with exactly "ALLOW:".
- After the prefix, use these sections: Findings, Context Coverage, Validation, Changed Files.

Handoff context:

${briefBlock}

Generated handoff brief:

${generatedBrief}

Session baseline:

${baselineText}

Branch/PR context:

Base ref: ${baseRef || "not configured"}
Branch diff --stat:
${branchStat || "No branch diff stat available."}

Claude file-tool tracked files:

${trackedFilesText}

Changed files:

${changedFilesText}

Recent Claude transcript excerpt:

${transcriptBlock}

Last Claude assistant message:

${lastAssistantBlock}
`;
}

function writeReviewOutput(cwd, rawOutput) {
  const dataRootPath = dataRoot();
  fs.mkdirSync(dataRootPath, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const latestPath = path.join(dataRootPath, "latest-review.md");
  const timestampPath = path.join(dataRootPath, `${timestamp}.md`);
  const body = [`# Codex Handoff Review`, ``, `Workspace: ${cwd}`, ``, rawOutput].join("\n");
  fs.writeFileSync(latestPath, body, "utf8");
  fs.writeFileSync(timestampPath, body, "utf8");
  cleanupHistory(dataRootPath);
  return latestPath;
}

function writeReviewMetadata(metadata) {
  const root = dataRoot();
  const latestPath = path.join(root, "latest-review.json");
  fs.writeFileSync(latestPath, JSON.stringify(metadata, null, 2), "utf8");
  return latestPath;
}

function emitBlock(reason) {
  process.stdout.write(`${JSON.stringify({ decision: "block", reason })}\n`);
}

function handleGateFailure(kind, reason) {
  const globalMode = envChoice("CODEX_HANDOFF_REVIEW_FAIL_MODE", ["block", "allow"], DEFAULT_FAIL_MODE);
  const mode = envChoice(`CODEX_HANDOFF_REVIEW_ON_${kind}`, ["block", "allow"], globalMode);
  if (mode === "allow") {
    process.stderr.write(`Codex handoff review ${kind.toLowerCase()} allowed by configuration: ${reason}\n`);
    return;
  }
  emitBlock(reason);
}

function handleSecretFindings(findings) {
  if (!findings.length) {
    return false;
  }

  const reason = `Codex handoff review stopped before sending context to Codex because possible secrets were found:\n${[...new Set(findings)].map((finding) => `- ${finding}`).join("\n")}\nRemove the secret from the prompt/brief or set CODEX_HANDOFF_REVIEW_ON_SECRET=allow if this is a false positive.`;
  handleGateFailure("SECRET", reason);
  return true;
}

function firstMeaningfulLine(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || "";
}

function aggregateReviewOutput(items) {
  const hasBlock = items.some((item) => item.firstLine.startsWith("BLOCK:"));
  const prefix = hasBlock ? "BLOCK:" : "ALLOW:";
  const sections = items.map((item) => [
    `## Repository: ${item.cwd}`,
    "",
    item.rawOutput || "No Codex output."
  ].join("\n"));
  return [prefix, "", ...sections].join("\n");
}

function trimForReason(text) {
  const max = Number(process.env.CODEX_HANDOFF_REVIEW_MAX_OUTPUT_CHARS || DEFAULT_MAX_CODEX_OUTPUT_CHARS);
  const value = String(text || "").trim();
  return value.length > max ? `${value.slice(0, max)}\n...[truncated]` : value;
}

function main() {
  const hookInput = readStdinJson();
  const cwd = hookInput.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const maxTranscriptChars = Number(process.env.CODEX_HANDOFF_REVIEW_MAX_TRANSCRIPT_CHARS || DEFAULT_MAX_TRANSCRIPT_CHARS);

  if (envFlag("CODEX_HANDOFF_REVIEW_SKIP")) {
    return;
  }

  const reviewRepos = discoverGitWorkTrees(cwd).filter((repo) => hasGitChanges(repo));
  if (!reviewRepos.length) {
    return;
  }

  const codex = codexInvocation();
  if (!commandExists(codex.command, cwd)) {
    handleGateFailure("CODEX_UNAVAILABLE", "Codex handoff review could not run because `codex` was not found on PATH. Install/login to Codex or disable the plugin hook.");
    return;
  }

  const lastAssistantMessage = String(hookInput.last_assistant_message ?? "").trim();
  const transcript = readRecentTranscript(hookInput.transcript_path, maxTranscriptChars);
  const skillText = fs.readFileSync(SKILL_PATH, "utf8");
  const tracker = readSessionTracker(hookInput);
  const failOnMissingContext = envFlag("CODEX_HANDOFF_REVIEW_FAIL_ON_MISSING_CONTEXT", true);
  const repoContexts = reviewRepos.map((repo) => {
    const brief = readOptionalBrief(repo);
    const diff = currentDiff(repo);
    const baseline = readSessionBaseline(hookInput, repo);
    const changedFiles = gitChangedFiles(repo);
    const baseRef = gitBaseRef(repo);
    const branchStat = branchDiffStat(repo, baseRef);
    const generatedBrief = autoBrief({ hookInput, transcript, brief, baseline, changedFiles, tracker });
    return { cwd: repo, brief, diff, baseline, changedFiles, baseRef, branchStat, generatedBrief };
  });

  for (const context of repoContexts) {
    if (handleSecretFindings(secretScanFindings({ transcript, brief: context.brief, lastAssistantMessage, diff: context.diff }))) {
      return;
    }
  }

  if (process.env.CODEX_HANDOFF_REVIEW_DRY_RUN === "1") {
    process.stdout.write(JSON.stringify({
      dryRun: true,
      cwd,
      reviewRepos,
      repos: repoContexts.map((context) => ({
        cwd: context.cwd,
        hasTranscript: Boolean(transcript),
        hasBrief: Boolean(context.brief),
        hasBaseline: Boolean(context.baseline),
        hasToolTracker: Boolean(tracker),
        baseRef: context.baseRef || null,
        changedFiles: context.changedFiles
      })),
      trackedFiles: tracker?.touchedFiles || [],
      failOnMissingContext,
      promptChars: repoContexts.reduce((total, context) => total + buildPrompt({
        cwd: context.cwd,
        hookInput,
        transcript,
        brief: context.brief,
        baseline: context.baseline,
        changedFiles: context.changedFiles,
        tracker,
        generatedBrief: context.generatedBrief,
        baseRef: context.baseRef,
        branchStat: context.branchStat,
        failOnMissingContext,
        skillText
      }).length, 0)
    }, null, 2));
    process.stdout.write("\n");
    return;
  }

  const reviews = [];
  for (const context of repoContexts) {
    const prompt = buildPrompt({
      cwd: context.cwd,
      hookInput,
      transcript,
      brief: context.brief,
      baseline: context.baseline,
      changedFiles: context.changedFiles,
      tracker,
      generatedBrief: context.generatedBrief,
      baseRef: context.baseRef,
      branchStat: context.branchStat,
      failOnMissingContext,
      skillText
    });
    const result = run(codex.command, [...codex.prefixArgs, "exec", "--cd", context.cwd, "--sandbox", "read-only", "-"], context.cwd, {
      input: prompt,
      timeout: Number(process.env.CODEX_HANDOFF_REVIEW_TIMEOUT_MS || DEFAULT_TIMEOUT_MS)
    });

    if (result.error?.code === "ETIMEDOUT") {
      handleGateFailure("TIMEOUT", `Codex handoff review timed out in ${context.cwd}. Run the review manually or fix the timeout before ending.`);
      return;
    }

    const rawOutput = `${result.stdout || ""}${result.stderr ? `\n\nSTDERR:\n${result.stderr}` : ""}`.trim();
    reviews.push({
      cwd: context.cwd,
      result,
      rawOutput,
      firstLine: firstMeaningfulLine(rawOutput)
    });

    if (result.status !== 0) {
      const aggregateOutput = aggregateReviewOutput(reviews);
      const outputPath = writeReviewOutput(cwd, aggregateOutput);
      handleGateFailure("CODEX_ERROR", `Codex handoff review failed in ${context.cwd}. Latest output: ${outputPath}\n${trimForReason(rawOutput)}`);
      return;
    }
  }

  const unexpected = reviews.find((review) => !review.firstLine.startsWith("ALLOW:") && !review.firstLine.startsWith("BLOCK:"));
  const rawOutput = aggregateReviewOutput(reviews);
  const outputPath = writeReviewOutput(cwd, rawOutput);
  const metadata = reviewMetadata({
    cwd,
    rawOutput,
    outputPath,
    baseline: repoContexts.some((context) => context.baseline),
    tracker,
    changedFiles: repoContexts.flatMap((context) => context.changedFiles.map((file) => `${context.cwd}:${file}`)),
    baseRef: repoContexts.map((context) => context.baseRef).filter(Boolean).join(", "),
    reviewRepos
  });
  writeReviewMetadata(metadata);

  if (unexpected) {
    handleGateFailure("UNEXPECTED_OUTPUT", `Codex handoff review returned an unexpected format for ${unexpected.cwd}. It must start with ALLOW: or BLOCK:. Latest output: ${outputPath}\n${trimForReason(unexpected.rawOutput)}`);
    return;
  }

  if (reviews.some((review) => review.firstLine.startsWith("BLOCK:"))) {
    emitBlock(`Codex handoff review blocked this stop. Latest output: ${outputPath}\n${trimForReason(rawOutput)}`);
    return;
  }
}

try {
  main();
} catch (error) {
  emitBlock(`Codex handoff review hook failed: ${error instanceof Error ? error.message : String(error)}`);
}
