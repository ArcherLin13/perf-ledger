---
description: What a performance agent must be able to do on any repository and any platform before it may call a prediction good.
---

# Goal

The repository and the platform are the user's. They can be a PC or a mobile device. Your job is not to tune one repository you already know. Your job is to walk into a repository you have not seen, decide which costs need their own benchmark, measure them on that platform, keep what you learned, and become a master of this platform: when someone brings a feature you have never seen — real code or pseudo code — you price it from your experience and land at 0.85 accuracy or better.

The repository is where you train. The frozen test set is the entrance exam. New features are the graduation exam. The mechanism is what must work the next time.

## 1. Classify the repository yourself

Read the source before you price anything. Split the hot paths into cost shapes: bytes moved, launch overhead, lookup tables or arithmetic intensity, repeated passes, neighborhood width, host-device copies, and data-dependent branches. A shape that will not fit one of those stays outside your claim, and you say so.

Every shape you intend to predict needs its own benchmark for this platform. A benchmark from another platform, or from a different repository that merely looks similar, is not a substitute.

## 2. Measure on the user's platform and keep the experience

Compile and run those benchmarks on the platform the user gave you. Keep only `accepted` samples. A missing compiler, a missing device, or a missing SDK writes no price, and you do not borrow a number from another platform.

Store what you measured as experience, keyed by platform and by shape. Later modules on this platform are estimated from that experience, not re-derived from your prose.

## 3. Freeze a test set that is broad and deep

Freeze the test set before you fit anything. It is the judge of your mechanism, not another way to collect more training rows.

- **Broad.** Every shape you claim to predict has at least one test of that shape. A shape that appears in your experience but has no test is outside the claim.
- **Deep.** Every claimed shape has at least two tests that differ in a cost-driving factor, such as size, repetition count, or intensity. Two tests whose cost features are identical count as one depth, not two.
- **Most of the code.** At least 80% of the classifiable hot paths in the repository fall inside the claim. The rest, and every uncovered path, are listed outside it.
- **Score.** Every measured test inside the claim has accuracy at least 0.85. Training fit is never a pass.

## 4. Close the loop

When the frozen test fails, do not declare the job done. Add the benchmark for the missing shape, count the feature that separates the failing paths from the trained ones, measure the experience on this platform, and score the same frozen test again. A measured test never moves into experience.

When the frozen test is exhausted and the score is still short, the answer is that this repository cannot yet be predicted on this platform. Name the missing shape.

## 5. The concrete loop on this machine

1. `scan_iop` and `plan_split` propose the first catalog: minimal training modules, a sampled exam (two test entries per shape cell at different planned sizes), and `claimed` modules that join the claim from classification alone and need no measurement. The exam budget is printed in measure-module runs. The claim is what you classify, not what you measure.
2. `needs_branch` modules are classifiable. `plan_split` prints a branch digest (each condition with its enqueue counts) so you resolve the default path from the digest, not from reading the whole file. Set `branch_resolved` with a kernel count from source and the module joins the claim. `freeze_tests` names the exact number still missing (`need_additional_claimed`).
3. `annotate_features`, then `measure_module` on training and test modules the probe can compile, each test at its planned size.
4. `freeze_tests` is the gate. It refuses to freeze a claim that lacks breadth (a claimed shape with no test), depth (fewer than two declared cost signatures per claimed shape), or coverage (under 80% of classifiable hot paths). The refusal lists exactly what to add. Do not fit before the freeze exists.
5. `score` is the verdict. It fails when the catalog is not frozen, coverage is under the bar, a frozen claimed test is unmeasured, or a measured test is under 0.85. An unmeasured claimed test is a failure, never a skip.
6. A failed `score` starts another round: measure an unmeasured claimed test, resolve `model_ambiguous` by measuring a train module where the confounded columns differ, count a new separating feature, or add a benchmark on this platform. Re-freeze only with `refreeze: true`, and score the same frozen set again.

## 6. The template library

A catalog of real modules is sparse: most shape columns move together, so the fit cannot tell them apart (`model_ambiguous`). The template library breaks the tie. `run_template` compiles one synthetic instance — `lut <entries>`, `arith <ops>`, `halo <radius>`, or `launch <count>` — and times it at a chosen size on this platform. Sweep one shape at a time and keep every accepted record.

A sweep is also how a naive model gets falsified. On iris-xe the `lut` sweep from 64 to 2048 entries is flat (about 2.1 ms at 1920x1080), so table size is not a cost driver here; the per-pixel table read is, and it belongs in `mb_moved`. The `arith` sweep is superlinear in ops, so the feature is `arith_px_sq` (ops squared times megapixels), not a per-op price. The minimum search finds this only when the template rows are in the training pool.

## 7. The graduation exam

A new feature — real code or pseudo code — is examined under seal.

1. Extract its cost features (colorspace, kernels, halo, `lookup_wide`, `lut_entries`, `arith_ops`, size, `mb_moved`).
2. `exam_predict` seals a report in the audit log before any measurement of that item exists. It refuses to seal when the model is ambiguous; then the answer is more template or train measurements, never a guess.
3. Measure the item once, on this platform.
4. `exam_score` compares the sealed report with the accepted record. Accuracy at least 0.85 is a pass.

A failed exam is an honest verdict, not a bug: the sealed report names the formula, and the gap names the shape the vocabulary is missing. When aces20 was sealed against a template-only experience, the report said 2.22 ms and the measurement said 11.90 ms — the missing shape is per-pixel iteration over its hue tables, which no template instance prices yet. Add that benchmark, then examine the feature again.

Two more honest outcomes the loop can reach:

- **Out-of-range seal.** A coefficient fit over a narrow range is a local correction, not a physical rate. The seal records a `range_note` when a feature value leaves the trained range. Sealed halo 8 against a pool trained on radius 1–4: report 0.93 ms, measured 1.81 ms. The note was the warning; the fail is the note working.
- **Instance luck.** A frozen test can sit on a code-generation fast spot (the gallery arith-at-2560 inversion, confirmed across three sessions). Re-measure before believing an inversion, name the instance luck, and do not stuff the training pool with the contradiction. Nine of ten frozen tests passing with the tenth named is a terminal state, not a failure of nerve.
