#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(SCRIPT_DIR, "..");
const SKILL_PATH = path.join(PLUGIN_ROOT, "skills", "codex-handoff-review", "SKILL.md");
const DEFAULT_MAX_TRANSCRIPT_CHARS = 20000;
const DEFAULT_MAX_CODEX_OUTPUT_CHARS = 8000;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

function readStdinJson() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function commandExists(command, cwd) {
  const checker = process.platform === "win32" ? "where" : "command";
  const args = process.platform === "win32" ? [command] : ["-v", command];
  const result = spawnSync(checker, args, { cwd, encoding: "utf8", shell: process.platform !== "win32" });
  return result.status === 0;
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

function isGitWorkTree(cwd) {
  const result = run("git", ["rev-parse", "--is-inside-work-tree"], cwd);
  return result.status === 0 && result.stdout.trim() === "true";
}

function hasGitChanges(cwd) {
  const status = run("git", ["status", "--porcelain"], cwd);
  if (status.status !== 0) {
    throw new Error(`Unable to read git status: ${status.stderr || status.stdout}`);
  }
  return status.stdout.trim().length > 0;
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

function buildPrompt({ cwd, hookInput, transcript, brief, skillText }) {
  const lastAssistantMessage = String(hookInput.last_assistant_message ?? "").trim();
  const briefBlock = brief ? `Brief file (${brief.path}):\n${brief.text}` : "No review brief file found.";
  const transcriptBlock = transcript || "No recent transcript text recovered.";
  const lastAssistantBlock = lastAssistantMessage || "No last assistant message provided by hook input.";

  return `You are running as a read-only Codex review gate for Claude Code.

Use the following review standard:

${skillText}

Gate protocol:
- Inspect the current Git working tree in: ${cwd}
- Review the actual diff and relevant call chain.
- Use the brief/transcript as intent context, but trust code facts over prose.
- Do not modify files.
- If there are BLOCKER or HIGH findings, start the final answer with exactly "BLOCK:".
- If Codex cannot determine business-logic compliance because context is missing for a meaningful code change, start with exactly "BLOCK:" and explain the missing context.
- Otherwise start the final answer with exactly "ALLOW:".
- After the prefix, include concise findings and verification gaps.

Handoff context:

${briefBlock}

Recent Claude transcript excerpt:

${transcriptBlock}

Last Claude assistant message:

${lastAssistantBlock}
`;
}

function writeReviewOutput(cwd, rawOutput) {
  const dataRoot = process.env.CLAUDE_PLUGIN_DATA || path.join(os.tmpdir(), "codex-handoff-review");
  fs.mkdirSync(dataRoot, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const latestPath = path.join(dataRoot, "latest-review.md");
  const timestampPath = path.join(dataRoot, `${timestamp}.md`);
  const body = [`# Codex Handoff Review`, ``, `Workspace: ${cwd}`, ``, rawOutput].join("\n");
  fs.writeFileSync(latestPath, body, "utf8");
  fs.writeFileSync(timestampPath, body, "utf8");
  return latestPath;
}

function emitBlock(reason) {
  process.stdout.write(`${JSON.stringify({ decision: "block", reason })}\n`);
}

function firstMeaningfulLine(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || "";
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

  if (!isGitWorkTree(cwd) || !hasGitChanges(cwd)) {
    return;
  }

  if (!commandExists("codex", cwd)) {
    emitBlock("Codex handoff review could not run because `codex` was not found on PATH. Install/login to Codex or disable the plugin hook.");
    return;
  }

  const skillText = fs.readFileSync(SKILL_PATH, "utf8");
  const transcript = readRecentTranscript(hookInput.transcript_path, maxTranscriptChars);
  const brief = readOptionalBrief(cwd);
  const prompt = buildPrompt({ cwd, hookInput, transcript, brief, skillText });

  if (process.env.CODEX_HANDOFF_REVIEW_DRY_RUN === "1") {
    process.stdout.write(JSON.stringify({
      dryRun: true,
      cwd,
      hasTranscript: Boolean(transcript),
      hasBrief: Boolean(brief),
      promptChars: prompt.length
    }, null, 2));
    process.stdout.write("\n");
    return;
  }

  const result = run("codex", ["exec", "--cd", cwd, "--sandbox", "read-only", "-"], cwd, {
    input: prompt,
    timeout: Number(process.env.CODEX_HANDOFF_REVIEW_TIMEOUT_MS || DEFAULT_TIMEOUT_MS)
  });

  if (result.error?.code === "ETIMEDOUT") {
    emitBlock("Codex handoff review timed out. Run the review manually or fix the timeout before ending.");
    return;
  }

  const rawOutput = `${result.stdout || ""}${result.stderr ? `\n\nSTDERR:\n${result.stderr}` : ""}`.trim();
  const outputPath = writeReviewOutput(cwd, rawOutput);

  if (result.status !== 0) {
    emitBlock(`Codex handoff review failed. Latest output: ${outputPath}\n${trimForReason(rawOutput)}`);
    return;
  }

  const firstLine = firstMeaningfulLine(rawOutput);
  if (firstLine.startsWith("ALLOW:")) {
    return;
  }

  if (firstLine.startsWith("BLOCK:")) {
    emitBlock(`Codex handoff review blocked this stop. Latest output: ${outputPath}\n${trimForReason(rawOutput)}`);
    return;
  }

  emitBlock(`Codex handoff review returned an unexpected format. It must start with ALLOW: or BLOCK:. Latest output: ${outputPath}\n${trimForReason(rawOutput)}`);
}

try {
  main();
} catch (error) {
  emitBlock(`Codex handoff review hook failed: ${error instanceof Error ? error.message : String(error)}`);
}
