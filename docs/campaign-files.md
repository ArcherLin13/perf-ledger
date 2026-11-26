# 战役文件契约

一场战役（campaign）经手的文件，以及每个文件谁在什么时候写什么。机制全貌在
`.opencode/skills/campaign/SKILL.md`；这份文档只回答文件所有权，不重复机制。

## 一条战役的时间线

```
scan-iop → plan-split →（agent 手改 catalog）→ annotate-features
        → measure-module / run-template（若干次）
        → freeze-tests → min-ledger → score
        → [exam-predict → 测量 → exam-score]
        → [bump-sha → 按新 sha 重测]
```

每一步都写 audit 表——工作层和判决层是同一张表。view 的"战役时间线" tab 按
catalog 分组回放整张表。复盘走时间线或 `node expert/cli.js audit`，不要去翻
git 历史拼凑。

## catalog/<项目>.json

战役的账本，所有权分四个阶段：

1. **plan-split 创建**：`project`、`iop_src`、`measured: false`、`modules[]`
   （每行 `id`、`role`、`colorspace`、`kernels`、`halo`、`branch_resolved`，
   test 行另带 `width`/`height`）。这一阶段没有 `sha`。
2. **agent 手工补充**（工具不代写这些字段）：
   - `sha`：被划分源码的提交 sha。带 `--catalog` 的测量把它打进记录；
     `bump-sha` 把它往前推，旧 sha 的记录转 stale。
   - `branch_resolved: true`：`needs_branch` 模块按 `branch_digest` 数清默认
     路径的 `kernels`/`halo` 之后标上。文件名不能代替这个计数。
   - `width`/`height`：计划尺寸不是默认 1920×1080 时补。
   - `record` + `metric_id`：每条 accepted 测量之后回指记录文件和指标 id。
     `min-ledger`、`score`、`exam-*` 只认这对指针。
3. **annotate-features 写**：`lookup_wide`、`lut_entries`、`arith_ops`、
   `halo_px`，从 `--kernels` 目录提取。`mb_moved` 不由工具提取，由 agent 按
   移动语义算好填入（模板战役在 catalog 的 `note` 里记了公式）。
4. **freeze-tests 写**：`freeze` 块（`stamp`、`min_coverage`、`min_depth`、
   `classifiable`、`claimed`、`coverage`、`test_ids`）。冻结之后
   `test_ids` 不再编辑——改了就是另一场考试。同理，plan-split 之后手改
   `role`（比如把 test 挪进 train）会让 freeze 失真，视为重新划分，走
   plan-split 重来。

## records/

- `records/hardware/`：唯一活跃池。`run-probe`、`measure-module`、
  `run-template` 都写这里，一次运行一个文件，时间戳命名，只增不改。写时查重
  （同 probe 集 + 同指标 id + 同 catalog sha + 中位数差 ≤3%）拒绝写盘并返回
  `duplicate_of`；`--force true` 覆盖。blocked 或方差拒收的运行也写文件
  （`status` 标明），它们不是证据。
- `records/darktable/`：darktable 战役的遗留池，`catalog/darktable.json`
  仍指向它。新测量不进这里。
- `records/archive/`：`doctor` 处方里孤儿记录的去处。移动可以，删除不行。

## fixtures/

合成桩仓库，结构固定：

- `fixtures/<name>/iop/`：能被 `scan-iop` 认识的 `.c`（darktable 风格
  `process_cl` 签名）。
- `fixtures/<name>/kernels/`：可选；`annotate-features --kernels` 指这里。
  template 夹具没有 kernels 目录——它的实例由 `template_pipe` 直接生成。

## expert/perfexpert.sqlite

跟踪进 git 的账本数据库，两个分支共用路径、各自演化：

- 切分支前先提交或还原它，否则 checkout 被脏文件挡住。
- 二进制不能合并。两边都有对方没有的审计行时，以一侧为准整体 checkout；
  另一侧的事实切过去查，或者把命令重跑一遍——命令是幂等可重放的。

## audit 表（两层流水）

- **判决层**：`init`、`estimate`、`anchor`、`platform_price`、`module_price`、
  `scenario_check`、`launch_fit`、`wall_fit`、`min_ledger`、`freeze_tests`、
  `score`、`exam_predict`、`exam_score`、`bump_sha`。
- **工作层**（2026-11-26 起）：`scan_iop`、`plan_split`、`annotate_features`、
  `measure_module`、`run_template`、`run_probe`、`commit_prices`。
- 只读不写的：`discover`、`doctor`、`view`、`audit`、`ledger`、`prices`、
  `shapes`、`anchors`、`accuracy`。
- 每行 `detail` 是该次动作的完整输入输出 JSON。带 catalog 的判决从
  2026-11-25 起还记 `catalog_sha`（audit 134 起）。

## view

`node expert/cli.js view` 起只读页面。八个 tab：战役时间线（按 catalog 分组的
audit 回放）、平台单价、模块单价、场景核对、形状、估算、锚点、审计（全表）。
搜索框一次过滤所有 tab，按 `/` 聚焦。代码在进程启动时载入、数据每请求现读：
改数据不用重启，改 `view.js` 要重启。
