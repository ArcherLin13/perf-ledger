import { defineEval, includes } from "@grok/agent-sdk/evals";

export default defineEval({
  tags: ["smoke"],
  description: "A source scan is answered from scan_iop, without writing an estimate.",
  async test(t) {
    await t.send(
      "Scan the module sources in examples/tiny-iop. Which files can use the wall formula, and which must be refused? Use the scan tool. Do not estimate milliseconds."
    );
    t.succeeded();
    t.calledTool("scan_iop");
    t.notCalledTool("estimate_cost");
    t.notCalledTool("anchor_check");
    t.notCalledTool("min_ledger");
    t.check(t.reply, includes(/gain|repeat|refuse|module_wall/i));
  },
});
