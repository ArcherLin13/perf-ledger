import { defineTool } from "@grok/agent-sdk/tools";
import * as z from "zod/v4";
import { runLedger } from "../lib/ledger.js";

export default defineTool({
  description:
    "Score a sealed graduation exam against an accepted measurement record. Pass requires accuracy >= 0.85, where accuracy = 1 - |measured - report| / measured. The exam must have been sealed by exam_predict before the measurement exists.",
  inputSchema: z.object({
    catalog: z.string().min(1),
    exam: z.number().int().positive(),
    record: z.string().min(1),
    metric: z.string().min(1),
  }),
  effect: "write",
  dryRunResult: ({ exam }) => ({ ok: false, skipped: true, reason: "dry-run", exam }),
  async execute({ catalog, exam, record, metric }, ctx) {
    if (ctx.session.purpose === "eval") return { ok: false, skipped: true, reason: "eval", exam };
    return runLedger([
      "exam-score",
      "--catalog", catalog,
      "--exam", String(exam),
      "--record", record,
      "--metric", metric,
    ]);
  },
});
