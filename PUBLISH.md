# 发布与上架步骤 / Publishing & listing

这份文档只给维护者看：它不会被 `npm pack` 打进 tarball（`files` 里没有它）。

## 0. 当前状态（2026-11-20）

| 项 | 值 |
| --- | --- |
| npm | `dsh-smart-model-failover@0.2.5` 已发布、`latest` 指向它（0.1.0 仍可安装）；0.2.0 修复了自动续跑消息缺少 `id`/`role` 导致会话日志被判 corrupt 的问题，0.2.3 把插件描述改成不点名其他插件，0.2.4 增加可视化设置面板，0.2.5 让候选先按模型家族（默认 `deepseek`）再按版本（`v4.1` 先于 `v4`）排序，并重做面板样式 |
| 仓库 | https://github.com/success-c/dsh-smart-model-failover（public，topics 含 `dsh-plugin`） |
| 收录 PR | https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/17165（只加 1 个文件 `data/plugins/success-c__dsh-smart-model-failover.yml`） |
| 待过门槛 | 精选列表 CI 要求仓库创建满 1 天；今天刚建库，CI 的 age 项会自动重跑通过，**不需要推空提交** |

下面第 1-5 节保留为完整流程记录，方便以后发新版本或换账号时照做。

两条实际踩过的坑（文档其它地方没写）：

- **npm 现在对发布强制 2FA**：账号 `two-factor auth = disabled` 时，任何 token / 终端命令都会报
  `403 Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages`。
  先在 https://www.npmjs.com/settings/~/profile 开启 Authenticator app，或用带 Bypass 2FA 的 Granular token。
- **新包名首发会先出现 `0.0.0-stage` 占位**（npm 的 staged publishing）。`npm publish` 报成功但
  `npm view <pkg> version` 仍显示 `0.0.0-stage`，等 1-3 分钟真实版本才可见；别在这个窗口里误判发布失败、急着换包名。
- **0.2.5（2026-11-20）**：候选排序改为「同族 + 高版本」——`modelPreference` 默认 `["deepseek"]`，同一厂商内版本更高的模型优先（`deepseek-v4.1` 先于 `deepseek-v4`，`-260425` 这类日期后缀不会被当成版本号）；跨厂商时能出该家族的厂商排在前面。设置面板重做样式：分组卡片、行序号、厂商徽标 + 等宽模型名、拖动高亮与只在悬停时出现的操作按钮。
- **0.2.4（2026-11-20）**：新增 Web 客户端设置面板（`plugins.bundle.config`）——总开关、模型调用顺序（默认展示自动发现顺序，可拖动/新增/删除，新增时下拉列出本 profile 已配置厂商能列出的模型）、厂商优先顺序；新增只读路由 `/smart-model-failover/plan` 向面板提供实时候选，下拉只列已配置厂商的模型，并保留手写输入。
- **0.2.3（2026-11-20）**：插件描述、README 与设置项示例不再出现其他插件/厂商名称；统一表述为「任何插件注册进宿主的 provider 都会自动进入候选池」。
- **0.2.0（2026-11-20）**：自动切换后的续跑消息改为带 `id`（UUID）与 `role: "user"`。宿主把 `agent.followup()`
  的入参原样持久化为 `user/message`，缺这两个字段会让整个会话在重新打开时报
  `lacks an identified message`；旧版已经写坏的会话需要按同字段单独修复。

包名 `dsh-smart-model-failover` 在 npm 上已确认未被占用。npm 上已有的 `dsh-model-failover` 是别人维护的**静态 fallbacks 熔断器**，
两者行为不同：本插件在运行时从 `ctx.llm` 动态发现**所有**已配置 + 外部接入厂商的模型，不依赖手写链。

---

## 1. 发布前：把占位符换成你自己的

`package.json` 里这几处是占位值，**必须**改（`npm publish` 会被 `scripts/preflight.mjs` 拦下，因为 npm 包基本不能撤回）：

| 字段 | 现在 | 改成 |
| --- | --- | --- |
| `author` | `success-c (https://github.com/success-c)` | 你的名字 + 主页 |
| `repository.url` | `git+https://github.com/success-c/dsh-smart-model-failover.git` | 你的真实仓库 |
| `homepage` | 同上 | `https://github.com/<you>/dsh-smart-model-failover#readme` |
| `bugs.url` | 同上 | `.../issues` |

`repository` 不是装饰：插件市场靠它把 npm 包和精选列表里的仓库条目关联起来，写错就关联不上（`npm:` 字段不允许手写进条目）。

## 2. 本地验证

```sh
npm install
npm test          # 38 个测试，应全绿
npm pack --dry-run
```

`npm pack --dry-run` 应看到 10 个文件：`lib/` 5 个、`cordis.patch.yml`、两个 README、`LICENSE`、`package.json`。

真宿主里加载一次（用你本机 profile 的依赖解析，不改任何配置）：

```sh
cd C:/Users/PC/.dsh/profiles/desktop
node --input-type=module -e "import('file:///C:/Users/PC/Desktop/dsh-smart-model-failover/lib/index.js').then(m => console.log(m.name, m.inject, typeof m.Config.toJSON))"
```

期望输出：`smart-model-failover [ 'agents', 'llm' ] function`。最后那个 `function` 就是「设置页会渲染出表单」的证据。

## 3. 建 GitHub 仓库

```sh
cd C:/Users/PC/Desktop/dsh-smart-model-failover
git init && git add . && git commit -m "feat: initial release"
git branch -M main
git remote add origin git@github.com:<you>/dsh-smart-model-failover.git
git push -u origin main
```

两个容易漏、但精选列表的 CI 会查的项：

- 给仓库加 **`dsh-plugin`** topic（GitHub 仓库页右上角 About 里的齿轮）。
- **仓库要存在满 1 天**再提收录 PR，这条是 CI 自动检查的；刚建几分钟就提会被挡回，几小时后再提即可。

## 4. 发 npm 包（可选，但强烈建议）

不发 npm 也能收录（从 GitHub 源码装），但发了之后市场能显示下载量，而且预构建安装可以跳过 `allowBuilds` 构建授权。

```sh
npm login          # 需要开启 2FA 的账号
npm publish        # publishConfig.registry 已指向 npmjs，无需再带 --registry
```

token 存在 `~/.npmrc` 的 `//registry.npmjs.org/:_authToken`，只作用于 npmjs；
日常 `npm install` 仍走 npmmirror，两者互不影响。0.2.0 之后 `npm publish` 不再需要 `--registry` 参数。

发布后确认元数据已挂上仓库：

```sh
npm view dsh-smart-model-failover repository.url version
```

## 5. 提收录 PR（这才是「上架插件市场」的真正动作）

市场（dshmarket）里的插件列表**不是**市场仓库自己的数据，它读的是精选列表
[`awesome-dsh-plugin/awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)。
所以不要去改 dshmarket，去那边提 PR。

**一个 PR 只加一个文件**，路径 `data/plugins/<owner>__<repo>.yml`，例如
`data/plugins/alice__dsh-smart-model-failover.yml`：

```yaml
url: https://github.com/alice/dsh-smart-model-failover
name: alice/dsh-smart-model-failover
category: model
description:
  en: Discovers every configured and externally connected provider's models at runtime and switches to the next one when a request fails, then asks the agent to continue the interrupted work.
  zh: 运行时发现所有已配置及外部接入厂商的可用模型，请求失败时自动切到下一个，并让 agent 继续被中断的工作。
```

规则要点（来自该仓库 `contributing.md`）：

- `url` 必须与仓库**完全一致**；`name` 是列表里显示的链接文字（`owner/repo`）。
- 只有 `description.en` 必填，中文写不了可以不写，维护者会补；**描述里含 `: `（冒号+空格）必须加引号**，否则 YAML 解析成嵌套键。
- 分类取 `model`（模型与账号接入）。分类选得不准不会被打回，维护者会直接改。
- 一个 PR 最多 3 条；两个 README 是脚本生成的，**不要手工改**。
- 仓库必须有真实的 `dsh.bundle` 清单（本包已有 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`），只声明 `dsh.client` 会被拒。
- 描述会被对着代码核对，所以别写数字/API 名，除非真的存在。上面这行只描述了实际行为。
- 官方 `@deepseek-ai/*` 依赖用 `peerDependencies`（本包已经是）。
- 可选：`icon:`（GitHub 托管的 png/jpg/webp，方形 ~96px，不写回退作者头像）、仓库根放 `screenshots.json`（1-8 张图，路径相对该文件）。

PR 合并后网站与市场会重新构建，通常一天内生效；`plugins.json` 里的条目出现后，市场搜索即可命中。

## 6. 收录之后怎么装

市场里：**插件 → 发现（Discover）** 搜 `smart model failover`，装完刷新页面即可（不需要重启）。

或命令行（需要本机有 `dsh` CLI）：

```sh
dsh plugin --profile web add dsh-smart-model-failover
```

装好后第一次启动会写一行 `loaded` 到 `~/.dsh/smart-model-failover.log`
（可用环境变量 `SMART_MODEL_FAILOVER_LOG` 改路径）。

## 7. 常见打回原因（提前避开）

| 症状 | 原因 |
| --- | --- |
| CI 报缺 `dsh.bundle` | 只写了 `dsh.client`，或 `dsh.bundle.patch` 路径不是 `./cordis.patch.yml` |
| CI 报仓库太新 | 仓库不满 1 天 |
| **held: author** 标签 | 维护者要你改描述/条目；推到同一分支后**留一条**评论说明改动即可，别反复推送 |
| PR 有冲突 | 几乎都是生成的 README 行冲突，自己别去改 README；等维护者 rebase |

## 8. 撤回

72 小时内可以 `npm unpublish dsh-smart-model-failover --force`；超过 72 小时只能
`npm deprecate dsh-smart-model-failover@0.2.0 "reason"`，已装用户不会被自动卸载。
精选列表的条目可以再提一个 PR 删掉。

---

PR 描述可以参考这一段：

> Adds `dsh-smart-model-failover`, a plugin that switches models on a failed request by querying every configured provider (including providers added by other plugins) at runtime through `ctx.llm.listProviders()` / `listModels()`, instead of requiring a hand-written fallback chain. It delegates first (`await next()` on `agent/request-error`), applies the choice with `agent.model.select()`, lets the failed step end, and resumes on the next idle status. Cooldown, attempt order, provider prioritisation and the master switch are configurable from the plugin settings page.
