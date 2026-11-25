---
description: When to scan, when to refuse, how the minimum ledger is chosen, and which numbers may be quoted.
---

# Ledger rules

Quote only numbers printed by `discover_platform`, `run_probe`, `commit_prices`, `plan_split`, `scan_iop`, `min_ledger`, `estimate_cost`, or `anchor_check`. Do not recompute milliseconds, prices, or accuracy.

## New platform

- `discover_platform` reports `cpu`, `opencl`, `ascend_npu`, and `ascend_aiv`. An extra backend is a directory `probes/extra/<id>/` with `backend.json` and `probe.c`.
- `run_probe` writes a new record. Warmup is 3, samples are 11, each sample lasts about 150 ms, and `stdev/median > 0.08` is `rejected_variance`. A blocked probe has no rate.
- `commit_prices` calls `price-set` only for an accepted median. It requires two accepted sizes, and the larger size must be slower than the smaller size. Otherwise it skips that price. It does not replace an existing price and it does not call `init`.
- CPU and OpenCL can price read, write, and copy. Ascend NPU prices device-to-device copy only. Ascend AIV prices `aiv_elementwise_GBps` only. Host copies are not device DRAM.
- A machine without the SDK stays blocked. Do not copy `iris-xe-opencl` or `i7-1185g7-1thread` onto that machine.

## New project

- `plan_split` picks train and test from source features before measurement. `needs_branch` modules are in neither set.
- Training accuracy is not evidence. Held-out `passes_85` is the evidence. Do not move a test module into train after seeing its residual.

## Two clocks

- A darktable export module line is `module_wall`. Call `estimate_cost` with `kind: module_wall` on platform `iris-xe-opencl`.
- A device-event streaming kernel is `streaming`. Call `estimate_cost` with `kind: streaming` on platform `iris-xe-opencl`. The copy price on that platform is the one the tool uses. Do not copy the CPU price onto the GPU.
- `random` and `launch` have no price. Say that the cost cannot be estimated.

## Scan decisions

- `module_wall`: kernel launches are fixed and halo is 0. It can use the wall formula.
- `needs_branch`: the source has more than one path. Count the path that the default parameters actually take, set `branch_resolved`, and only then estimate. Do not guess the kernel count from the file name.
- `refuse`: say the cost cannot be estimated, repeat `reason`, and name the missing benchmark. `host_image_copy` needs a LUT-upload benchmark. `loop_in_process_cl` needs an iteration benchmark. Do not force these into the wall formula.

## Minimum ledger

The darktable catalog is `catalog/darktable.json`. Its source tree is `D:/WorkStation/PerfRepo/upstream/darktable/src/iop`.

`min_ledger` chooses the smallest formula that fits every accepted training point at accuracy 0.85 or higher. The minimum measurement count is the column count of that formula. A smaller set is unusable when the fit is singular. Training accuracy is not evidence. Held-out modules with `passes_85` are the evidence.

Do not add a test module to the training pool after seeing its residual. Do not run `price-set` or `init` from a residual. `rule_needs_review` means the shape rule needs review. It does not authorize a price edit.

## What may be cited

Cite a median only when the record status is `accepted`. `rejected_variance` and `rejected_correctness` stay out of the conclusion.

Accuracy is `1 - |measured_ms - report_ms| / measured_ms`. The pass line is 0.85, taken from `passes_85` or from the same ratio on an anchor's printed milliseconds. The old byte-model anchors for darktable module lines are not the wall-model test set.

`anchor_check` records a comparison. It does not change platform prices or module prices.
