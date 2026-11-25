# perf-ledger

这个目录是性能账本和调用它的 agent。扫描、探针、单价、估价、核对都在 `expert/cli.js`。agent 只引用工具打印的 JSON，不自己重算毫秒或 GB/s。

darktable 的模块源码留在 `D:/WorkStation/PerfRepo/upstream/darktable/src/iop`。账本、探针、目录和 agent 都在本目录。

## 目录

| 路径 | 内容 |
| --- | --- |
| `bot/agent.ts` | agent。模型是 grok-4.7 |
| `bot/instructions.md` | agent 每次都要遵守的步骤 |
| `bot/skills/ledger-rules.md` | 引用数字、拒绝模块、两套时钟的规则 |
| `bot/tools/` | agent 调用的工具，内部都是 `node expert/cli.js` |
| `expert/cli.js` | 命令行。`expert/package.json` 把这一层标成 CommonJS |
| `expert/bringup.cjs` | `discover`、`run-probe`、`commit-prices`、`plan-split` |
| `expert/perfexpert.sqlite` | 单价、模块价、核对记录 |
| `probes/` | CPU、OpenCL、Ascend NPU、Ascend AIV 的探针源码 |
| `records/hardware/` | 每次探针一个新文件，不覆盖旧文件 |
| `records/darktable/` | 已测过的 darktable 墙上时间 |
| `catalog/darktable.json` | 已测完、可以对保留集核对的目录 |
| `catalog/darktable-unmeasured.json` | 只从源码划出的目录，没有记录，不能拿去核对准确率 |
| `catalog/tiny.json` | `examples/tiny-iop` 的未测量划分 |

## 启动 agent

在本目录执行：

```bash
npx @grok/agent-sdk login
npx @grok/agent-sdk dev --dir .
```

`login` 之前，模型回合会因缺少 Cursor 凭据失败。`validate`、`discover`、`run-probe` 不需要登录。

playground 地址由 `dev` 打印。账本网页：

```bash
node expert/cli.js view
```

打开 http://127.0.0.1:8765 。这是整份 sqlite，包含平台单价和历史核对，不只是训练集。

agent 工具和命令的对应关系：

| 工具 | 命令 |
| --- | --- |
| `discover_platform` | `discover` |
| `run_probe` | `run-probe --backend <id>` |
| `commit_prices` | `commit-prices --record <file> --platform <id>` |
| `plan_split` | `plan-split --src <dir> --out <file>` |
| `scan_iop` | `scan-iop --src <dir>` |
| `min_ledger` | `min-ledger --catalog <file>` |
| `estimate_cost` | `estimate-wall` 或 `estimate` |
| `anchor_check` | `anchor` 或 `check` |

写操作在 eval 会话里直接跳过，不跑探针，也不写单价。

## 一台新机器

按这个顺序做。缺 SDK 或设备时停在 blocked，不要编一个 GB/s。

### 1. 发现后端

```bash
node expert/cli.js discover
```

输出里每个后端有 `present`、`missing`、`compiler`、`evidence`。

| id | 什么时候算在 | 探针 | 能写入的单价 |
| --- | --- | --- | --- |
| `cpu` | 本机永远在；没有 gcc 则 `missing` 含 `gcc` | `probes/cpu_seq.c` | `sequential_read_dram_GBps`、`sequential_write_dram_GBps`、`sequential_copy_dram_GBps`，外加最小 accepted 读的 `sequential_read_cache_GBps` |
| `opencl` | 找得到 `OpenCL.dll` 或 `libOpenCL.so`，并且找得到 `CL/cl.h` | `probes/opencl_seq.c` | 同上三个 DRAM 单价。主机拷贝不当成设备 DRAM |
| `ascend_npu` | 找得到 `acl.h`（`ASCEND_HOME`、`ASCEND_TOOLKIT_HOME`、`ASCEND_ACL_HOME`，或默认的华为安装目录） | `probes/ascend_npu.c` | 只写 `sequential_copy_dram_GBps`，而且只来自设备到设备的 copy |
| `ascend_aiv` | 找得到 `aclnnop/aclnn_add.h` | `probes/ascend_aiv.c` | 只写 `aiv_elementwise_GBps`。这是向量加，不是 copy |

头文件搜索会看环境变量、`third_party/OpenCL-Headers`，以及 `D:/WorkStation/PerfRepo/upstream/OpenCL-Headers`。

这台机器上，`cpu` 和 `opencl` 的 `missing` 是空的。`ascend_npu` 缺 `acl.h`，`ascend_aiv` 缺 `aclnn_add.h`。

### 2. 跑探针

只跑 `missing` 为空的后端：

```bash
node expert/cli.js run-probe --backend cpu
node expert/cli.js run-probe --backend opencl
node expert/cli.js run-probe --backend ascend_npu
node expert/cli.js run-probe --backend ascend_aiv
```

成功时 `ok` 为 true，`prices_written` 为 false。单价要等下一步。`record` 是新文件，形如 `records/hardware/<时间戳>-<backend>.json`。

失败时 `ok` 为 false，`blocked` 是原因，`prices_written` 为 false。记录里的 `median` 是 null，`status` 是 `blocked`。这种记录不能引用成带宽，也不能拿去 `commit-prices`。

协议写在记录的 `protocol` 里：预热 3 次，正式样本 11 个，每个样本大约 150 ms，单线程并提高进程优先级。样本数不是 11，或者 `stdev/median > 0.08`，该条就是 `rejected_variance`。`rejected_variance` 的中位数不写进结论，也不参与单价。

CPU 探针绑在 core 0，尺寸是 32 KiB、8 MiB、32 MiB、128 MiB。copy 的字节数是读加写，也就是工作集的两倍。计时包住校准好的紧循环，不把时钟放进每次访存。

OpenCL 探针用设备事件，尺寸是 8 MiB 和 128 MiB，选第一个 GPU。copy 同样按读加写计字节。

NPU 探针只做设备上的 D2D copy，尺寸 8 MiB 和 128 MiB。主机到设备的拷贝不测。

AIV 探针做 float 向量加，尺寸 8 MiB 和 128 MiB。碰到的字节是两份读加一份写。头文件签名和本机 CANN 不一致时编译失败，记录是 `compile_failed`，不存速率。

### 3. 写入单价

```bash
node expert/cli.js commit-prices --record records/hardware/<文件>.json --platform <新平台id>
```

`--platform` 用这台机器自己的 id。已有的 `i7-1185g7-1thread` 和 `iris-xe-opencl` 已经有单价；对它们再跑一次会得到 `skipped`，原因是 `price_exists`，`written` 为空。

一条单价要同时满足这些条件才会写入：

- 该 kind 至少有两个 `accepted` 的 GB/s 样本。
- 按 `bytes` 排序后，最大尺寸的中位数严格小于最小尺寸的中位数。最大的不更慢，原因是 `plateau_not_reached`，不写单价。
- 这个平台上还没有同名单价。已有就跳过。覆盖要显式加 `--replace true`，并且只在你确认要替换这一条时使用。
- 数值四舍五入到 1 位小数。
- 写入走 `price-set`。命令结束时 `init_not_called` 为 true。不要在这之后再跑 `init`，`init` 会把占位平台的单价清掉。

CPU 的 cache 单价只在 DRAM 读价已经成立、并且 `sequential_read_cache_GBps` 还不存在时，取最小的 accepted 读。

这台机器已经留下的探针记录：

- `records/hardware/2026-11-25T04-19-52-510Z-cpu.json`
- `records/hardware/2026-11-25T04-20-56-228Z-opencl.json`
- `records/hardware/2026-11-25T04-17-11-933Z-ascend_npu.json`（blocked）
- `records/hardware/2026-11-25T04-17-12-026Z-ascend_aiv.json`（blocked）

前两份对现有平台执行 `commit-prices` 的结果是全部 `price_exists`。账本里的 19.1、13.9、20.1 和 Iris Xe 的 49.9 保持原值。

### 4. 另一种加速器

在 `probes/extra/<id>/` 放 `probe.c` 和 `backend.json`：

```json
{
  "kind": "custom",
  "present_file": "marker.txt",
  "source": "probe.c",
  "headers": "/opt/vendor/include",
  "libs": ["vendor"]
}
```

`present_file` 相对该目录解析。文件不在，`discover` 里这个后端就是缺席，`run-probe` 写 blocked 记录。探针 stdout 必须是 JSON，形状与内置探针相同：`backend`、`probe_set`、`metrics[]`，每个 metric 有 `id`、`kind`、`unit`、`bytes`、`samples`。

`commit-prices` 目前只认识 `cpu`、`opencl`、`ascend_npu`、`ascend_aiv`。额外后端可以留下记录；要进单价表，需要先在 `expert/bringup.cjs` 的 `PRICE_MAP` 里给它指定单价 id。不要把读带宽写进 `aiv_elementwise_GBps`，也不要把 AIV 的向量加写进 `sequential_copy_dram_GBps`。

## 一个新项目

模块源码需要能被扫描器认识：darktable 这种带 `process_cl` 的 iop。划分在测量之前做完。

### 1. 扫描

```bash
node expert/cli.js scan-iop --src <模块目录>
```

每份源码一个决定：

- `module_wall`：`process_cl` 里的 kernel 次数固定，颜色空间是单一的 LAB 或 RGB，halo 记为 0。
- `needs_branch`：有多条路径。默认参数真正走的那条要另数 kernel 数和 halo，并标 `branch_resolved`。文件名不能代替这个计数。扫描器不会自动填 halo。
- `refuse`：没有 `process_cl`、颜色空间不是单一 LAB/RGB、循环体里有 kernel 发射，或者有主机图像拷贝。拒绝项没有毫秒。`host_image_copy` 缺的是 LUT 上传基准。`loop_in_process_cl` 缺的是迭代次数基准。

注释会先去掉。不含 kernel 发射的循环，例如元数据循环或系数循环，不会因此拒绝。

### 2. 划分训练和保留

```bash
node expert/cli.js plan-split --src <模块目录> --out catalog/<项目>.json
```

它只从 `module_wall` 里挑训练行，顺序是：

1. `base`：LAB，1 个 kernel，halo 0
2. `rgb`：RGB，1 个 kernel，halo 0
3. `extra_kernel`：kernel 数大于 1，halo 0
4. `halo`：halo 大于 0

挑不到的列进 `missing_columns`。`needs_branch` 不进训练，也不进保留。`refuse` 写进目录，角色是 `refuse`。stdout 里的 `minimum_measurements` 是这次能填上的训练行数。它不是准确率，也不能当成“测这么多就超过 85%”。

目录里 `measured` 为 false，训练行没有 `record` 和 `metric_id`。在补上 accepted 记录之前，不要对它跑 `min-ledger`。

darktable 源码这次的划分在 `catalog/darktable-unmeasured.json`：训练是 `colorchecker` 和 `agx`，保留是另外 18 个 `module_wall`，`needs_branch` 有 18 个（含 `sharpen`、`soften`、`highpass`、`sigmoid`、`velvia`），拒绝 55 个，缺的列是 `extra_kernel` 和 `halo`。

### 3. 补上分支再测量

halo 和多 kernel 的行要先从源码数清，写回目录，标 `branch_resolved: true`，再测墙上时间。测量用同一套窗口：预热 3、样本 11、约 150 ms、方差门限 0.08。每次运行写新文件。

然后才能：

```bash
node expert/cli.js estimate-wall --platform <平台> --colorspace lab --kernels 1 --halo 0
node expert/cli.js min-ledger --catalog catalog/<项目>.json
```

`estimate-wall` 的输出里引用 `estimate_id`、`report` 和 `report_ms`。`random` 和 `launch` 被拒绝时，回答就是估不了。

`min_ledger` 只在训练集上选公式。它要的是每一条训练点的准确率都至少 0.85 的最小公式。准确率是 `1 - |measured_ms - report_ms| / measured_ms`。训练集拟合本身不是证据。保留集里打印的 `passes_85` 才是证据。看完残差之后，不要把保留模块挪进训练集，也不要按残差去改单价。`rule_needs_review` 表示形状规则要复查，不表示去改数据库里的单价。

`check` 和 `anchor` 只记一次实测对照。它们不改平台单价，也不改模块单价。平台单价只走 `price-set`、`init` 或 `commit-prices`。模块单价只走 `module-set`。

## 已经核对过的 darktable 目录

`catalog/darktable.json` 指向 darktable `20891f6c6fa7be995e5bf9dff9d1ee5062051773` 的 iop 源码。它和上面的未测量划分不是同一份。

训练：

| 模块 | 颜色 | kernel | halo | 记录 |
| --- | --- | --- | --- | --- |
| vibrance | lab | 1 | 0 | `records/darktable/20891f6c-wall-train.json`，`vibrance_2560x1440` |
| exposure | rgb | 1 | 0 | 同文件，`exposure_1920x1080` |
| sharpen | lab | 3 | 5 | 同文件，`sharpen_1920x1080`。默认 radius 2 落到 5，不走 copy 路径 |
| soften | rgb | 4 | 62 | 同文件，`soften_1920x1080`。1920×1080 上默认 size 50 |

保留：`colorcontrast`、`splittoning`（用 `20891f6c-wall-test-splittoning-run2.json`）、`highpass`（halo 47）、`sigmoid`（`20891f6c-module-sigmoid.json`）。`colisa` 和 `bloom` 是拒绝。

墙上时间公式在平台 `iris-xe-opencl` 上，四项是 base、RGB 附加、多出来的 kernel、halo。流式带宽是另一套钟：字节除以该平台的 copy 单价。估计 GPU 流式代价时平台用 `iris-xe-opencl`。不要把 CPU 的 20.1 GB/s 套到 GPU 上，也不要把墙上时间的残差倒回带宽单价。

核对时引用 `min-ledger` 或 `anchor` 当次打印的 `report_ms` 和准确率。`status` 不是 `accepted` 的中位数不写进结论。目录里没有的硬件、类型或编译器，回答是这里没测，并指出要加哪一个探针。
