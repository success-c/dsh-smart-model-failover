/**
 * Dendency-free helpers shared by the plugin wiring and by the unit tests.
 * Nothing in this file imports a host package, so `node --test` can run it
 * without a DSH profile on disk.
 */

/** Defaults used by the schemastery schema in `config.js` and by `normalizeConfig()`. */
export const DEFAULTS = {
	/** Master switch. */
	enabled: true,
	/** Preferred routes, `"provider/model"`. Always considered first, even when discovery has not listed them. */
	chain: [],
	/** Providers to consider before the discovery order, e.g. `["huoshan", "workbuddy1"]`. */
	providerPriority: [],
	/** Preferred model-id substrings, in order, when no cross-provider copy of the failed model exists. */
	modelPreference: ["flash", "haiku", "mini", "lite"],
	/** Providers never used as a failover target. */
	excludeProviders: [],
	/** Model-id substrings (case-insensitive) that are never used as a failover target. */
	excludePatterns: ["embed", "rerank", "moderation"],
	/** How long a failed route stays out of the rotation, in ms. */
	cooldownMs: 600000,
	/** Hard cap on automatic switches per episode; `0` means "as many as there are candidates". */
	maxSwitches: 3,
	/** Re-drive the interrupted turn after a switch. */
	resume: true,
	/** Model catalog cache TTL, in ms. */
	discoverTtlMs: 300000,
	/** Per-provider discovery timeout, in ms. */
	discoverTimeoutMs: 3000,
	/** Prefer the same model id on another provider before any other model. */
	preferSameModel: true,
	/** User message appended after a switch. `{from}`, `{to}` and `{code}` are substituted. */
	promptTemplate:
		"[smart-failover] 上一个模型 {from} 请求失败（{code}），已自动切换到 {to}。请从中断处继续刚才未完成的工作，不要重复已经完成的部分。",
};

/**
 * Codes that will not heal by retrying the same credential/model: keep the
 * failing route parked much longer than an ordinary error.
 */
export const LONG_COOLDOWN_CODES = new Set([
	"AUTH",
	"INVALID_CREDENTIAL",
	"MISSING_CREDENTIAL",
	"ACCOUNT_SIGN_IN_REQUIRED",
	"ACCOUNT_TOKEN_INVALID",
	"ACCOUNT_QUOTA",
	"UNKNOWN_MODEL",
	"MODEL_UNSUPPORTED",
	"NO_ADAPTER",
]);

/** 24h, used for `LONG_COOLDOWN_CODES`. */
export const LONG_COOLDOWN_MS = 86_400_000;

/**
 * Codes where the request itself is wrong (cancelled, malformed, unsupported
 * content), not the route: switching models cannot fix them, so the plugin
 * leaves them to the host.
 */
export const NON_SWITCH_CODES = new Set([
	"ABORTED",
	"CLIENT_UPGRADE_REQUIRED",
	"INVALID_PREPARED_CALL",
	"INVALID_REPLAY_STATE",
	"INVALID_REQUEST",
	"REGISTRATION_DISPOSED",
	"REQUEST_EXTENSION",
	"UNSUPPORTED_CONTENT",
]);

/** `"provider/model"` -> `{ provider, model }`. The model id may itself contain `/`. */
export function parseRoute(spec) {
	if (typeof spec !== "string") return undefined;
	const text = spec.trim();
	const cut = text.indexOf("/");
	if (cut <= 0 || cut === text.length - 1) return undefined;
	return { provider: text.slice(0, cut), model: text.slice(cut + 1) };
}

/** `{ provider, model }` -> `"provider/model"`. */
export function routeLabel(route) {
	if (!route || !route.provider) return "unknown";
	return route.model ? `${route.provider}/${route.model}` : `${route.provider}/?`;
}

function list(value, fallback) {
	return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()) : fallback;
}

function num(value, fallback) {
	const parsed = typeof value === "number" ? value : Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function bool(value, fallback) {
	return typeof value === "boolean" ? value : fallback;
}

/**
 * Turn the (already schema-resolved) config into the shape the runtime uses:
 * plain JSON in, plain JSON out, never throws. Unknown keys are ignored, so a
 * hand-edited profile cannot crash the plugin.
 */
export function normalizeConfig(input) {
	const source = input && typeof input === "object" ? input : {};
	const chain = (Array.isArray(source.chain) ? source.chain : DEFAULTS.chain)
		.map(parseRoute)
		.filter((route) => route !== undefined);
	return {
		enabled: bool(source.enabled, DEFAULTS.enabled),
		chain,
		providerPriority: list(source.providerPriority, DEFAULTS.providerPriority),
		modelPreference: list(source.modelPreference, DEFAULTS.modelPreference).map((item) => item.toLowerCase()),
		excludeProviders: list(source.excludeProviders, DEFAULTS.excludeProviders),
		excludePatterns: list(source.excludePatterns, DEFAULTS.excludePatterns).map((item) => item.toLowerCase()),
		cooldownMs: num(source.cooldownMs, DEFAULTS.cooldownMs),
		maxSwitches: Math.floor(num(source.maxSwitches, DEFAULTS.maxSwitches)),
		resume: bool(source.resume, DEFAULTS.resume),
		discoverTtlMs: num(source.discoverTtlMs, DEFAULTS.discoverTtlMs),
		discoverTimeoutMs: num(source.discoverTimeoutMs, DEFAULTS.discoverTimeoutMs),
		preferSameModel: bool(source.preferSameModel, DEFAULTS.preferSameModel),
		promptTemplate: typeof source.promptTemplate === "string" && source.promptTemplate.trim() ? source.promptTemplate : DEFAULTS.promptTemplate,
	};
}

/** Render the resume prompt for one switch. */
export function formatPrompt(template, { from, to, code }) {
	return template.replaceAll("{from}", String(from)).replaceAll("{to}", String(to)).replaceAll("{code}", String(code));
}

/**
 * Resolve to the promise's value, or `undefined` when it rejects or takes
 * longer than `ms`. Never rejects, never keeps the process alive.
 */
export function withTimeout(value, ms) {
	let timer;
	const timeout = new Promise((resolve) => {
		timer = setTimeout(() => resolve(undefined), ms);
	});
	return Promise.race([Promise.resolve(value).catch(() => undefined), timeout]).finally(() => clearTimeout(timer));
}
