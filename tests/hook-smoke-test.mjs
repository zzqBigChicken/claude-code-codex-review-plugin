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
const POST_TOOL_USE_SCRIPT = path.join(REPO_ROOT, "scripts", "codex-handoff-review-post-tool-use.mjs");

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

function createRepo(tempRoot, name, changed) {
  const repo = path.join(tempRoot, name);
  fs.mkdirSync(repo, { recursive: true });
  run("git", ["init"], { cwd: repo });
  run("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  run("git", ["config", "user.name", "Test User"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "feature.txt"), "before\n", "utf8");
  run("git", ["add", "feature.txt"], { cwd: repo });
  run("git", ["commit", "-m", "seed"], { cwd: repo });
  if (changed) {
    fs.writeFileSync(path.join(repo, "feature.txt"), "after\n", "utf8");
  }
  return repo;
}

function createChangedRepo(tempRoot) {
  return createRepo(tempRoot, "repo", true);
}

function createCleanRepo(tempRoot) {
  return createRepo(tempRoot, "clean-repo", false);
}

function runHook(repo, envOverrides = {}) {
  const input = JSON.stringify({
    cwd: repo,
    session_id: "test-session",
    transcript_path: "",
    last_assistant_message: envOverrides.LAST_ASSISTANT_MESSAGE || "Implemented a sample change."
  });

  return run("node", [HOOK_SCRIPT], {
    input,
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...Object.fromEntries(Object.entries(envOverrides).filter(([key]) => key !== "LAST_ASSISTANT_MESSAGE"))
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

function runPostToolUse(repo, dataDir, filePath = path.join(repo, "feature.txt")) {
  const input = JSON.stringify({
    cwd: repo,
    session_id: "test-session",
    tool_name: "Edit",
    tool_input: {
      file_path: filePath
    }
  });

  return run("node", [POST_TOOL_USE_SCRIPT], {
    input,
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      CLAUDE_PLUGIN_DATA: dataDir
    },
    check: false
  });
}

function runNotebookToolUse(repo, dataDir, filePath = path.join(repo, "notes.ipynb")) {
  const input = JSON.stringify({
    cwd: repo,
    session_id: "test-session",
    tool_name: "NotebookEdit",
    tool_input: {
      notebook_path: filePath
    }
  });

  return run("node", [POST_TOOL_USE_SCRIPT], {
    input,
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      CLAUDE_PLUGIN_DATA: dataDir
    },
    check: false
  });
}

function runBashToolUse(repo, dataDir) {
  const input = JSON.stringify({
    cwd: repo,
    session_id: "test-session",
    tool_name: "Bash",
    tool_input: {
      command: "mock command"
    }
  });

  return run("node", [POST_TOOL_USE_SCRIPT], {
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

  const postToolUseResult = runPostToolUse(repo, dataDir);
  assert(postToolUseResult.status === 0, "PostToolUse tracker run should exit 0");
  assert(fs.existsSync(path.join(dataDir, "sessions", "test-session.json")), "PostToolUse should write a session tracker file");

  const notebookResult = runNotebookToolUse(repo, dataDir);
  assert(notebookResult.status === 0, "NotebookEdit tracker run should exit 0");

  const bashResult = runBashToolUse(repo, dataDir);
  assert(bashResult.status === 0, "Bash tracker run should exit 0");

  const dryRunResult = runHook(repo, {
    ...envBase,
    CODEX_HANDOFF_REVIEW_DRY_RUN: "1",
    CODEX_HANDOFF_REVIEW_CODEX_ARGS: JSON.stringify([mockCodex, "ALLOW: mocked review passed"])
  });
  assert(dryRunResult.status === 0, "dry run should exit 0");
  assert(dryRunResult.stdout.includes('"hasBaseline": true'), "dry run should detect the SessionStart baseline");
  assert(dryRunResult.stdout.includes('"hasToolTracker": true'), "dry run should detect the PostToolUse tracker");
  assert(dryRunResult.stdout.includes('"feature.txt"'), "dry run should include changed files");

  const allowResult = runHook(repo, {
    ...envBase,
    CODEX_HANDOFF_REVIEW_CODEX_ARGS: JSON.stringify([mockCodex, "ALLOW: mocked review passed"])
  });
  assert(allowResult.status === 0, "ALLOW run should exit 0");
  assert(!allowResult.stdout.includes('"decision":"block"'), "ALLOW run should not block");
  assert(fs.existsSync(path.join(dataDir, "latest-review.md")), "ALLOW run should write latest review output");
  assert(fs.existsSync(path.join(dataDir, "latest-review.json")), "ALLOW run should write latest review metadata");

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

  const workspace = path.join(tempRoot, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const changedChildRepo = createRepo(workspace, "changed-child", true);
  createRepo(workspace, "clean-child", false);
  const multiRepoDryRun = runHook(workspace, {
    ...envBase,
    CODEX_HANDOFF_REVIEW_DRY_RUN: "1",
    CODEX_HANDOFF_REVIEW_CODEX_ARGS: JSON.stringify([mockCodex, "ALLOW: mocked review passed"])
  });
  assert(multiRepoDryRun.status === 0, "multi-repo dry run should exit 0");
  assert(multiRepoDryRun.stdout.includes('"reviewRepos"'), "multi-repo dry run should list review repositories");
  assert(multiRepoDryRun.stdout.includes("changed-child"), "multi-repo dry run should include the dirty child repo");
  assert(!multiRepoDryRun.stdout.includes("clean-child"), "multi-repo dry run should skip clean child repos");

  const multiRepoAllow = runHook(workspace, {
    ...envBase,
    CODEX_HANDOFF_REVIEW_CODEX_ARGS: JSON.stringify([mockCodex, "ALLOW: mocked review passed"])
  });
  assert(multiRepoAllow.status === 0, "multi-repo ALLOW run should exit 0");
  const multiRepoOutput = fs.readFileSync(path.join(dataDir, "latest-review.md"), "utf8");
  assert(multiRepoOutput.includes("Repository:") && multiRepoOutput.includes("changed-child"), "multi-repo ALLOW run should write an aggregate review");

  const secretResult = runHook(repo, {
    ...envBase,
    LAST_ASSISTANT_MESSAGE: "password = \"super-secret-value\""
  });
  assert(secretResult.status === 0, "secret scan run should exit 0");
  assert(secretResult.stdout.includes('"decision":"block"'), "secret scan should block before Codex runs");
  assert(secretResult.stdout.includes("possible secrets"), "secret scan should explain the block");

  fs.writeFileSync(path.join(repo, "secret.txt"), "api_key = \"super-secret-value\"\n", "utf8");
  const diffSecretResult = runHook(repo, envBase);
  assert(diffSecretResult.status === 0, "diff secret scan run should exit 0");
  assert(diffSecretResult.stdout.includes('"decision":"block"'), "diff secret scan should block before Codex runs");

  const cleanRepo = createCleanRepo(tempRoot);
  const cleanResult = runHook(cleanRepo, envBase);
  assert(cleanResult.status === 0, "clean repo run should exit 0");
  assert(cleanResult.stdout.trim() === "", "clean repo run should not emit a hook decision");

  const mismatchedBaselineDir = path.join(tempRoot, "mismatch-data");
  fs.mkdirSync(path.join(mismatchedBaselineDir, "baselines"), { recursive: true });
  fs.writeFileSync(path.join(mismatchedBaselineDir, "baselines", "test-session.json"), JSON.stringify({
    sessionId: "test-session",
    cwd: path.join(tempRoot, "other-repo"),
    capturedAt: new Date().toISOString()
  }), "utf8");
  const mismatchedBaseline = runHook(repo, {
    ...envBase,
    CLAUDE_PLUGIN_DATA: mismatchedBaselineDir,
    CODEX_HANDOFF_REVIEW_DRY_RUN: "1"
  });
  assert(mismatchedBaseline.status === 0, "mismatched baseline dry run should exit 0");
  assert(mismatchedBaseline.stdout.includes('"hasBaseline": false'), "mismatched baseline should be ignored");

  console.log("hook smoke tests passed");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
