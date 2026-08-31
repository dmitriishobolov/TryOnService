import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import type { MonolithConfig } from "../../../config.js";

export interface LamodaBrowserLaunchOptions {
  channel?: string;
  executablePath?: string;
}

export function createLamodaBrowserLaunchOptions(config: MonolithConfig): LamodaBrowserLaunchOptions {
  const channel = config.catalog.lamodaBrowserChannel;

  if (channel === "chromium") {
    return {};
  }

  if (channel === "chrome" || channel === "msedge") {
    return { channel };
  }

  if (channel === "opera") {
    return { executablePath: resolveOperaExecutablePath(config.catalog.lamodaBrowserExecutablePath) };
  }

  throw new Error("Unsupported Lamoda browser channel: " + channel);
}

function resolveOperaExecutablePath(configuredPath?: string): string {
  if (configuredPath?.trim()) {
    return resolve(configuredPath.trim());
  }

  const found = defaultOperaExecutableCandidates().find((candidate) => existsSync(candidate));

  if (found) {
    return found;
  }

  throw new Error(
    "Opera executable was not found automatically. Set MONOLITH_CATALOG_LAMODA_BROWSER_EXECUTABLE_PATH or MONOLITH_LAMODA_BROWSER_EXECUTABLE_PATH to opera.exe.",
  );
}

function defaultOperaExecutableCandidates(): string[] {
  const candidates: string[] = [];

  addCandidate(candidates, process.env.LOCALAPPDATA, "Programs", "Opera", "opera.exe");
  addCandidate(candidates, process.env.LOCALAPPDATA, "Programs", "Opera", "launcher.exe");
  addCandidate(candidates, process.env.LOCALAPPDATA, "Programs", "Opera GX", "opera.exe");
  addCandidate(candidates, process.env.LOCALAPPDATA, "Programs", "Opera GX", "launcher.exe");
  addCandidate(candidates, process.env.ProgramFiles, "Opera", "opera.exe");
  addCandidate(candidates, process.env.ProgramFiles, "Opera", "launcher.exe");
  addCandidate(candidates, process.env.ProgramFiles, "Opera GX", "opera.exe");
  addCandidate(candidates, process.env.ProgramFiles, "Opera GX", "launcher.exe");
  addCandidate(candidates, process.env["ProgramFiles(x86)"], "Opera", "opera.exe");
  addCandidate(candidates, process.env["ProgramFiles(x86)"], "Opera", "launcher.exe");
  addCandidate(candidates, process.env.ProgramW6432, "Opera", "opera.exe");
  addCandidate(candidates, process.env.ProgramW6432, "Opera", "launcher.exe");

  if (process.platform === "darwin") {
    candidates.push("/Applications/Opera.app/Contents/MacOS/Opera");
    candidates.push("/Applications/Opera GX.app/Contents/MacOS/Opera");
  }

  if (process.platform === "linux") {
    candidates.push("/usr/bin/opera");
    candidates.push("/usr/bin/opera-stable");
    candidates.push("/snap/bin/opera");
  }

  return [...new Set(candidates)];
}

function addCandidate(target: string[], root: string | undefined, ...parts: string[]): void {
  if (!root) {
    return;
  }

  target.push(join(root, ...parts));
}
