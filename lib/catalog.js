import { routeLabel, withTimeout } from "./util.js";

/**
 * Live model catalog: every provider the host has registered right now, and
 * every model each adapter can list for it.
 *
 * Discovery is lazy, cached, and failure-tolerant: a provider whose adapter
 * throws or hangs (no credential, offline discovery) simply contributes
 * nothing, it never fails the whole switch.
 */
export function createCatalog(ctx, config, log) {
	const state = { at: 0, routes: [], building: undefined };

	const fresh = () => state.at > 0 && Date.now() - state.at < config.discoverTtlMs;

	async function runDiscovery() {
		let providers = [];
		try {
			providers = ctx.llm?.listProviders?.() ?? [];
		} catch (error) {
			log?.({ kind: "discover-failed", stage: "providers", error: String(error?.message ?? error) });
		}
		const settled = await Promise.allSettled(
			providers.map(async (provider) => {
				try {
					const models = await withTimeout(ctx.llm.listModels(provider.id), config.discoverTimeoutMs);
					if (models === undefined) {
						log?.({ kind: "discover-timeout", provider: provider.id });
						return [];
					}
					if (!Array.isArray(models) || models.length === 0) {
						log?.({ kind: "discover-empty", provider: provider.id });
						return [];
					}
					return models
						.filter((model) => model && typeof model.id === "string" && model.id)
						.map((model) => ({ provider: provider.id, model: model.id, name: model.name ?? model.id }));
				} catch (error) {
					// No credential, offline discovery, a broken adapter: skip this
					// provider only — never fail the whole switch over it.
					log?.({ kind: "discover-failed", provider: provider.id, error: String(error?.message ?? error) });
					return [];
				}
			}),
		);
		const routes = [];
		for (const result of settled) {
			if (result.status === "fulfilled") routes.push(...result.value);
			else log?.({ kind: "discover-failed", stage: "models", error: String(result.reason?.message ?? result.reason) });
		}
		state.routes = routes;
		state.at = Date.now();
		log?.({ kind: "discovered", providers: providers.length, routes: routes.length });
		return routes;
	}

	function discover() {
		if (!state.building) state.building = runDiscovery().finally(() => (state.building = undefined));
		return state.building;
	}

	return {
		/** Drop the cached catalog; the next failure re-discovers. */
		invalidate(reason) {
			state.at = 0;
			log?.({ kind: "cache-invalidated", reason });
		},
		/** Last successful discovery, even when stale. */
		cached() {
			return state.routes;
		},
		/** Fresh routes, discovering on demand. Never rejects. */
		async list() {
			if (fresh()) return state.routes;
			try {
				return await discover();
			} catch (error) {
				log?.({ kind: "discover-failed", stage: "list", error: String(error?.message ?? error) });
				return state.routes;
			}
		},
		/** Fire-and-forget first discovery so the first failure does not pay for it. */
		warm() {
			if (!fresh()) discover().catch(() => undefined);
		},
	};
}

/** Rank a provider's models: earliest `modelPreference` hit first, then discovery order. */
function pickModels(pool, config) {
	return pool
		.map((entry, index) => ({
			entry,
			index,
			rank: config.modelPreference.findIndex((needle) => entry.model.toLowerCase().includes(needle)),
		}))
		.sort((left, right) => (left.rank < 0 ? Infinity : left.rank) - (right.rank < 0 ? Infinity : right.rank) || left.index - right.index)
		.map((item) => item.entry);
}

/**
 * Order the routes a switch may target: an explicit `order` first, then one
 * model per remaining provider (in provider order), so a failed request walks
 * provider by provider instead of hopping between models of the same vendor.
 *
 * Filters first — routes already tried in this episode, cooling down after an
 * earlier failure, excluded by config — then walks:
 *
 *  1. each `order` entry, in the listed order (a bare provider name resolves to
 *     that provider's preferred model)
 *  2. every remaining provider, ordered by `providerPriority` then by the
 *     order the host registered them, contributing exactly one model each
 */
export function rankCandidates(routes, options) {
	const { from, tried = new Set(), isCooling = () => false, order = [], config, now = Date.now() } = options;

	const pools = new Map();
	const discovery = [];
	for (const route of routes) {
		if (!route || !route.provider || !route.model) continue;
		const provider = route.provider;
		if (!pools.has(provider)) {
			pools.set(provider, []);
			discovery.push(provider);
		}
		pools.get(provider).push({ provider, model: String(route.model) });
	}

	const picked = [];
	const labels = new Set();
	const take = (provider, model) => {
		if (!provider || !model) return false;
		const route = { provider, model };
		const label = routeLabel(route);
		if (labels.has(label)) return false;
		if (from && label === routeLabel(from)) return false;
		if (tried.has(label)) return false;
		if (isCooling(label, now)) return false;
		if (config.excludeProviders.includes(provider)) return false;
		const lower = model.toLowerCase();
		if (config.excludePatterns.some((pattern) => lower.includes(pattern))) return false;
		labels.add(label);
		picked.push(route);
		return true;
	};

	// Providers that already had their one slot this episode: everything already
	// tried, plus the vendor that just failed.
	const attempted = new Set();
	for (const label of tried) {
		const cut = label.indexOf("/");
		if (cut > 0) attempted.add(label.slice(0, cut));
	}
	if (from?.provider) attempted.add(from.provider);

	// 1. Explicit attempt order wins, entry by entry.
	for (const entry of order) {
		if (!entry || !entry.provider) continue;
		attempted.add(entry.provider);
		if (entry.model) take(entry.provider, entry.model);
		else {
			const pool = pools.get(entry.provider);
			if (pool?.length) take(entry.provider, pickModels(pool, config)[0].model);
		}
	}

	// 2. Then one model for each provider not already used in this episode, in
	// provider order: a vendor that just failed is left alone until the next turn.
	const priority = new Map(config.providerPriority.map((provider, index) => [provider, index]));
	const rankOf = (provider) => (priority.has(provider) ? priority.get(provider) : Number.MAX_SAFE_INTEGER);
	const indexOf = new Map(discovery.map((provider, index) => [provider, index]));
	const ordered = [...discovery].sort((left, right) => rankOf(left) - rankOf(right) || indexOf.get(left) - indexOf.get(right));
	for (const provider of ordered) {
		if (attempted.has(provider)) continue;
		// One model per provider: the first usable one wins. A filtered model
		// (cooling, already tried) does not use up the provider's slot.
		for (const entry of pickModels(pools.get(provider), config)) {
			if (take(provider, entry.model)) break;
		}
	}

	return picked;
}
