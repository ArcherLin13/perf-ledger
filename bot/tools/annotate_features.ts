import { defineTool } from "@grok/agent-sdk/tools";
import * as z from "zod/v4";
import { runLedger } from "../lib/ledger.js";

export default defineTool({
  description:
    "Extract quantitative features from each module's own OpenCL kernel: lut_entries (largest array or macro size), arith_ops (transcendental call count), halo_px (largest constant pixel offset in image reads), and the derived lookup_wide flag (entries >= 64). Writes the fields onto the catalog. Does not measure and does not change train or test roles.",
  inputSchema: z.object({
    catalog: z.string().min(1),
    kernels: z.string().min(1),
  }),
  effect: "write",
  dryRunResult: ({ catalog }) => ({ ok: false, skipped: true, reason: "dry-run", catalog }),
  async execute({ catalog, kernels }, ctx) {
    if (ctx.session.purpose === "eval") return { ok: false, skipped: true, reason: "eval", catalog };
    return runLedger(["annotate-features", "--catalog", catalog, "--kernels", kernels]);
  },
});
