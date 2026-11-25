import { defineTool } from "@grok/agent-sdk/tools";
import * as z from "zod/v4";
import { runLedger } from "../lib/ledger.js";

export default defineTool({
  description:
    "Fit the smallest training ledger that still matches the training pool, then score held-out modules. Quote minimum_measurements, minimum_set, report_ms, and passes_85 from this output only.",
  inputSchema: z.object({
    catalog: z
      .string()
      .min(1)
      .describe("Catalog JSON. The darktable example is catalog/darktable.json, relative to the perf-ledger root."),
  }),
  effect: "write",
  dryRunResult: ({ catalog }) => ({ ok: false, skipped: true, reason: "dry-run", catalog }),
  async execute({ catalog }, ctx) {
    if (ctx.session.purpose === "eval") {
      return { ok: false, skipped: true, reason: "eval", catalog };
    }
    return runLedger(["min-ledger", "--catalog", catalog]);
  },
});
