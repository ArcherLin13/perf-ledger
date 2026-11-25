# 老师傅记账

三层分开记。上一层的更新不会改下一层。

| 层 | 谁产生 | 命令 | 过期条件 |
| --- | --- | --- | --- |
| 平台单价 | 微基准 | `price-set`，或改 `prices.json` 后 `init` | 芯片、驱动、内存配置变了 |
| 模块单价 | 场景里单独测一个模块 | `module-set` | 这个模块的实现变了 |
| 场景核对 | 周期跑主要场景 | `check` | 每次场景测试。只记预测和实测的差，不改单价 |

```powershell
node expert/cli.js init
node expert/cli.js price-set --platform i7-1185g7-1thread --id sequential_copy_dram_GBps --value 20.1 --metric copy_32768KiB --source probe.json
node expert/cli.js module-set --module denoise --measured-ms 4 --pixels 2073600 --passes 2 --shape stencil
node expert/cli.js check --scenario preview_1080p30 --predicted-ms 8 --measured-ms 9.2
node expert/cli.js ledger
node expert/cli.js view
```

GPU、NPU、AIV、ISP 在 `init` 后是空平台。有探针之前不能给它们填业务帧里拆出来的数。

三层之外是考试层，命令在 `project_ledger.js`：`scan-iop`、`annotate-features`、`freeze-tests`（入学考闸门）、`score`（判决）、`run-template`（形状模板库）、`exam-predict` / `exam-score`（毕业考封盘与宣判）。考试只读账本和记录，不改单价。

换一个仓库时，拷走整个 `expert/` 目录，不要拷 `perfexpert.sqlite`。改 `config.json` 的 `platform_id` 和 `prices.json` 里的数，再运行 `init`。
