import { defineTool } from "@grok/agent-sdk/tools";
import * as z from "zod/v4";
import { runLedger } from "../lib/ledger.js";

export default defineTool({
  description:
    "Seal a graduation-exam prediction for an item the catalog has never trained on. The prediction is written to the audit log BEFORE any measurement exists; later exam_score compares it with an accepted record. Refuses to seal when the catalog's model is ambiguous. Features is a JSON object string, e.g. '{\"colorspace\":\"lab\",\"kernels\":1,\"halo\":0,\"lookup_wide\":0,\"lut_entries\":0,\"arith_ops\":75,\"width\":1920,\"height\":1080,\"mb_moved\":66.36}'.",
  inputSchema: z.object({
    catalog: z.string().min(1),
    item: z.string().min(1),
    features: z.string().min(2),
  }),
  effect: "write",
  dryRunResult: ({ item }) => ({ ok: false, skipped: true, reason: "dry-run", item }),
  async execute({ catalog, item, features }, ctx) {
    if (ctx.session.purpose === "eval") return { ok: false, skipped: true, reason: "eval", item };
    return runLedger(["exam-predict", "--catalog", catalog, "--item", item, "--features", features]);
  },
});
