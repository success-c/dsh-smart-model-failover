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
				const models = await withTimeout(ctx.llm.listModels(provider.id), config.discoverTimeoutMs);
				if (!Array.isArray(models) || models.length === 0) {
					log?.({ kind: "discover-empty", provider: provider.id });
					return [];
				}
				return models
					.filter((model) => model && typeof model.id === "string" && model.id)
					.map((model) => ({ provider: provider.id, model: model.id, name: model.name ?? model.id }));
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

function compareKeys(left, right) {
	for (let index = 0; index < left.length; index += 1) {
		if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
	}
	return 0;
}

/**
 * Order the routes a switch may target. Filters first (already tried in this
 * episode, cooling down after an earlier failure, excluded by config), then
 * sorts by:
 *
 *  1. position in the configured `chain` (explicit user preference wins)
 *  2. a different provider than the one that just failed (that provider is suspect)
 *  3. the same model id as the one that failed (least behavioural change)
 *  4. position in `providerPriority`
 *  5. which `modelPreference` substring the model matched, earliest first
 *  6. discovery order
 */
export function rankCandidates(routes, options) {
	const { from, failedProvider, tried = new Set(), isCooling = () => false, chain = [], config, now = Date.now() } = options;

	const chainRanks = new Map();
	for (let index = 0; index < chain.length; index += 1) {
		const label = routeLabel(chain[index]);
		if (!chainRanks.has(label)) chainRanks.set(label, index);
	}
	const providerRanks = new Map(config.providerPriority.map((provider, index) => [provider, index]));

	const merged = [];
	const seen = new Set();
	for (const route of [...chain, ...routes]) {
		if (!route || !route.provider) continue;
		const label = routeLabel(route);
		if (seen.has(label)) continue;
		seen.add(label);
		merged.push(route);
	}

	const scored = [];
	for (const route of merged) {
		const label = routeLabel(route);
		const model = String(route.model ?? "");
		if (!model) continue;
		if (from && label === routeLabel(from)) continue;
		if (tried.has(label)) continue;
		if (isCooling(label, now)) continue;
		if (config.excludeProviders.includes(route.provider)) continue;
		const lower = model.toLowerCase();
		if (config.excludePatterns.some((pattern) => lower.includes(pattern))) continue;
		const preference = config.modelPreference.findIndex((needle) => lower.includes(needle));
		scored.push({
			route,
			keys: [
				chainRanks.has(label) ? chainRanks.get(label) : Infinity,
				failedProvider && route.provider === failedProvider ? 1 : 0,
				config.preferSameModel && from?.model && route.model === from.model ? 0 : 1,
				providerRanks.has(route.provider) ? providerRanks.get(route.provider) : Infinity,
				preference >= 0 ? preference : Infinity,
				scored.length,
			],
		});
	}

	scored.sort((left, right) => compareKeys(left.keys, right.keys));
	return scored.map((entry) => entry.route);
}
