import assert from "node:assert/strict";
import test from "node:test";
import { createCatalog, rankCandidates } from "../lib/catalog.js";
import { DEFAULTS, normalizeConfig, parseRoute } from "../lib/util.js";

function cfg(overrides = {}) {
	return normalizeConfig({ ...overrides });
}

const route = (spec) => parseRoute(spec);
const labels = (routes) => routes.map((item) => `${item.provider}/${item.model}`);

test("rankCandidates walks the explicit attempt order first", () => {
	const routes = rankCandidates([route("a/m-flash"), route("b/other")], {
		from: route("z/failed"),
		order: [route("b/pinned-model")],
		config: cfg(),
	});
	// b is listed first and therefore already used for this episode.
	assert.deepEqual(labels(routes), ["b/pinned-model", "a/m-flash"]);
});

test("rankCandidates tries one model per provider and skips the vendor that just failed", () => {
	const routes = rankCandidates([route("a/same"), route("a/other"), route("b/one"), route("c/one")], {
		from: route("a/same"),
		config: cfg(),
	});
	assert.deepEqual(labels(routes), ["b/one", "c/one"]);
});

test("rankCandidates orders providers by providerPriority then registration, and picks by modelPreference", () => {
	const routes = rankCandidates([route("b/big-model"), route("c/small-model"), route("b/flash-model")], {
		from: route("a/gone"),
		config: cfg({ providerPriority: ["c"], modelPreference: ["flash"] }),
	});
	assert.deepEqual(labels(routes), ["c/small-model", "b/flash-model"]);

	const discovered = rankCandidates([route("b/big-model"), route("c/small-model"), route("b/flash-model")], {
		from: route("a/gone"),
		config: cfg({ modelPreference: ["flash"] }),
	});
	assert.deepEqual(labels(discovered), ["b/flash-model", "c/small-model"]);
});

test("rankCandidates resolves a bare provider name to that provider's preferred model", () => {
	const routes = rankCandidates([route("a/big-model"), route("a/flash-model"), route("b/one")], {
		from: route("z/failed"),
		order: [{ provider: "a" }],
		config: cfg(),
	});
	assert.deepEqual(labels(routes), ["a/flash-model", "b/one"]);
});

test("rankCandidates filters tried routes, cooling routes, exclusions and empty models", () => {
	const now = 1_000_000;
	const cooling = new Map([["b/cold", now + 5000]]);
	const routes = rankCandidates([route("a/live"), route("b/cold"), route("c/tried"), route("d/embed-large"), route("e/"), route("f/ok")], {
		from: route("main/failed"),
		tried: new Set(["c/tried"]),
		isCooling: (label) => {
			const until = cooling.get(label);
			return until !== undefined && until > now;
		},
		config: cfg({ excludeProviders: ["e"] }),
		now,
	});
	assert.deepEqual(labels(routes), ["a/live", "f/ok"]);
});

test("rankCandidates returns an empty list when nothing is routable", () => {
	const routes = rankCandidates([route("a/same")], {
		from: route("a/same"),
		config: cfg(),
	});
	assert.deepEqual(routes, []);
});

test("createCatalog discovers every provider once, caches, and rediscovers after invalidate", async () => {
	const calls = { models: 0 };
	const fakeLlm = {
		listProviders: () => [{ id: "a" }, { id: "b" }],
		listModels: async (id) => {
			calls.models += 1;
			return id === "a" ? [{ id: "m1", name: "M1" }] : [{ id: "m2", name: "M2" }];
		},
	};
	const catalog = createCatalog({ llm: fakeLlm }, cfg({ discoverTtlMs: 600000 }), undefined);
	assert.deepEqual(labels(await catalog.list()), ["a/m1", "b/m2"]);
	assert.equal(calls.models, 2);
	assert.deepEqual(labels(await catalog.list()), ["a/m1", "b/m2"]);
	assert.equal(calls.models, 2, "a fresh cache must not hit the adapters again");
	assert.equal(catalog.cached().length, 2);
	catalog.invalidate("test");
	assert.deepEqual(labels(await catalog.list()), ["a/m1", "b/m2"]);
	assert.equal(calls.models, 4, "invalidate forces a rediscovery");
});

test("createCatalog ignores hanging, rejecting and empty providers", async () => {
	const hanging = new Promise(() => {});
	const catalog = createCatalog(
		{
			llm: {
				listProviders: () => [{ id: "a" }, { id: "slow" }, { id: "bad" }, { id: "empty" }],
				listModels: (id) => {
					if (id === "a") return Promise.resolve([{ id: "m1", name: "M1" }]);
					if (id === "slow") return hanging;
					if (id === "bad") return Promise.reject(new Error("no credential"));
					return Promise.resolve([]);
				},
			},
		},
		cfg({ discoverTimeoutMs: 25 }),
		undefined,
	);
	assert.deepEqual(labels(await catalog.list()), ["a/m1"]);
});

test("createCatalog survives a broken provider registry", async () => {
	const catalog = createCatalog(
		{
			llm: {
				listProviders: () => {
					throw new Error("registry gone");
				},
				listModels: async () => [],
			},
		},
		cfg(),
		undefined,
	);
	assert.deepEqual(await catalog.list(), []);
});

test("defaults stay JSON-serializable for the settings form", () => {
	assert.equal(typeof DEFAULTS.promptTemplate, "string");
	assert.deepEqual(JSON.parse(JSON.stringify(cfg())), cfg());
});
