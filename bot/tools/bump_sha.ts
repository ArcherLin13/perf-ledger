import { defineTool } from "@grok/agent-sdk/tools";
import * as z from "zod/v4";
import { runLedger } from "../lib/ledger.js";

export default defineTool({
  description:
    "Move a catalog's source sha forward (explicit event, audited). Records stamped with the old sha become stale: excluded from fits and failed in frozen tests until re-measured, but never deleted. Pass 'auto' to read HEAD from the catalog's iop_src git repo.",
  inputSchema: z.object({
    catalog: z.string().min(1),
    sha: z.string().min(1),
  }),
  effect: "write",
  dryRunResult: ({ catalog, sha }) => ({ ok: false, skipped: true, reason: "dry-run", catalog, sha }),
  async execute({ catalog, sha }, ctx) {
    if (ctx.session.purpose === "eval") return { ok: false, skipped: true, reason: "eval", catalog, sha };
    return runLedger(["bump-sha", "--catalog", catalog, "--sha", sha]);
  },
});
