import { defineTool } from "@grok/agent-sdk/tools";
import * as z from "zod/v4";
import { runLedger } from "../lib/ledger.js";

export default defineTool({
  description:
    "Write platform prices from one probe record via price-set. Uses only accepted medians, and only when the largest size is slower than the smallest. Does not call init and does not replace an existing price.",
  inputSchema: z.object({
    record: z.string().min(1),
    platform: z.string().min(1).describe("New platform id for this machine. Do not reuse iris-xe-opencl or i7-1185g7-1thread unless that record is for that machine."),
  }),
  effect: "write",
  dryRunResult: ({ platform }) => ({ ok: false, skipped: true, reason: "dry-run", platform }),
  async execute({ record, platform }, ctx) {
    if (ctx.session.purpose === "eval") return { ok: false, skipped: true, reason: "eval", platform };
    return runLedger(["commit-prices", "--record", record, "--platform", platform]);
  },
});
