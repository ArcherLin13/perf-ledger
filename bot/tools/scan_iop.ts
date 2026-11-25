import { defineTool } from "@grok/agent-sdk/tools";
import * as z from "zod/v4";
import { runLedger } from "../lib/ledger.js";

export default defineTool({
  description:
    "Scan a pixel-module source directory. Classify each file as module_wall, needs_branch, or refuse. Use this before any millisecond quote.",
  inputSchema: z.object({
    src: z.string().min(1).describe("Directory of module .c files, for example the darktable src/iop tree."),
  }),
  effect: "read",
  async execute({ src }) {
    return runLedger(["scan-iop", "--src", src]);
  },
});
