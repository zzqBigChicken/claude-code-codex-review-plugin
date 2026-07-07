import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_MAX_SCAN_DEPTH = 3;
const DEFAULT_MAX_REPOS = 30;
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "bin",
  "obj",
  ".venv",
  "venv",
  "__pycache__"
]);

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function repoKey(repoPath) {
  const resolved = path.resolve(repoPath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function git(cwd, args) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 10 * 1024 * 1024
  });
}

export function isGitWorkTree(cwd) {
  const result = git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return result.status === 0 && result.stdout.trim() === "true";
}

function gitTopLevel(cwd) {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  return result.status === 0 ? path.resolve(result.stdout.trim()) : "";
}

function hasGitMarker(dir) {
  return fs.existsSync(path.join(dir, ".git"));
}

export function hasGitChanges(cwd) {
  const result = git(cwd, ["status", "--porcelain"]);
  if (result.status !== 0) {
    throw new Error(`Unable to read git status in ${cwd}: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim().length > 0;
}

export function gitChangedFiles(cwd) {
  const result = git(cwd, ["status", "--porcelain"]);
  if (result.status !== 0) {
    return [];
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ""))
    .filter(Boolean)
    .map((line) => line.slice(3).replace(/^.* -> /, ""))
    .filter(Boolean);
}

export function discoverGitWorkTrees(cwd) {
  const root = path.resolve(cwd);
  const maxDepth = envNumber("CODEX_HANDOFF_REVIEW_SCAN_DEPTH", DEFAULT_MAX_SCAN_DEPTH);
  const maxRepos = envNumber("CODEX_HANDOFF_REVIEW_MAX_REPOS", DEFAULT_MAX_REPOS);
  const repos = [];
  const seen = new Set();

  function addRepo(dir) {
    const topLevel = gitTopLevel(dir);
    if (!topLevel) {
      return;
    }
    const key = repoKey(topLevel);
    if (seen.has(key) || repos.length >= maxRepos) {
      return;
    }
    seen.add(key);
    repos.push(topLevel);
  }

  if (isGitWorkTree(root)) {
    addRepo(root);
  }

  function scan(dir, depth) {
    if (depth > maxDepth || repos.length >= maxRepos) {
      return;
    }

    if (hasGitMarker(dir) && isGitWorkTree(dir)) {
      addRepo(dir);
    }

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || SKIP_DIRS.has(entry.name)) {
        continue;
      }
      scan(path.join(dir, entry.name), depth + 1);
      if (repos.length >= maxRepos) {
        return;
      }
    }
  }

  scan(root, 0);
  return repos;
}
