import { existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const compiledAppsDir = join(rootDir, "dist", "apps");

if (existsSync(compiledAppsDir)) {
  rmSync(compiledAppsDir, { recursive: true, force: true });
}
