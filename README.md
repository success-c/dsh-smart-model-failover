# dsh-smart-model-failover

> DeepSeek Harness（DSH）插件：模型请求失败时，**自动切换到下一个可用模型并续跑被打断的那一轮**。
>
> 候选池不是写死的一份名单，而是运行时从宿主发现的「本 profile 里所有已配置厂商 + 所有外部接入（WorkBuddy / Trae / Qoder 等）」的全部模型。

## 为什么需要

DSH 自带的 `llm-retry` 只会对同一路由做退避重试：额度耗尽、密钥失效、模型下线、厂商整段不可用时，它重试到上限就结束，整轮工作白做。手写一份静态名单能救一时，但每接一个厂商、每换一个模型都要改配置，外部接入的模型更是永远进不了名单。

这个插件不再维护任何名单：它按**工作区当前可用的厂商顺序**逐个尝试，**每个厂商只试一个模型**，一家不行就换下一家。想固定顺序时，在设置页的「尝试调用模型的顺序」里写几行即可。

这个插件的做法是：**把「还有哪些模型能跑」交给宿主回答**，失败时用实时目录挑下一个，切完接着干。

## 特性

- **零名单**：`order` 默认留空，候选完全来自 `ctx.llm.listProviders()` + `listModels()`。
- **覆盖外部接入**：任何插件（如 `dsh-workbuddy-trae-qoder-connect`）注册进宿主的 provider 都会自动进入候选池。
- **逐个厂商**：每个厂商只出一个候选（按 `modelPreference` 挑模型），失败就换下一家，不在一家厂商多点乱撞。
- **不重复踩坑**：同一轮里失败过的路由不再尝试；失败路由按错误类型冷却（普通错误 10 分钟，密钥/额度/模型下线类 24 小时）。
- **两个阶段，不抢主机的活**：先 `await next()` 让 `llm-retry` 等下游先决定；它们不接管时才自己做故障转移。
- **不污染会话**：切换记录只写独立日志文件。路由变化本身由宿主记入 `model/selection` 并显示 `[model changed: ...]` 提示。
- **可关、可限、可调**：总开关、单轮切换上限、厂商/模型排除、优先厂商、冷却时长全部是配置项，DSH 设置页可直接改。

## 安装

```bash
# npm 包
dsh plugin --profile web add dsh-smart-model-failover

# 或直接从 GitHub
dsh plugin --profile web add github:<owner>/dsh-smart-model-failover

# 桌面端 profile 同理，把 web 换成 desktop
dsh plugin --profile desktop add dsh-smart-model-failover
```

也可以在 DSH 的插件市场里搜索 `dsh-smart-model-failover` 一键安装。

安装后**重启 DSH**。插件作为 bundle 层自动挂进 profile（`dsh.bundle.patch`），无需手工改 `cordis.patch.yml`。

## 配置

全部字段都有默认值，留空即「纯自动发现」。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | **总开关**。关掉后完全不接管请求失败；保存设置即生效，不需要重启 |
| `order` | `[]` | **尝试调用模型的顺序**，`"provider/model"` 或只写厂商名。列出的按顺序先试；留空 = 按工作区已启用厂商的顺序，每个厂商只试一个模型 |
| `providerPriority` | `[]` | 厂商优先顺序，如 `["workbuddy1","huoshan"]`；只影响 `order` 没点名的厂商 |
| `modelPreference` | `["flash","haiku","mini","lite"]` | 自动发现时，为每个厂商挑哪个模型：优先匹配靠前的子串 |
| `excludeProviders` | `[]` | 永不作为切换目标的厂商 |
| `excludePatterns` | `["embed","rerank","moderation"]` | 永不作为切换目标的模型 id 子串（不区分大小写） |
| `cooldownMs` | `600000` | 失败路由冷却时长（毫秒） |
| `maxSwitches` | `3` | 单轮最多自动切换次数；`0` = 不限（以候选池为上限） |
| `resume` | `true` | 切换后是否自动续跑被打断的那一轮 |
| `discoverTtlMs` | `300000` | 模型目录缓存时长（毫秒） |
| `discoverTimeoutMs` | `3000` | 单个厂商列举模型的超时（毫秒） |
| `promptTemplate` | 见下 | 续跑消息模板，支持 `{from}` `{to}` `{code}` |

默认续跑文案：

```text
[smart-failover] 上一个模型 {from} 请求失败（{code}），已自动切换到 {to}。请从中断处继续刚才未完成的工作，不要重复已经完成的部分。
```

在 profile 自己的 `cordis.patch.yml` 里按 id 覆盖（后写覆盖先写）：

```yaml
- id: smart-model-failover
  config:
    providerPriority: ["workbuddy1", "huoshan", "meng"]
    maxSwitches: 5
    excludePatterns: ["embed", "rerank", "moderation", "vision"]
```

## 工作方式

```text
模型请求失败
   └─ agent/request-error
        ├─ 先 await next()：llm-retry 等下游要重试就让位，不接管才继续
        ├─ 请求已取消（signal.aborted）→ 什么都不做
        ├─ 错误码属于「请求本身有问题」（INVALID_REQUEST 等）→ 不切换
        ├─ 当前路由加入本轮的 tried 集合 + 冷却表
        ├─ 实时发现候选（缓存 5 分钟；llm/adapters-updated / llm/models-updated 会立即失效缓存）
        ├─ 按下面的顺序挑一个目标
        ├─ agent.model.select({ provider, model }) 并回读 current() 校验生效
        └─ 本轮返回 undefined 交给宿主收尾 → agent 空闲后 agent.followup() 续跑
```

候选顺序（依次走）：

1. `order` 里列出的条目，严格按写的顺序（只写厂商名 → 用该厂商按 `modelPreference` 挑出的那个模型）
2. 其余厂商按 `providerPriority`、再按宿主注册顺序（即工作区里的厂商顺序）
3. **每个厂商只有一个候选模型**：按 `modelPreference` 命中最早者，其次发现顺序

被跳过：本轮已试过的路由、正在冷却的路由、`excludeProviders`、`excludePatterns`、正在失败的那条，以及**本轮已经失败过的厂商**（失败一次就换下一家，不再在同一厂商上换模型重试）。

冷却时长按错误码分档：密钥/额度/模型下线等**重试也不会自愈**的错误码（`AUTH`、`MISSING_CREDENTIAL`、`ACCOUNT_QUOTA`、`ACCOUNT_TOKEN_INVALID`、`UNKNOWN_MODEL`、`MODEL_UNSUPPORTED`、`NO_ADAPTER` 等）冷却 24 小时；其余按 `cooldownMs`。

## 日志

默认 `$DSH_HOME/smart-model-failover.log`（`DSH_HOME` 未设置时为 `~/.dsh`），可用环境变量 `SMART_MODEL_FAILOVER_LOG` 覆盖。JSON lines：

```json
{"kind":"switch","from":"huoshan/deepseek-v4-1-flash-260910","to":"meng/mimo-v2.5","code":"RATE_LIMIT","episode":1,"candidates":6}
{"kind":"resume-sent","to":"meng/mimo-v2.5","code":"RATE_LIMIT"}
```

`kind` 取值：

| kind | 含义 |
| --- | --- |
| `loaded` | 插件已加载 |
| `discovered` / `discover-empty` / `discover-timeout` / `discover-failed` | 发现结果：正常 / 该厂商没有可用模型 / 列举超时 / 列举报错（后三者都带 `provider` 字段，抛错还带 `error`） |
| `cache-invalidated` | 宿主宣布适配器/模型变化，缓存被清 |
| `switch` | 完成一次切换 |
| `resume-sent` / `resume-failed` | 续跑已投递 / 投递失败 |
| `max-switches` | 达到单轮切换上限 |
| `exhausted` | 候选池里没有可用路由了 |
| `select-failed` / `select-not-applied` | 宿主拒绝或未生效，本轮不续跑 |
| `skip-code` | 错误码说明不该切换 |

## 常见问题

**Q：装好了但一次都没切换？**
看日志文件是否出现 `loaded`。没有 → 包没被加载（确认重启、确认 `dsh plugin list` 里能看到）。有 `loaded` 但没有 `switch` → 看 `skip-code` / `max-switches` / `exhausted`：多数情况是失败后宿主自身的重试已经恢复（`llm-retry` 先接管），或候选池为空（`discover-empty` 说明某个厂商没列模型，通常是没配凭据）。

**Q：为什么切到一个我没听过的模型？**
每个厂商只挑一个模型，挑中的是这个厂商里最先命中 `modelPreference` 的模型。想固定到具体模型，就在 `order` 里写 `provider/model`；想只留某个厂商，用 `excludeProviders` 或把 `providerPriority` 只留它。

**Q：会和 `llm-retry` 打架吗？**
不会。插件先 `await next()`，下游返回「我要重试」时直接让位；只有下游不接管才切换。

**Q：会丢上下文吗？**
不会。只换路由，不重开会话；宿主会自动追加 `[model changed: ...]` 提示，插件再投递一条续跑消息。

**Q：如何只看某个厂商？**
`excludeProviders` 列出其余厂商，或 `order` 里只写它，并把 `providerPriority` 只留它。

## 开发

```bash
npm install
npm test        # node --test，纯 mock 宿主，不需要真 DSH
```

- `lib/index.js` 接线（事件、切换、续跑）
- `lib/catalog.js` 发现 + 候选排序（纯逻辑，好测）
- `lib/util.js` 解析/归一化/错误码策略
- `lib/config.js` schemastery 配置（DSH 设置页表单来源）

## License

MIT
