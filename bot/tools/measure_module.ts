import { defineTool } from "@grok/agent-sdk/tools";
import * as z from "zod/v4";
import { runLedger } from "../lib/ledger.js";

export default defineTool({
  description:
    "Compile and time one module's OpenCL process_cl at the given size (default 1920x1080). Measure a test entry at its planned size. Writes a new accepted or rejected record. Does not write prices. Modules: colorcontrast, exposure, vibrance, splittoning, aces20, spectral_tone.",
  inputSchema: z.object({
    module: z.string().min(1),
    kernels: z.string().min(1).optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    catalog: z.string().min(1).optional(),
    force: z.boolean().optional(),
    backend: z.string().min(1).optional().describe("Backend id recorded as provenance (default opencl)."),
    project: z.string().min(1).optional().describe("Project name recorded as provenance (default libre-dt-lab)."),
  }),
  effect: "write",
  dryRunResult: ({ module }) => ({ ok: false, skipped: true, reason: "dry-run", module }),
  async execute({ module, kernels, width, height, catalog, force, backend, project }, ctx) {
    if (ctx.session.purpose === "eval") return { ok: false, skipped: true, reason: "eval", module };
    const args = ["measure-module", "--module", module];
    if (kernels) args.push("--kernels", kernels);
    if (width !== undefined) args.push("--width", String(width));
    if (height !== undefined) args.push("--height", String(height));
    if (catalog) args.push("--catalog", catalog);
    if (force) args.push("--force", "true");
    if (backend) args.push("--backend", backend);
    if (project) args.push("--project", project);
    return runLedger(args);
  },
});
