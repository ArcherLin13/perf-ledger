import { defineTool } from "@grok/agent-sdk/tools";
import * as z from "zod/v4";
import { runLedger } from "../lib/ledger.js";

export default defineTool({
  description:
    "Grade the frozen test set. Verdict is pass only when the catalog is frozen, coverage meets the bar, and every frozen claimed test is measured and has accuracy >= 0.85. An unmeasured claimed test is a failure, not a skip. Quote verdict, failures, and per-test accuracy from this output only.",
  inputSchema: z.object({
    catalog: z.string().min(1).describe("Catalog JSON relative to the perf-ledger root."),
  }),
  effect: "write",
  dryRunResult: ({ catalog }) => ({ ok: false, skipped: true, reason: "dry-run", catalog }),
  async execute({ catalog }, ctx) {
    if (ctx.session.purpose === "eval") {
      return { ok: false, skipped: true, reason: "eval", catalog };
    }
    return runLedger(["score", "--catalog", catalog]);
  },
});
