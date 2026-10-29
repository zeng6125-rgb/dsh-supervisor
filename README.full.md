# dsh-supervisor 完整文档

> 本文档覆盖配置、API、行为语义与验证方式。快速上手见 [README.md](README.md)。

## 它做什么

主 agent 每干完约 `stepsBetweenReviews` 步（默认 6），supervisor 在后台用**当前会话自己的模型**复查最近的转录增量。只盯七类问题（`src/prompts.ts` 的 `PROBLEM_CATEGORIES` 是唯一来源，审查提示词与 jev 检测门共用同一份清单）：

1. `read_selectively` — 选择性读取（漏读关键文件/行段）
2. `unsaid_finding` — 隐瞒发现（发现问题却不说）
3. `ungrounded_claim` — 无据断言
4. `untried_impossible` — 没试就说做不到
5. `scope_creep` — 悄悄扩范围
6. `blind_tuning` — 盲调参
7. `done_then_changed` — 宣布完工后又改

审查输出为简体中文；`severity` 用英文字面量（`concern` / `blocker`，由代码解析）。

## 审查链

```
step/end × N → delta → ① jev 检测门 → ② LLM 审查 → ③ 解析 + guard → ④ 投递
```

① **jev 检测门**：七类各一条 noul 一次发完（公共工具 `_dsh_external_jev_ask`，只调用不改造），阈值 0.6（活体标定）。命中类别作为**线索**拼进审查提示词（`### Jev pre-screen`，明确「flag 是线索不是结论，须从转录核实」）。门与 LLM 的分歧**双向记账**：`cleared`（门判全清、照审）与 `falseClears`（其中 LLM 出了提醒 = 实测误放）；`flagged`（门命中）与 `confirmed`（其中 LLM 也出提醒）。jev 缺失/失败一律回退纯 LLM。

② **LLM 审查**：严格 JSON frame；第一次解析失败会追加 `UNPARSEABLE_NUDGE` 重试一次。输出契约结尾重复（`CONTRACT_REMINDER`）——弱模型读到长增量尾部会忘掉开头的契约（实测 no_frame 率 48%→10%）。

③ **解析**：容错提取第一个平衡的 `{…}`（容忍散文与 markdown fence）。失败按**最终出口**记账：`no_frame` / `json_error` / `empty_note` / `bad_shape`。

④ **投递（队列 + 附加 + 限流）**：提醒**不注入**进行中的工作（实测 `agent.inject` 的注记会变成该 step 的 user 消息，让 agent 停下只答监管、对话断流）。改为：note 先排队，到 `agent/pre-step` 时才决定何时附加——默认（`intercept` 关）在**比所审轮次更晚的轮次**首个 step 把 note 追加进 `messages` 尾部；`intercept` 开时在下一个 step 即附加。附加时**原样保留 decision 的 `startsRequestSeries`**（不 reject、不重排），请求序列与前缀缓存不被打断。在此之上再加**附加限流**（`attachIntervalSec`，默认 180 秒）：同一会话两次附加之间强制冷却，冷却期内攒下的提醒只排队；到点只附加**最新一条**（监管看的是最新的动作），更旧的 park 到面板（仍可见、可已读，不静默丢）——实测活跃会话曾 22 秒~2 分钟连发，观感就是"连着审查"；设 0 关闭限流，恢复旧的按序全部附加。它只提醒、不授权、不替 agent 做决定。与上一条同级别重复的提醒会被 emission guard 吞掉（`suppressed`）。

## 配置

全部设置在 **设置 → 审查员** 页（`settings.section` 座位），卡片自建读写链路：`GET/POST /config`，服务端经宿主 **configEditor** 落盘并走 Loader 正常路径（`loader/volatile-update` 即时生效）。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；关闭时审查员不调用任何模型 |
| `stepsBetweenReviews` | `6` | 每多少个 step 审查一次；额外成本约 1/N |
| `intercept` | `false` | 开启后提醒在**下一个 step** 即附加；默认（关）只在**更晚轮次**的首个 step 附加，不打断当前轮 |
| `attachIntervalSec` | `180` | 附加限流：同一会话两次附加之间的最小间隔（0 = 关闭）。冷却期内攒下的旧提醒只上面板，到点附加最新一条 |
| `jevGate` | `true` | 审查前先过 jev 检测门 |
| `gateSkipClear` | `false` | 省钱模式：门判全清跳过模型调用（准确性优先，默认关闭以度量误放） |
| `fallbackProvider` / `fallbackModel` | `''` | 回退审查路由；都填才启用 |
| `fallbackAfterErrors` | `3` | 连续多少次 transient 失败后切回退 |
| `reviewProvider` / `reviewModel` | `''` | **审查模型固定**（可选）：都填时所有会话都用它审查，不再跟随会话；默认空 = 跟随各会话自己的模型 |
| `maxDeltaMessages` | `60` | 单次审查的增量消息上限（0 = 不限） |
| `maxNoteChars` | `600` | 提醒正文上限，超长截断 |
| `reviewMaxTokens` | `2048` | 审查调用 maxTokens（推理模型需余量） |

## 失败语义

- `error`：transient 失败，重试一次仍败；**连续 3 次且配置了回退** → 自动切回退路由（warn + 面板显示「回退 p/m」），成功一次或主路由更新即回归；
- 连续 3 次且**没配回退** → 面板亮一条 blocker 级提醒（`channel: 'panel'`，只给用户看不注入 agent），写明死路由与该配的键；同一段失明只报一次，路由恢复后清零；
- `quota` → 会话 parked；`halted` → 永久失败停审；
- `unparseable` → 白跑（见 `parseFails` 归因）。

## API

宿主 webServer 前缀路由，免鉴权：

- `GET /dsh-supervisor/api/state` —— `totals`（`sessions / steps / reviews / notes / unhealthy / outcomes / parseFails / parseFailsByRoute / errorKinds / falseClearsByCat / gate / gateByRoute`）+ 全部提醒 + 各会话计数（`reviewer / steps / reviews / outcomes / gate / pending / route / fallback`）。`outcomes` 总和 == `reviews`；`unparseable` 由 `parseFails` 按最终出口拆分；`gate` 四键见上。后四档 outcome（`unparseable / error / quota / halted`）计入 `unhealthy`。
- `GET /dsh-supervisor/api/config` —— 当前配置值 + `writable` 探测。
- `POST /dsh-supervisor/api/config` —— `{key, value}` 写一个键（白名单 + 类型收敛 → configEditor 落盘）。
- `GET /dsh-supervisor/api/ack[?id=]` —— 标记已读。
- `GET /dsh-supervisor/api/demo[?severity=blocker][&held=1][&note=…]` —— 合成提醒，目视检查用。

## 状态点与面板

- 圆点可拖到**任意位置**（仅受视口边缘约束），位置存 localStorage；badge 显示未读数（`99+` 封顶）；blocker 有呼吸光晕；
- 点开面板：快捷开关（启用 / 下一步附加，写 `/config` 即时生效）、提醒列表（已读淡显）、底部 live 账本（totals + 门账四键 + outcomes 明细）；
- badge 与弹层带 `-webkit-app-region:no-drag`，可安全覆盖顶栏拖拽区。

## 计数落盘

会话计数持久化到 `~/.dsh/dsh-supervisor/state.json`（1.5s 防抖 + teardown flush）；state 以 globalThis 单例存活，热重载不丢账。提醒是内存态（易失），重启后不显示旧横幅。

## 开发

```bash
bash scripts/build.sh            # tsc + tsdown → lib/（junction 依赖，见脚本头）
node --test "tests/*.test.mjs"   # 75 tests；必须带 glob
```

构建后 `dev_reload_package dsh-supervisor`（或重启宿主）生效。

## License

BSD-3-Clause
