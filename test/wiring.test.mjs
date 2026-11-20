import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { apply } from "../lib/index.js";

function makeHarness({ providers = [], models = {} } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "smf-"));
	const logFile = join(dir, "switch.log");
	process.env.SMART_MODEL_FAILOVER_LOG = logFile;

	const handlers = new Map();
	const disposers = [];
	const ctx = {
		llm: {
			listProviders: () => providers.map((id) => ({ id, name: id })),
			listModels: async (id) => models[id] ?? [],
		},
		on(event, listener) {
			const list = handlers.get(event) ?? [];
			list.push(listener);
			handlers.set(event, list);
			return () => {
				const current = handlers.get(event) ?? [];
				const index = current.indexOf(listener);
				if (index >= 0) current.splice(index, 1);
			};
		},
		effect(callback) {
			disposers.push(callback());
		},
	};

	function emit(event, payload) {
		for (const listener of handlers.get(event) ?? []) listener(payload);
	}

	function requestError(payload, next = async () => undefined) {
		const listener = (handlers.get("agent/request-error") ?? [])[0];
		assert.ok(listener, "the plugin must listen to agent/request-error");
		return listener(payload, next);
	}

	function records() {
		try {
			return readFileSync(logFile, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line.slice(line.indexOf("{"))));
		} catch {
			return [];
		}
	}

	return {
		ctx,
		emit,
		requestError,
		records,
		start(config = {}) {
			apply(ctx, config);
		},
		dispose() {
			for (const dispose of disposers) if (typeof dispose === "function") dispose();
		},
	};
}

function makeAgent(selection) {
	let current = selection ? { ...selection } : undefined;
	const followups = [];
	const agent = {
		status: "running",
		followups,
		model: {
			current: () => (current ? { ...current } : undefined),
			select(next) {
				current = { provider: next.provider, model: next.model };
			},
		},
		async followup(message) {
			// Mirror the host contract: a user message appended to the session must
			// carry an id and the expected role, or the log becomes unreadable.
			assert.equal(message?.role, "user");
			assert.equal(typeof message?.id, "string");
			assert.ok(message.id.length > 0);
			followups.push(message);
		},
	};
	return agent;
}

function failure(agent, code = "RATE_LIMIT", provider) {
	return {
		agent,
		turn: 1,
		step: 1,
		provider: provider ?? agent.model.current()?.provider,
		failure: { message: "upstream exploded", code },
		signal: { aborted: false },
	};
}

const settled = () => new Promise((resolve) => setImmediate(resolve));

test("switches to another provider and re-drives the interrupted turn", async () => {
	const harness = makeHarness({
		providers: ["huoshan", "meng"],
		models: {
			huoshan: [{ id: "deepseek-v4-1-flash-260910", name: "flash" }],
			meng: [{ id: "mimo-v2.5", name: "mimo" }],
		},
	});
	harness.start();
	const agent = makeAgent({ provider: "huoshan", model: "deepseek-v4-1-flash-260910" });

	await harness.requestError(failure(agent));
	assert.deepEqual(agent.model.current(), { provider: "meng", model: "mimo-v2.5" });

	agent.status = "idle";
	harness.emit("agent/status", { agent, status: "idle" });
	await settled();
	await settled();

	assert.equal(agent.followups.length, 1);
	// The host writes this object verbatim as `user/message`; without id/role the
	// session log fails validation on reload ("lacks an identified message").
	assert.equal(agent.followups[0].role, "user");
	assert.match(agent.followups[0].id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	const text = agent.followups[0].content[0].text;
	assert.match(text, /mimo-v2\.5/);
	assert.match(text, /deepseek-v4-1-flash-260910/);
	assert.equal(agent.followups[0].source.kind, "user");

	const records = harness.records();
	assert.equal(records.filter((record) => record.kind === "switch").length, 1);
	assert.equal(records.some((record) => record.kind === "resume-sent"), true);
	harness.dispose();
});

test("defers to a downstream listener that already owns recovery", async () => {
	const harness = makeHarness({ providers: ["huoshan", "meng"], models: { huoshan: [{ id: "a" }], meng: [{ id: "b" }] } });
	harness.start();
	const agent = makeAgent({ provider: "huoshan", model: "a" });
	await harness.requestError(failure(agent), async () => ({ kind: "retry" }));
	assert.deepEqual(agent.model.current(), { provider: "huoshan", model: "a" });
	assert.equal(agent.followups.length, 0);
	harness.dispose();
});

test("does nothing for an aborted request or a non-routing failure code", async () => {
	const harness = makeHarness({ providers: ["huoshan", "meng"], models: { huoshan: [{ id: "a" }], meng: [{ id: "b" }] } });
	harness.start();
	const agent = makeAgent({ provider: "huoshan", model: "a" });

	const aborted = failure(agent);
	aborted.signal = { aborted: true };
	await harness.requestError(aborted);
	assert.deepEqual(agent.model.current(), { provider: "huoshan", model: "a" });

	await harness.requestError(failure(agent, "INVALID_REQUEST"));
	assert.deepEqual(agent.model.current(), { provider: "huoshan", model: "a" });
	assert.equal(harness.records().some((record) => record.kind === "skip-code"), true);
	harness.dispose();
});

test("caps automatic switches per episode", async () => {
	const harness = makeHarness({
		providers: ["huoshan", "meng", "workbuddy1"],
		models: { huoshan: [{ id: "a" }], meng: [{ id: "b" }], workbuddy1: [{ id: "c" }] },
	});
	harness.start({ maxSwitches: 1 });
	const agent = makeAgent({ provider: "huoshan", model: "a" });

	await harness.requestError(failure(agent));
	assert.deepEqual(agent.model.current(), { provider: "meng", model: "b" });

	await harness.requestError(failure(agent));
	assert.deepEqual(agent.model.current(), { provider: "meng", model: "b" }, "the cap must stop the second switch");
	assert.equal(harness.records().some((record) => record.kind === "max-switches"), true);
	harness.dispose();
});

test("never retries a route that already failed in this episode", async () => {
	const harness = makeHarness({ providers: ["huoshan", "meng"], models: { huoshan: [{ id: "a" }], meng: [{ id: "b" }] } });
	harness.start({ maxSwitches: 0, cooldownMs: 0 });
	const agent = makeAgent({ provider: "huoshan", model: "a" });

	await harness.requestError(failure(agent));
	assert.deepEqual(agent.model.current(), { provider: "meng", model: "b" });

	await harness.requestError(failure(agent));
	assert.equal(harness.records().some((record) => record.kind === "exhausted"), true);
	harness.dispose();
});

test("reports a selection the host refused to apply", async () => {
	const harness = makeHarness({ providers: ["huoshan", "meng"], models: { huoshan: [{ id: "a" }], meng: [{ id: "b" }] } });
	harness.start();
	const agent = makeAgent({ provider: "huoshan", model: "a" });
	const original = agent.model.select;
	agent.model.select = () => undefined; // host silently keeps the old route

	await harness.requestError(failure(agent));
	assert.deepEqual(agent.model.current(), { provider: "huoshan", model: "a" });
	assert.equal(harness.records().some((record) => record.kind === "select-not-applied"), true);
	assert.equal(agent.followups.length, 0);
	agent.model.select = original;
	harness.dispose();
});

test("survives a select() that throws", async () => {
	const harness = makeHarness({ providers: ["huoshan", "meng"], models: { huoshan: [{ id: "a" }], meng: [{ id: "b" }] } });
	harness.start();
	const agent = makeAgent({ provider: "huoshan", model: "a" });
	agent.model.select = () => {
		throw new Error("route locked");
	};

	await harness.requestError(failure(agent));
	assert.equal(harness.records().some((record) => record.kind === "select-failed"), true);
	harness.dispose();
});

test("resume=false switches without re-driving the turn", async () => {
	const harness = makeHarness({ providers: ["huoshan", "meng"], models: { huoshan: [{ id: "a" }], meng: [{ id: "b" }] } });
	harness.start({ resume: false });
	const agent = makeAgent({ provider: "huoshan", model: "a" });

	await harness.requestError(failure(agent));
	assert.deepEqual(agent.model.current(), { provider: "meng", model: "b" });
	agent.status = "idle";
	harness.emit("agent/status", { agent, status: "idle" });
	await settled();
	assert.equal(agent.followups.length, 0);
	harness.dispose();
});

test("does nothing while the master switch is off", async () => {
	const harness = makeHarness({
		providers: ["huoshan", "meng"],
		models: { huoshan: [{ id: "a" }], meng: [{ id: "b" }] },
	});
	harness.start({ enabled: false });
	const agent = makeAgent({ provider: "huoshan", model: "a" });

	const downstream = await harness.requestError(failure(agent), async () => ({ kind: "retry" }));
	assert.deepEqual(downstream, { kind: "retry" }, "the rest of the chain still decides");
	assert.deepEqual(agent.model.current(), { provider: "huoshan", model: "a" });
	assert.equal(agent.followups.length, 0);
	assert.equal(harness.records().some((record) => record.kind === "switch"), false);
	harness.dispose();
});

test("walks provider by provider with one model each", async () => {
	const harness = makeHarness({
		providers: ["a", "b", "c"],
		models: { a: [{ id: "a1" }, { id: "a2" }], b: [{ id: "b1" }], c: [{ id: "c1" }] },
	});
	harness.start();
	const agent = makeAgent({ provider: "a", model: "a1" });

	await harness.requestError(failure(agent));
	// a has a second model, but one failure per vendor is enough: move to b.
	assert.deepEqual(agent.model.current(), { provider: "b", model: "b1" });

	await harness.requestError(failure(agent));
	assert.deepEqual(agent.model.current(), { provider: "c", model: "c1" });

	await harness.requestError(failure(agent));
	// Nothing left, a and b are not reused within the same episode.
	assert.deepEqual(agent.model.current(), { provider: "c", model: "c1" });
	assert.equal(harness.records().some((record) => record.kind === "exhausted"), true);
	harness.dispose();
});

test("respects excludeProviders and providerPriority", async () => {
	const harness = makeHarness({
		providers: ["huoshan", "meng", "workbuddy1"],
		models: {
			huoshan: [{ id: "a" }],
			meng: [{ id: "b" }],
			workbuddy1: [{ id: "hy4flash-free" }],
		},
	});
	harness.start({ excludeProviders: ["meng"], providerPriority: ["workbuddy1"] });
	const agent = makeAgent({ provider: "huoshan", model: "a" });

	await harness.requestError(failure(agent));
	assert.deepEqual(agent.model.current(), { provider: "workbuddy1", model: "hy4flash-free" });

	const records = harness.records();
	const applied = records.find((record) => record.kind === "switch");
	assert.ok(applied.to.startsWith("workbuddy1/"));
	harness.dispose();
});

test("picks a configured order route before a discovered one", async () => {
	const harness = makeHarness({
		providers: ["huoshan", "meng"],
		models: { huoshan: [{ id: "a" }], meng: [{ id: "b" }] },
	});
	harness.start({ order: ["meng/b"] });
	const agent = makeAgent({ provider: "huoshan", model: "a" });

	await harness.requestError(failure(agent));
	assert.deepEqual(agent.model.current(), { provider: "meng", model: "b" });
	harness.dispose();
});

test("invalidates the catalog when the host announces new adapters", async () => {
	const harness = makeHarness();
	let discoveries = 0;
	harness.ctx.llm = {
		listProviders: () => [{ id: "huoshan" }],
		listModels: async () => {
			discoveries += 1;
			return [{ id: `m${discoveries}` }];
		},
	};
	harness.start({ discoverTtlMs: 600000 });
	harness.emit("llm/adapters-updated");
	assert.equal(harness.records().some((record) => record.kind === "cache-invalidated"), true);

	const agent = makeAgent({ provider: "huoshan", model: "m0" });
	await harness.requestError(failure(agent));
	assert.equal(discoveries, 1);
	// With a single provider there is nowhere to switch to, but discovery did rerun.
	assert.deepEqual(agent.model.current(), { provider: "huoshan", model: "m0" });
	assert.equal(harness.records().some((record) => record.kind === "exhausted"), true);
	harness.dispose();
});

test("reads a volatile config live, so settings edits apply without a restart", async () => {
	const harness = makeHarness();
	const state = { enabled: true };
	// What `Config.volatile()` hands to `apply()`: a stable reference, not data.
	const ref = { get: () => ({ enabled: state.enabled }) };
	harness.ctx.llm = {
		listProviders: () => [{ id: "huoshan" }, { id: "meng" }],
		listModels: async (id) => [{ id: id === "huoshan" ? "flash-a" : "flash-b" }],
	};
	harness.start(ref);
	assert.equal(harness.records().some((record) => record.kind === "loaded"), true);

	const agent = makeAgent({ provider: "huoshan", model: "flash-a" });
	await harness.requestError(failure(agent));
	assert.deepEqual(agent.model.current(), { provider: "meng", model: "flash-b" });

	// The settings page flips the master switch off; no remount happens.
	state.enabled = false;
	harness.emit("loader/volatile-update");
	assert.equal(harness.records().some((record) => record.kind === "config-updated"), true);

	const other = makeAgent({ provider: "huoshan", model: "flash-a" });
	const delegated = await harness.requestError(failure(other), async () => ({ kind: "retry" }));
	assert.deepEqual(delegated, { kind: "retry" });
	assert.deepEqual(other.model.current(), { provider: "huoshan", model: "flash-a" });
	harness.dispose();
});
