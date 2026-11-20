import z from "@deepseek-ai/schemastery";
import { DEFAULTS } from "./util.js";

/**
 * Plugin config. A schemastery schema (not plain JSON) so DSH renders a real
 * settings form for it and `settings.update()` can patch single fields.
 *
 * The schema is wrapped in `.volatile()`: `dsh-settings` only generates controls
 * for volatile fields (`volatileForm()` returns `undefined` for a schema without
 * any, which drops the whole settings page), and a volatile config arrives at
 * `apply()` as `{ get() }` — read through `unwrapConfig()` so edits on the
 * settings page take effect without a restart.
 */
const schema = z.object({
	enabled: z.boolean().default(DEFAULTS.enabled).description("总开关。关闭后插件不接管任何请求失败。"),
	order: z
		.array(z.string())
		.default(DEFAULTS.order)
		.description(
			'尝试调用模型的顺序，形如 "provider/model"，也可只写厂商名（如 "workbuddy1"）表示用该厂商排在最前的模型。' +
				"列出的按顺序先试；留空则按工作区已启用的厂商顺序，每个厂商只试一个模型，失败就换下一个厂商。",
		),
	providerPriority: z
		.array(z.string())
		.default(DEFAULTS.providerPriority)
		.description("厂商优先顺序（如 huoshan、workbuddy1），排在自动发现顺序之前。"),
	modelPreference: z
		.array(z.string())
		.default(DEFAULTS.modelPreference)
		.description("自动发现时，为每个厂商挑选模型的偏好：优先匹配靠前的模型 id 子串（如 flash、haiku、mini）。"),
	excludeProviders: z.array(z.string()).default(DEFAULTS.excludeProviders).description("永不作为切换目标的厂商。"),
	excludePatterns: z
		.array(z.string())
		.default(DEFAULTS.excludePatterns)
		.description("永不作为切换目标的模型 id 子串（不区分大小写，如 embed、rerank）。"),
	cooldownMs: z.number().min(0).default(DEFAULTS.cooldownMs).description("失败路由的冷却时长（毫秒），冷却期内不会被再次选中。"),
	maxSwitches: z.number().min(0).default(DEFAULTS.maxSwitches).description("单轮最多自动切换次数；0 表示不限（以候选池为上限）。"),
	resume: z.boolean().default(DEFAULTS.resume).description("切换后自动续跑被打断的那一轮。"),
	discoverTtlMs: z.number().min(0).default(DEFAULTS.discoverTtlMs).description("模型目录缓存时长（毫秒）。"),
	discoverTimeoutMs: z.number().min(0).default(DEFAULTS.discoverTimeoutMs).description("单个厂商列举模型的超时（毫秒）。"),
	promptTemplate: z.string().default(DEFAULTS.promptTemplate).description("续跑消息模板，支持 {from}、{to}、{code} 占位符。"),
});
