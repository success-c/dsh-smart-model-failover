import z from "@deepseek-ai/schemastery";
import { DEFAULTS } from "./util.js";

/**
 * Plugin config. A schemastery schema (not plain JSON) so DSH renders a real
 * settings form for it and `settings.update()` can patch single fields.
 */
export const Config = z.object({
	enabled: z.boolean().default(DEFAULTS.enabled).description("总开关。关闭后插件不接管任何请求失败。"),
	chain: z
		.array(z.string())
		.default(DEFAULTS.chain)
		.description('优先路由，形如 "provider/model"。列出的路由总是排在自动发现的模型之前；留空则完全由自动发现决定。'),
	providerPriority: z
		.array(z.string())
		.default(DEFAULTS.providerPriority)
		.description("厂商优先顺序（如 huoshan、workbuddy1），排在自动发现顺序之前。"),
	modelPreference: z
		.array(z.string())
		.default(DEFAULTS.modelPreference)
		.description("换到新厂商时优先挑选的模型 id 子串，按顺序匹配（如 flash、haiku、mini）。"),
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
	preferSameModel: z.boolean().default(DEFAULTS.preferSameModel).description("优先切换到其他厂商上的同款模型，行为变化最小。"),
	promptTemplate: z.string().default(DEFAULTS.promptTemplate).description("续跑消息模板，支持 {from}、{to}、{code} 占位符。"),
});
