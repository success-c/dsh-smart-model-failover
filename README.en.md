# dsh-smart-model-failover

> DeepSeek Harness (DSH) plugin: when a model request fails, automatically switch to the next usable model and **re-drive the interrupted turn**.
>
> The candidate pool is not a hard-coded list. It is discovered at runtime from the host: every provider configured in the profile, plus every externally connected provider (WorkBuddy, Trae, Qoder, ...) — and every model each of them can list.

## Why

DSH's built-in `llm-retry` only backs off and retries the *same* route. When a quota runs out, a credential dies, a model is retired, or a whole provider goes down, it exhausts its retries and the work in that turn is lost. A hand-written static list helps for a while, but every new provider or model means editing config — and externally connected models never make it into the list at all.

This plugin asks the host *what can run right now*, walks the providers **in the order the workspace has them**, tries **one model per provider**, switches when that one fails, and continues. Pin the order in settings when you want it fixed.

## Features

- **No list to maintain** — `order` defaults to empty; candidates come from `ctx.llm.listProviders()` + `listModels()`.
- **Covers external connections** — any provider registered by another plugin (e.g. `dsh-workbuddy-trae-qoder-connect`) joins the pool automatically.
- **Provider by provider** — one candidate per provider (chosen by `modelPreference`), then the next vendor when it fails; no retry roulette inside one vendor.
- **No repeated dead ends** — a route that already failed in this turn is never retried; failed routes cool down (10 min for ordinary errors, 24 h for credential/quota/retired-model codes).
- **Two-stage, never fights the host** — calls `await next()` first so `llm-retry` and other owners keep priority.
- **Does not touch session history** — switches are logged to a separate file; the host itself records the route change (`model/selection` + its `[model changed: ...]` notice).
- **Configurable** — master switch, per-turn switch cap, provider/model exclusions, provider priority, cooldowns.

## Install

```bash
# from npm
dsh plugin --profile web add dsh-smart-model-failover

# or straight from GitHub
dsh plugin --profile web add github:<owner>/dsh-smart-model-failover

# desktop profile: replace web with desktop
dsh plugin --profile desktop add dsh-smart-model-failover
```

The plugin ships a bundle patch (`dsh.bundle.patch`), so it mounts itself into the profile; no manual `cordis.patch.yml` edit is needed. Restart DSH afterwards.

## Configuration

All fields have defaults; an empty config means "pure discovery".

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | **Master switch**. Off means the plugin never takes over a failed request; saved settings apply without a restart |
| `order` | `[]` | **Attempt order** (`"provider/model"`, or a bare provider name). Listed entries are tried in that order; empty = the workspace's provider order, one model per provider |
| `providerPriority` | `[]` | Provider order, e.g. `["workbuddy1","huoshan"]`; only affects providers `order` does not name |
| `modelPreference` | `["flash","haiku","mini","lite"]` | Which model to pick per provider during discovery: earliest substring match wins |
| `excludeProviders` | `[]` | Providers never used as a target |
| `excludePatterns` | `["embed","rerank","moderation"]` | Model-id substrings never used as a target (case-insensitive) |
| `cooldownMs` | `600000` | How long a failed route stays parked |
| `maxSwitches` | `3` | Max automatic switches per episode; `0` = unlimited (bounded by the pool) |
| `resume` | `true` | Re-drive the interrupted turn after a switch |
| `discoverTtlMs` | `300000` | Model catalog cache TTL |
| `discoverTimeoutMs` | `3000` | Per-provider model listing timeout |
| `promptTemplate` | see below | Resume message template; `{from}`, `{to}`, `{code}` are substituted |

Default resume message:

```text
[smart-failover] 上一个模型 {from} 请求失败（{code}），已自动切换到 {to}。请从中断处继续刚才未完成的工作，不要重复已经完成的部分。
```

(That is: "the previous model failed, we switched to X — continue from where you stopped, do not repeat finished work".) Set your own wording via `promptTemplate`.

Override any field from the profile's own `cordis.patch.yml`, by row id:

```yaml
- id: smart-model-failover
  config:
    providerPriority: ["workbuddy1", "huoshan", "meng"]
    maxSwitches: 5
    promptTemplate: "[failover] {from} failed ({code}); continuing on {to}. Resume the interrupted work."
```

## How it works

```text
request fails
   └─ agent/request-error
        ├─ await next(): if a downstream owner (llm-retry, ...) wants to retry, defer to it
        ├─ request aborted (signal.aborted) → do nothing
        ├─ code says the request itself is wrong (INVALID_REQUEST, ...) → do not switch
        ├─ mark the failing route as tried + cooling
        ├─ discover candidates live (5 min cache; invalidated by llm/adapters-updated and llm/models-updated)
        ├─ rank and pick one target
        ├─ agent.model.select({ provider, model }), then read current() back to confirm
        └─ return undefined so the host closes this turn → re-drive it with agent.followup() once idle
```

Candidate order:

1. `order` entries, strictly in the listed order (a bare provider name resolves to that provider's `modelPreference` pick)
2. the remaining providers, by `providerPriority` then by registration order (i.e. the workspace's provider order)
3. **exactly one model per provider**: earliest `modelPreference` hit, then discovery order

Skipped: routes already tried this turn, routes cooling down, `excludeProviders`, `excludePatterns`, the route that just failed, and **providers that already failed this turn** (one failure per vendor, then move on).

Cooldown is code-aware: errors that cannot heal by retrying (`AUTH`, `MISSING_CREDENTIAL`, `ACCOUNT_QUOTA`, `ACCOUNT_TOKEN_INVALID`, `UNKNOWN_MODEL`, `MODEL_UNSUPPORTED`, `NO_ADAPTER`, ...) park the route for 24 hours; anything else uses `cooldownMs`.

## Log

`$DSH_HOME/smart-model-failover.log` (`~/.dsh` when `DSH_HOME` is unset), or `SMART_MODEL_FAILOVER_LOG`. JSON lines:

```json
{"kind":"switch","from":"huoshan/deepseek-v4-1-flash-260910","to":"meng/mimo-v2.5","code":"RATE_LIMIT","episode":1,"candidates":6}
{"kind":"resume-sent","to":"meng/mimo-v2.5","code":"RATE_LIMIT"}
```

`kind`: `loaded`, `discovered`, `discover-empty`, `discover-failed`, `cache-invalidated`, `switch`, `resume-sent`, `resume-failed`, `max-switches`, `exhausted`, `select-failed`, `select-not-applied`, `config-updated`, `skip-code`.

## FAQ

**Installed, but it never switched.**
Check the log for `loaded` (absent → the package was not mounted; restart and check `dsh plugin list`). If `loaded` is there but no `switch`, look for `skip-code` / `max-switches` / `exhausted`: usually the host's own retry already recovered the request, or the pool is empty (`discover-empty` means a provider listed no models — typically missing credentials).

**It picked a model I have never heard of.**
Each provider contributes exactly one model: the first one matching `modelPreference`. Pin a concrete model by writing `provider/model` in `order`, or keep only the vendor you want with `excludeProviders` / `providerPriority`.

**Does it fight `llm-retry`?**
No — `await next()` first; it only steps in when nobody else owns recovery.

**Is context lost?**
No. Only the route changes; the session continues, and the host appends its `[model changed: ...]` notice.

## Development

```bash
npm install
npm test        # node --test with a mocked host; no real DSH needed
```

- `lib/index.js` — wiring (events, switching, resume)
- `lib/catalog.js` — discovery and candidate ranking (pure logic)
- `lib/util.js` — parsing, config normalization, error-code policy
- `lib/config.js` — schemastery config (wrapped in `.volatile()`: DSH only renders settings controls for volatile fields, and edits then apply without a restart)

## License

MIT
