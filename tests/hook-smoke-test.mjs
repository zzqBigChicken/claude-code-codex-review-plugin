#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK_SCRIPT = path.join(REPO_ROOT, "scripts", "codex-handoff-review-stop.mjs");
const SESSION_START_SCRIPT = path.join(REPO_ROOT, "scripts", "codex-handoff-review-session-start.mjs");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    ...options
  });
  if (options.check !== false && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result;
}

function writeMockCodex(tempRoot) {
  const scriptPath = path.join(tempRoot, "mock-codex.mjs");
  fs.writeFileSync(scriptPath, "console.log(process.argv[2] || 'ALLOW: mocked review passed');\n", "utf8");
  return scriptPath;
}

function createChangedRepo(tempRoot) {
  const repo = path.join(tempRoot, "repo");
  fs.mkdirSync(repo, { recursive: true });
  run("git", ["init"], { cwd: repo });
  run("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  run("git", ["config", "user.name", "Test User"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "feature.txt"), "before\n", "utf8");
  run("git", ["add", "feature.txt"], { cwd: repo });
  run("git", ["commit", "-m", "seed"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "feature.txt"), "after\n", "utf8");
  return repo;
}

function runHook(repo, envOverrides = {}) {
  const input = JSON.stringify({
    cwd: repo,
    session_id: "test-session",
    transcript_path: "",
    last_assistant_message: "Implemented a sample change."
  });

  return run("node", [HOOK_SCRIPT], {
    input,
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...envOverrides
    },
    check: false
  });
}

function runSessionStart(repo, dataDir) {
  const input = JSON.stringify({
    cwd: repo,
    session_id: "test-session"
  });

  return run("node", [SESSION_START_SCRIPT], {
    input,
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      CLAUDE_PLUGIN_DATA: dataDir
    },
    check: false
  });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-review-hook-test-"));
try {
  const repo = createChangedRepo(tempRoot);
  const dataDir = path.join(tempRoot, "data");
  const mockCodex = writeMockCodex(tempRoot);
  const envBase = {
    CLAUDE_PLUGIN_DATA: dataDir,
    CODEX_HANDOFF_REVIEW_CODEX_COMMAND: process.execPath
  };

  const baselineResult = runSessionStart(repo, dataDir);
  assert(baselineResult.status === 0, "SessionStart baseline run should exit 0");
  assert(fs.existsSync(path.join(dataDir, "baselines", "test-session.json")), "SessionStart should write a baseline file");

  const dryRunResult = runHook(repo, {
    ...envBase,
    CODEX_HANDOFF_REVIEW_DRY_RUN: "1",
    CODEX_HANDOFF_REVIEW_CODEX_ARGS: JSON.stringify([mockCodex, "ALLOW: mocked review passed"])
  });
  assert(dryRunResult.status === 0, "dry run should exit 0");
  assert(dryRunResult.stdout.includes('"hasBaseline": true'), "dry run should detect the SessionStart baseline");

  const allowResult = runHook(repo, {
    ...envBase,
    CODEX_HANDOFF_REVIEW_CODEX_ARGS: JSON.stringify([mockCodex, "ALLOW: mocked review passed"])
  });
  assert(allowResult.status === 0, "ALLOW run should exit 0");
  assert(!allowResult.stdout.includes('"decision":"block"'), "ALLOW run should not block");
  assert(fs.existsSync(path.join(dataDir, "latest-review.md")), "ALLOW run should write latest review output");

  const blockResult = runHook(repo, {
    ...envBase,
    CODEX_HANDOFF_REVIEW_CODEX_ARGS: JSON.stringify([mockCodex, "BLOCK: mocked blocker found"])
  });
  assert(blockResult.status === 0, "BLOCK run should exit 0");
  assert(blockResult.stdout.includes('"decision":"block"'), "BLOCK run should emit a block decision");
  assert(blockResult.stdout.includes("mocked blocker found"), "BLOCK run should include Codex output");

  const missingCodex = runHook(repo, {
    CODEX_HANDOFF_REVIEW_CODEX_COMMAND: path.join(tempRoot, "missing-codex"),
    CODEX_HANDOFF_REVIEW_ON_CODEX_UNAVAILABLE: "allow"
  });
  assert(missingCodex.status === 0, "fail-open missing Codex run should exit 0");
  assert(!missingCodex.stdout.includes('"decision":"block"'), "fail-open missing Codex should not block");

  console.log("hook smoke tests passed");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
