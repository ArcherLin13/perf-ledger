import { defineTool } from "@grok/agent-sdk/tools";
import * as z from "zod/v4";
import { runLedger } from "../lib/ledger.js";

export default defineTool({
  description:
    "Run one shape-template instance from the benchmark template library and time it at the given size (default 1920x1080). Shapes: lut <entries>, arith <ops>, halo <radius>, launch <count>. Writes a new accepted or rejected record. Does not write prices.",
  inputSchema: z.object({
    shape: z.enum(["lut", "arith", "halo", "launch"]),
    n: z.number().int().positive(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    catalog: z.string().min(1).optional(),
    force: z.boolean().optional(),
    backend: z.string().min(1).optional().describe("Backend id recorded as provenance (default opencl)."),
    project: z.string().min(1).optional().describe("Project name recorded as provenance (default template)."),
  }),
  effect: "write",
  dryRunResult: ({ shape, n }) => ({ ok: false, skipped: true, reason: "dry-run", shape, n }),
  async execute({ shape, n, width, height, catalog, force, backend, project }, ctx) {
    if (ctx.session.purpose === "eval") return { ok: false, skipped: true, reason: "eval", shape, n };
    const args = ["run-template", "--shape", shape, "--n", String(n)];
    if (width !== undefined) args.push("--width", String(width));
    if (height !== undefined) args.push("--height", String(height));
    if (catalog) args.push("--catalog", catalog);
    if (force) args.push("--force", "true");
    if (backend) args.push("--backend", backend);
    if (project) args.push("--project", project);
    return runLedger(args);
  },
});
