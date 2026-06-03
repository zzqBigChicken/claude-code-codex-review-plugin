#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const DEFAULT_MAX_BASELINE_DIFF_CHARS = 50000;

function readStdinJson() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function run(command, args, cwd) {
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 10 * 1024 * 1024
  });
}

function isGitWorkTree(cwd) {
  const result = run("git", ["rev-parse", "--is-inside-work-tree"], cwd);
  return result.status === 0 && result.stdout.trim() === "true";
}

function dataRoot() {
  return process.env.CLAUDE_PLUGIN_DATA || path.join(os.tmpdir(), "codex-handoff-review");
}

function sessionKey(sessionId) {
  return String(sessionId || "default").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function baselinePath(sessionId) {
  return path.join(dataRoot(), "baselines", `${sessionKey(sessionId)}.json`);
}

function trimText(text, maxChars) {
  const value = String(text || "");
  return value.length > maxChars ? `${value.slice(0, maxChars)}\n...[truncated]` : value;
}

function main() {
  const hookInput = readStdinJson();
  const cwd = hookInput.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const sessionId = hookInput.session_id || process.env.CLAUDE_CODE_SESSION_ID || "default";

  if (!isGitWorkTree(cwd)) {
    return;
  }

  const status = run("git", ["status", "--porcelain"], cwd);
  const diffStat = run("git", ["diff", "--stat"], cwd);
  const diff = run("git", ["diff", "--no-ext-diff"], cwd);
  const nameStatus = run("git", ["diff", "--name-status", "HEAD", "--"], cwd);
  const maxDiffChars = Number(process.env.CODEX_HANDOFF_REVIEW_MAX_BASELINE_DIFF_CHARS || DEFAULT_MAX_BASELINE_DIFF_CHARS);

  const baseline = {
    sessionId,
    cwd,
    capturedAt: new Date().toISOString(),
    status: status.stdout || "",
    diffStat: diffStat.stdout || "",
    nameStatus: nameStatus.stdout || "",
    diff: trimText(diff.stdout || "", maxDiffChars)
  };

  fs.mkdirSync(path.dirname(baselinePath(sessionId)), { recursive: true });
  fs.writeFileSync(baselinePath(sessionId), JSON.stringify(baseline, null, 2), "utf8");
}

try {
  main();
} catch (error) {
  process.stderr.write(`Codex handoff review baseline was not recorded: ${error instanceof Error ? error.message : String(error)}\n`);
}
