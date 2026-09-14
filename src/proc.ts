/**
 * Shared subprocess primitive for every runtime that shells out.
 * One place owns timeout, stdout/stderr capture, and exit handling so adapters
 * (dsh headless, Claude Code / Codex / Copilot CLIs) stay declarative.
 */

import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

export type RunProcessResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export type RunProcessOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Hard kill after this many ms (default 120s). */
  timeoutMs?: number;
  /** Streamed stdout chunks — lets adapters emit live progress. */
  onStdout?: (chunk: string) => void;
};

/** Run a binary to completion. Never throws on non-zero exit — inspect `code`. */
export function runProcess(
  bin: string,
  args: string[],
  opts: RunProcessOptions = {},
): Promise<RunProcessResult> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout?.on("data", (c) => {
      const text = String(c);
      stdout += text;
      opts.onStdout?.(text);
    });
    child.stderr?.on("data", (c) => {
      stderr += String(c);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

const WINDOWS_EXTS = ["", ".exe", ".cmd", ".bat"];

/**
 * Resolve a binary on PATH without spawning anything (probe stays network- and
 * side-effect-free so `workerRuntimeScaffold` is safe to call from the API).
 */
export function binOnPath(bin: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!bin) return undefined;
  const exts = process.platform === "win32" ? WINDOWS_EXTS : [""];
  const candidates = bin.includes("/") || bin.includes("\\") || isAbsolute(bin)
    ? [bin]
    : (env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, bin));
  for (const candidate of candidates) {
    for (const ext of exts) {
      try {
        accessSync(candidate + ext, constants.X_OK);
        return candidate + ext;
      } catch {
        // keep looking
      }
    }
  }
  return undefined;
}
