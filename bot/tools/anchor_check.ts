import { defineTool } from "@grok/agent-sdk/tools";
import * as z from "zod/v4";
import { runLedger } from "../lib/ledger.js";

export default defineTool({
  description:
    "Check one existing estimate against a measured millisecond. Pass the estimate_id from estimate_cost and the accepted median. This does not change platform or module prices.",
  inputSchema: z.object({
    estimateId: z.number().int().positive(),
    measuredMs: z.number().positive(),
    record: z.string().min(1).describe("Record file that holds the accepted median."),
  }),
  effect: "write",
  dryRunResult: ({ estimateId }) => ({ ok: false, skipped: true, reason: "dry-run", estimateId }),
  async execute({ estimateId, measuredMs, record }, ctx) {
    if (ctx.session.purpose === "eval") {
      return { ok: false, skipped: true, reason: "eval", estimateId };
    }
    return runLedger([
      "anchor",
      "--estimate",
      String(estimateId),
      "--measured-ms",
      String(measuredMs),
      "--record",
      record,
    ]);
  },
});
