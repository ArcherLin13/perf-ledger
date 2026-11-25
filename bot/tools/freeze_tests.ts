import { defineTool } from "@grok/agent-sdk/tools";
import * as z from "zod/v4";
import { runLedger } from "../lib/ledger.js";

export default defineTool({
  description:
    "Judge and freeze the test set before any fitting. Fails unless every claimed shape has a test (breadth), every claimed shape has at least min-depth tests with different cost signatures (depth), and the claim covers at least min-coverage of the classifiable hot paths. Writes the freeze block into the catalog only when all rules pass. Refuses to refreeze without refreeze=true.",
  inputSchema: z.object({
    catalog: z.string().min(1).describe("Catalog JSON relative to the perf-ledger root."),
    minCoverage: z.number().min(0).max(1).optional().describe("Default 0.8"),
    minDepth: z.number().int().min(1).optional().describe("Default 2"),
    refreeze: z.boolean().optional(),
  }),
  effect: "write",
  dryRunResult: ({ catalog }) => ({ ok: false, skipped: true, reason: "dry-run", catalog }),
  async execute({ catalog, minCoverage, minDepth, refreeze }, ctx) {
    if (ctx.session.purpose === "eval") {
      return { ok: false, skipped: true, reason: "eval", catalog };
    }
    const args = ["freeze-tests", "--catalog", catalog];
    if (minCoverage !== undefined) args.push("--min-coverage", String(minCoverage));
    if (minDepth !== undefined) args.push("--min-depth", String(minDepth));
    if (refreeze) args.push("--refreeze", "true");
    return runLedger(args);
  },
});
