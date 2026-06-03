#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

function readStdinJson() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function dataRoot() {
  return process.env.CLAUDE_PLUGIN_DATA || path.join(os.tmpdir(), "codex-handoff-review");
}

function sessionKey(sessionId) {
  return String(sessionId || "default").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function trackerPath(sessionId) {
  return path.join(dataRoot(), "sessions", `${sessionKey(sessionId)}.json`);
}

function toolName(input) {
  return input.tool_name || input.toolName || input.name || input.tool?.name || "";
}

function toolInput(input) {
  return input.tool_input || input.toolInput || input.input || input.tool?.input || {};
}

function filePathFromTool(input) {
  const payload = toolInput(input);
  return payload.file_path || payload.filePath || payload.notebook_path || payload.notebookPath || payload.path || "";
}

function runGit(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 10 * 1024 * 1024
  });
  return result.status === 0 ? result.stdout || "" : "";
}

function gitChangedFiles(cwd) {
  return runGit(cwd, ["status", "--porcelain"])
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ""))
    .filter(Boolean)
    .map((line) => line.slice(3).replace(/^.* -> /, ""))
    .filter(Boolean)
    .map((file) => path.resolve(cwd, file));
}

function readTracker(sessionId) {
  const fullPath = trackerPath(sessionId);
  if (!fs.existsSync(fullPath)) {
    return {
      sessionId,
      createdAt: new Date().toISOString(),
      touchedFiles: [],
      toolEvents: []
    };
  }
  return JSON.parse(fs.readFileSync(fullPath, "utf8"));
}

function main() {
  const hookInput = readStdinJson();
  const sessionId = hookInput.session_id || process.env.CLAUDE_CODE_SESSION_ID || "default";
  const cwd = hookInput.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const filePath = filePathFromTool(hookInput);
  const tool = toolName(hookInput);
  const files = filePath ? [path.resolve(cwd, filePath)] : tool === "Bash" ? gitChangedFiles(cwd) : [];
  if (!files.length) {
    return;
  }

  const tracker = readTracker(sessionId);
  const events = files.map((resolvedPath) => ({
    tool,
    filePath: resolvedPath,
    cwd,
    recordedAt: new Date().toISOString()
  }));

  tracker.updatedAt = events.at(-1).recordedAt;
  tracker.touchedFiles = Array.from(new Set([...(tracker.touchedFiles || []), ...files]));
  tracker.toolEvents = [...(tracker.toolEvents || []), ...events].slice(-200);

  fs.mkdirSync(path.dirname(trackerPath(sessionId)), { recursive: true });
  fs.writeFileSync(trackerPath(sessionId), JSON.stringify(tracker, null, 2), "utf8");
}

try {
  main();
} catch (error) {
  process.stderr.write(`Codex handoff review tool tracking failed: ${error instanceof Error ? error.message : String(error)}\n`);
}
