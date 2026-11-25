import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export type LedgerResult = {
  ok: boolean;
  exitCode: number;
  result: Json;
  stderr: string;
};

function findProjectRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    const pkgPath = path.join(dir, "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { name?: string };
      if (pkg.name === "perf-ledger") return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("perf-ledger project root was not found from the tool file");
}

export const projectRoot = findProjectRoot(path.dirname(fileURLToPath(import.meta.url)));

export function runLedger(args: string[]): Promise<LedgerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(projectRoot, "expert", "cli.js"), ...args], {
      cwd: projectRoot,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const text = stdout.trim();
      let result: Json = { raw: text };
      if (text) {
        try {
          result = JSON.parse(text) as Json;
        } catch {
          result = { raw: text };
        }
      }
      resolve({ ok: code === 0, exitCode: code ?? 1, result, stderr: stderr.trim() });
    });
  });
}
