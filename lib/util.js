/**
 * Dendency-free helpers shared by the plugin wiring and by the unit tests.
 * Nothing in this file imports a host package, so `node --test` can run it
 * without a DSH profile on disk.
 */

/** Defaults used by the schemastery schema in `config.js` and by `normalizeConfig()`. */
export const DEFAULTS = {
	/** Master switch. */
	enabled: true,
	/** Explicit attempt order, `"provider/model"` (or a bare `"provider"`). Entries win over discovery order. */
	order: [],
	/** Providers to consider before the discovery order, e.g. `["vendorA", "vendorB"]`. */
	providerPriority: [],
	/**
	 * Model-id substrings, in order, that a fallback prefers. `deepseek` keeps
	 * the fallback inside the same model family across vendors; within a family
	 * the newest version wins (`v4.1` before `v4`).
	 */
	modelPreference: ["deepseek"],
	/** Providers never used as a failover target. */
	excludeProviders: [],
	/** Model-id substrings (case-insensitive) that are never used as a failover target. */
	excludePatterns: ["embed", "rerank", "moderation"],
	/**
	 * How long a failed route stays out of the rotation, in ms. Five hours by
	 * default: a route that just failed must not be the first thing every new
	 * turn tries again, which is what a short cooldown used to cause.
	 */
	cooldownMs: 18_000_000,
	/** Hard cap on automatic switches per episode; `0` means "as many as there are candidates". */
	maxSwitches: 3,
	/** Re-drive the interrupted turn after a switch. */
	resume: true,
	/** Model catalog cache TTL, in ms. */
	discoverTtlMs: 300000,
	/** Per-provider discovery timeout, in ms. */
	discoverTimeoutMs: 3000,
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
 * Transient failures: an upstream 502/network blip or a rate limit says
 * "try later", not "this route is broken". They are parked for a short window
 * instead of the normal 5h (or 24h) cooldown.
 */
export const TRANSIENT_COOLDOWN_CODES = new Set([
	"BAD_GATEWAY",
	"HTTP_502",
	"NETWORK",
	"NETWORK_ERROR",
	"NETWORK_FAILURE",
	"PROVIDER_ERROR",
	"RATE_LIMIT",
	"RATE_LIMITED",
	"REQUEST_LIMIT",
	"SERVER_ERROR",
	"SERVER_UNAVAILABLE",
	"TOO_MANY_REQUESTS",
	"UPSTREAM",
	"UPSTREAM_ERROR",
]);

/** 5 minutes: long enough to skip a hot retry loop, short enough to come back. */
export const TRANSIENT_COOLDOWN_MS = 5 * 60 * 1000;

/** True when the failure is a 429/502/network-class blip that deserves only a short park. */
export function isTransientFailure(code, failure) {
	if (TRANSIENT_COOLDOWN_CODES.has(code)) return true;
	const status = Number(failure?.status ?? failure?.statusCode ?? failure?.httpStatus ?? failure?.response?.status);
	if (status === 429 || status === 502) return true;
	const text = [failure?.message, failure?.cause?.message, failure?.detail]
		.filter((item) => typeof item === "string")
		.join(" ");
	return /(?<!\d)502(?!\d)|too many requests|rate[\s-]?limit|请求太多|请求太频繁|请求过于频繁|限流/i.test(text);
}

/** Resolve the cooldown for one failure: transient 5m, permanent 24h, otherwise the configured 5h. */
export function cooldownFor(code, failure, cooldownMs) {
	if (isTransientFailure(code, failure)) return TRANSIENT_COOLDOWN_MS;
	return LONG_COOLDOWN_CODES.has(code) ? Math.max(cooldownMs, LONG_COOLDOWN_MS) : cooldownMs;
}

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

/** `"provider/model"`, or a bare `"provider"` meaning "any model that provider lists". */
export function parseAttempt(spec) {
	if (typeof spec !== "string") return undefined;
	const text = spec.trim();
	if (!text) return undefined;
	const cut = text.indexOf("/");
	if (cut < 0) return { provider: text };
	if (cut === 0 || cut === text.length - 1) return undefined;
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
 * Unwrap a schemastery volatile reference (`.volatile()` configs arrive as
 * `{ get() }`) so the rest of the code only ever sees plain JSON.
 * Duck-typed instead of importing cosmokit: a market plugin must not depend on
 * a package it does not declare.
 */
export function unwrapConfig(input) {
	if (input && typeof input === "object" && typeof input.get === "function") {
		const keys = Object.keys(input);
		if (keys.length === 1 && keys[0] === "get") {
			try {
				return input.get();
			} catch {
				return undefined;
			}
		}
	}
	return input;
}

/**
 * Turn the (already schema-resolved) config into the shape the runtime uses:
 * plain JSON in, plain JSON out, never throws. Unknown keys are ignored, so a
 * hand-edited profile cannot crash the plugin.
 */
export function normalizeConfig(input) {
	const raw = unwrapConfig(input);
	const source = raw && typeof raw === "object" ? raw : {};
	// `chain` is the pre-0.2 name for `order`; keep accepting it so an existing
	// profile config keeps working.
	const rawOrder = Array.isArray(source.order) ? source.order : Array.isArray(source.chain) ? source.chain : DEFAULTS.order;
	const order = rawOrder
		.map((entry) => (typeof entry === "string" ? parseAttempt(entry) : entry))
		.filter((route) => route && typeof route === "object" && typeof route.provider === "string" && route.provider.trim())
		.map((route) => (route.model ? { provider: route.provider.trim(), model: String(route.model).trim() } : { provider: route.provider.trim() }))
		.filter((route) => route.model !== "");
	return {
		enabled: bool(source.enabled, DEFAULTS.enabled),
		order,
		providerPriority: list(source.providerPriority, DEFAULTS.providerPriority),
		modelPreference: list(source.modelPreference, DEFAULTS.modelPreference).map((item) => item.toLowerCase()),
		excludeProviders: list(source.excludeProviders, DEFAULTS.excludeProviders),
		excludePatterns: list(source.excludePatterns, DEFAULTS.excludePatterns).map((item) => item.toLowerCase()),
		cooldownMs: num(source.cooldownMs, DEFAULTS.cooldownMs),
		maxSwitches: Math.floor(num(source.maxSwitches, DEFAULTS.maxSwitches)),
		resume: bool(source.resume, DEFAULTS.resume),
		discoverTtlMs: num(source.discoverTtlMs, DEFAULTS.discoverTtlMs),
		discoverTimeoutMs: num(source.discoverTimeoutMs, DEFAULTS.discoverTimeoutMs),
		promptTemplate: typeof source.promptTemplate === "string" && source.promptTemplate.trim() ? source.promptTemplate : DEFAULTS.promptTemplate,
	};
}

/** Render the resume prompt for one switch. */
export function formatPrompt(template, { from, to, code }) {
	return template.replaceAll("{from}", String(from)).replaceAll("{to}", String(to)).replaceAll("{code}", String(code));
}

/**
 * Resolve to the promise's value, or `undefined` when it takes longer than `ms`.
 * Rejections propagate, so the caller can report which provider failed and why;
 * the timer is always cleared once the race settles.
 */
export function withTimeout(value, ms) {
	let timer;
	const timeout = new Promise((resolve) => {
		timer = setTimeout(() => resolve(undefined), ms);
	});
	return Promise.race([Promise.resolve(value), timeout]).finally(() => clearTimeout(timer));
}
