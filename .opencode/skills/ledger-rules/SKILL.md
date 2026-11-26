---
name: ledger-rules
description: When to scan, when to refuse, how the minimum ledger is chosen, and which numbers may be quoted.
---

# Ledger rules

Quote only numbers printed by `ledger_discover_platform`, `ledger_run_probe`, `ledger_commit_prices`, `ledger_plan_split`, `ledger_freeze_tests`, `ledger_score`, `ledger_annotate_features`, `ledger_measure_module`, `ledger_run_template`, `ledger_exam_predict`, `ledger_exam_score`, `ledger_scan_iop`, `ledger_min_ledger`, `ledger_estimate_cost`, or `ledger_anchor_check`. Do not recompute milliseconds, prices, or accuracy.

## New platform

- `ledger_discover_platform` reports `cpu`, `opencl`, `ascend_npu`, and `ascend_aiv`. An extra backend is a directory `probes/extra/<id>/` with `backend.json` and `probe.c`.
- `ledger_run_probe` writes a new record. Warmup is 3, samples are 11, each sample lasts about 150 ms, and `stdev/median > 0.08` is `rejected_variance`. A blocked probe has no rate.
- `ledger_commit_prices` calls `price-set` only for an accepted median. It requires two accepted sizes, and the larger size must be slower than the smaller size. Otherwise it skips that price. It does not replace an existing price and it does not call `init`.
- CPU and OpenCL can price read, write, and copy. Ascend NPU prices device-to-device copy only. Ascend AIV prices `aiv_elementwise_GBps` only. Host copies are not device DRAM.
- A machine without the SDK stays blocked. Do not copy `iris-xe-opencl` or `i7-1185g7-1thread` onto that machine.

## New project

- `ledger_plan_split` proposes the first catalog: minimal training modules, a sampled exam (two test entries per shape cell at planned sizes), and `claimed` modules that join the claim from classification alone and need no measurement. The claim is what you classify, not what you measure. `ledger_freeze_tests` is the gate that freezes it: it refuses unless every claimed shape has a test, every claimed shape has at least two tests with different declared cost signatures, and the claim covers at least 80% of the classifiable hot paths. `needs_branch` modules count as classifiable; unresolved ones are uncovered, and the coverage gap names how many more must be resolved (`need_additional_claimed`). Resolve a branch from the printed branch digest, not from reading the whole file.
- `ledger_score` is the verdict. It fails when the catalog is not frozen, coverage is below the bar, any frozen claimed test is unmeasured, or any measured test is below 0.85. An unmeasured claimed test is a failure, not a skip. `measured_test_all_pass_85` from `ledger_min_ledger` is fitting diagnostics, not the verdict.
- `lookup_wide` is 1 when the module's own OpenCL kernel declares an array or macro of size 64 or more. `ledger_annotate_features` writes it. It is another column `ledger_min_ledger` may select.
- Training accuracy is not evidence. A measured test module stays in the test set. An unmeasured module may be measured to fill a training cell the current formula does not separate.
- Follow the `campaign` skill. A failed `ledger_score` verdict starts another round. It does not end the task.

## Two clocks

- A darktable export module line is `module_wall`. Call `ledger_estimate_cost` with its colorspace, kernel count, and halo on platform `iris-xe-opencl`.
- A device-event streaming kernel uses the byte-model `estimate` command, which has no ledger tool; ask before running it over shell, and use the copy price of the same platform. Do not copy the CPU price onto the GPU.
- `random` and `launch` have no price. Say that the cost cannot be estimated.

## Scan decisions

- `module_wall`: kernel launches are fixed and halo is 0. It can use the wall formula.
- `needs_branch`: the source has more than one path. Count the path that the default parameters actually take, set `branch_resolved`, and only then estimate. Do not guess the kernel count from the file name.
- `refuse`: say the cost cannot be estimated, repeat `reason`, and name the missing benchmark. `host_image_copy` needs a LUT-upload benchmark. `loop_in_process_cl` needs an iteration benchmark. Do not force these into the wall formula.

## Minimum ledger

The darktable catalog is `catalog/darktable.json`. Its source tree is `D:/WorkStation/PerfRepo/upstream/darktable/src/iop`.

`ledger_min_ledger` chooses the smallest formula that fits every accepted training point at accuracy 0.85 or higher. The minimum measurement count is the column count of that formula. A smaller set is unusable when the fit is singular. Training accuracy is not evidence. Held-out modules with `passes_85` are the evidence. The reported coefficients are least squares over the whole accepted training pool — the same coefficients the admissibility gate checked. The minimum basis (`minimum_set`, `basis_fit`) stays in the output only as proof of the measurement floor.

When several smallest formulas fit the training pool, the data cannot tell them apart. `ledger_min_ledger` prints them as `tied_formulas` with `confounded_columns`; `ledger_score` fails with `model_ambiguous`. The fix is not to pick one: it is to measure a train module where the confounded columns differ, then fit again. Template rows from `ledger_run_template` are the cheapest separating measurements because each one moves exactly one shape column.

## Template library and graduation exam

- `ledger_run_template` times one synthetic instance (`lut`, `arith`, `halo`, `launch`) at a chosen size and writes a normal record. Template records train the shape vocabulary; they are platform experience like any other accepted record.
- Feature columns include `lut_entries`, `arith_ops`, `pixels`, `mb_moved`, `arith_px` and `arith_px_sq` (ops and ops squared, times megapixels), `halo_px` (kernel-neighborhood radius read from the kernel source) and `halo_px_px`. The minimum search may select any of them.
- `mb_moved` is megabytes of distinct data the run must stream: in, out, and per-pixel table reads, times launch count. Neighbor re-reads inside one launch are cache traffic, not movement — on iris-xe a radius-1..4 halo sweep is flat, and the fit confirms it by pricing `mb_moved` and dropping the raw read count.
- `ledger_exam_predict` seals the report in the audit log before the item is measured. It refuses when the model is ambiguous. There is no un-sealing and no re-sealing of the same exam id. When a sealed feature value lies outside the trained range, the seal carries a `range_note`; an out-of-range seal is a guess and a failed one is the note working, not a surprise.
- `ledger_exam_score` needs the sealed exam id, an accepted record, and the metric id. Accuracy is the same 0.85 line. A failed exam names the missing shape; it is not permission to adjust the sealed number.

## Memory lifecycle

- **Write-time dedup.** `ledger_measure_module`, `ledger_run_template`, and `ledger_run_probe` refuse to write when an equivalent `accepted` record exists: same probe set, same metric id, same catalog sha, same structured dimensions (`width`/`height`/`param`/`bytes` when both sides carry them), median within 3%. A blocked record is written once per blocker reason; repeats are skipped. The output names the kept file as `duplicate_of`. Re-measure on purpose — cross-session validation of a suspicious result — with `force: true`.
- **Version invalidation.** A record measured with `catalog` set is stamped with the catalog's sha. After `ledger_bump_sha` moves the catalog forward, those records are stale: fits exclude them, a frozen test holding one fails with `stale_record`, and the files stay on disk and queryable. Re-measure under the new sha to refresh. Never delete the old ones.
- **Periodic health check.** `ledger_doctor` is read-only and prints a prescription: sha drift against the source HEAD, dangling record pointers, stale records, orphan records, duplicates the gate missed, and platform probes older than 30 days. Run it when a repository or a platform may have moved; act on the prescription yourself.
- **Tiers.** Hot: fitted coefficients and frozen tests. Warm: accepted records the catalogs point at. Cold: every other record plus the audit log. Cold data may be archived (moved to `records/archive/`), never deleted. The audit log is the ledger itself; it is never purged.
- **Trail.** Verdicts and work actions alike (scan, plan, annotate, measure, probe, commit-prices) append to the same audit table with their full inputs and outputs. Replay a campaign from the view's timeline tab or `cli.js audit`, not from git history.

## Known limits learned on iris-xe

- **Instance-level codegen luck.** On 2026-11-25 the gallery exam measured `arith` at 2560x1440 across three sessions: n=20 → 3.18/3.27/3.14 ms, n=30 → 2.94/2.95/2.96 ms. More work runs faster, reproducibly. No smooth feature separates these instances, so a frozen test sitting on such an instance fails at about 0.71–0.79 while the family curve stays right everywhere else. Hygiene: confirm a suspicious measurement across sessions before believing an inversion. Terminal state: name the instance luck in the report; do not add contradictory train rows — that breaks every formula (`train_fit_failed`).
- **Feature alphabets.** `ledger_annotate_features` counts the transcendental alphabet of darktable kernels (no `sqrt`), so a template cycle of six ops extracts five. Inside one catalog the count is proportional and self-consistent; do not compare raw counts across extractors.

Do not add a test module to the training pool after seeing its residual. Do not run `price-set` or `init` from a residual. `rule_needs_review` means the shape rule needs review. It does not authorize a price edit.

## What may be cited

Cite a median only when the record status is `accepted`. `rejected_variance` and `rejected_correctness` stay out of the conclusion.

Accuracy is `1 - |measured_ms - report_ms| / measured_ms`. The pass line is 0.85, taken from `passes_85` or from the same ratio on an anchor's printed milliseconds. The old byte-model anchors for darktable module lines are not the wall-model test set.

`ledger_anchor_check` records a comparison. It does not change platform prices or module prices.
