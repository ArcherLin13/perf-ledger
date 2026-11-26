import { defineTool } from "@grok/agent-sdk/tools";
import * as z from "zod/v4";
import { runLedger } from "../lib/ledger.js";

export default defineTool({
  description:
    "Periodic read-only health check of the experience store: sha drift vs source HEAD, dangling record pointers, stale records, orphan records, duplicates the dedup gate missed, and aging platform probes. Prints a prescription; never changes anything.",
  inputSchema: z.object({
    catalog: z.string().min(1).optional(),
    days: z.number().int().positive().optional(),
  }),
  effect: "read",
  dryRunResult: () => ({ ok: true, skipped: true, reason: "dry-run" }),
  async execute({ catalog, days }, ctx) {
    if (ctx.session.purpose === "eval") return { ok: true, skipped: true, reason: "eval" };
    const args = ["doctor"];
    if (catalog) args.push("--catalog", catalog);
    if (days !== undefined) args.push("--days", String(days));
    return runLedger(args);
  },
});
