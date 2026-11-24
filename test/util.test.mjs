import assert from "node:assert/strict";
import test from "node:test";
import {
	DEFAULTS,
	formatPrompt,
	LONG_COOLDOWN_CODES,
	normalizeConfig,
	NON_SWITCH_CODES,
	parseRoute,
	routeLabel,
	unwrapConfig,
	withTimeout,
} from "../lib/util.js";

test("parseRoute splits on the first slash only", () => {
	assert.deepEqual(parseRoute("huoshan/deepseek-v4-1-flash-260910"), {
		provider: "huoshan",
		model: "deepseek-v4-1-flash-260910",
	});
	assert.deepEqual(parseRoute(" vendor/model/with/slashes "), { provider: "vendor", model: "model/with/slashes" });
	assert.equal(parseRoute("no-slash"), undefined);
	assert.equal(parseRoute("/leading"), undefined);
	assert.equal(parseRoute("trailing/"), undefined);
	assert.equal(parseRoute(""), undefined);
	assert.equal(parseRoute(undefined), undefined);
	assert.equal(parseRoute(42), undefined);
});

test("routeLabel renders provider/model and degrades safely", () => {
	assert.equal(routeLabel({ provider: "huoshan", model: "m1" }), "huoshan/m1");
	assert.equal(routeLabel({ provider: "huoshan" }), "huoshan/?");
	assert.equal(routeLabel(undefined), "unknown");
});

test("normalizeConfig falls back to defaults for empty input", () => {
	const cfg = normalizeConfig({});
	assert.equal(cfg.enabled, DEFAULTS.enabled);
	assert.deepEqual(cfg.order, []);
	assert.equal(cfg.cooldownMs, DEFAULTS.cooldownMs);
	assert.equal(cfg.maxSwitches, DEFAULTS.maxSwitches);
	assert.equal(cfg.promptTemplate, DEFAULTS.promptTemplate);
	assert.deepEqual(cfg.modelPreference, DEFAULTS.modelPreference.map((item) => item.toLowerCase()));
});

test("the default cooldown keeps a failed route parked for five hours", () => {
	assert.equal(DEFAULTS.cooldownMs, 5 * 60 * 60 * 1000);
});

test("normalizeConfig accepts wild input without throwing", () => {
	const cfg = normalizeConfig({
		order: ["huoshan/m1", "huoshan/", "meng/mimo-v2.5", "workbuddy1"],
		cooldownMs: -5,
		maxSwitches: 2.9,
		providerPriority: ["meng", 7, ""],
		modelPreference: "nope",
		promptTemplate: "   ",
		enabled: "yes",
	});
	assert.deepEqual(cfg.order, [
		{ provider: "huoshan", model: "m1" },
		{ provider: "meng", model: "mimo-v2.5" },
		{ provider: "workbuddy1" },
	]);
	// The pre-0.2 name still works.
	assert.deepEqual(normalizeConfig({ chain: ["meng/b"] }).order, [{ provider: "meng", model: "b" }]);
	assert.equal(cfg.cooldownMs, DEFAULTS.cooldownMs);
	assert.equal(cfg.maxSwitches, 2);
	assert.deepEqual(cfg.providerPriority, ["meng"]);
	assert.deepEqual(cfg.modelPreference, DEFAULTS.modelPreference.map((item) => item.toLowerCase()));
	assert.equal(cfg.promptTemplate, DEFAULTS.promptTemplate);
	assert.equal(cfg.enabled, true);
	assert.equal(normalizeConfig(null).enabled, DEFAULTS.enabled);
});

test("formatPrompt substitutes every placeholder occurrence", () => {
	const text = formatPrompt("{from} -> {to} ({code}) / {from}", { from: "a/m1", to: "b/m2", code: "RATE_LIMIT" });
	assert.equal(text, "a/m1 -> b/m2 (RATE_LIMIT) / a/m1");
});

test("withTimeout resolves values, propagates rejections, and gives up on hangs", async () => {
	assert.equal(await withTimeout(Promise.resolve(7), 1000), 7);
	await assert.rejects(withTimeout(Promise.reject(new Error("boom")), 1000), /boom/);
	assert.equal(await withTimeout(new Promise(() => {}), 25), undefined);
});

test("code sets cover the documented failover policy", () => {
	for (const code of ["AUTH", "MISSING_CREDENTIAL", "UNKNOWN_MODEL", "NO_ADAPTER"]) {
		assert.ok(LONG_COOLDOWN_CODES.has(code), code);
	}
	for (const code of ["ABORTED", "INVALID_REQUEST"]) {
		assert.ok(NON_SWITCH_CODES.has(code), code);
	}
	assert.ok(!NON_SWITCH_CODES.has("RATE_LIMIT"));
});

test("unwraps a schemastery volatile config reference", () => {
	const ref = { get: () => ({ enabled: false, order: ["meng/mimo"] }) };
	assert.deepEqual(unwrapConfig(ref).order, ["meng/mimo"]);
	assert.equal(normalizeConfig(ref).enabled, false);
	// Plain objects, null and garbage all stay safe.
	assert.equal(normalizeConfig({}).enabled, DEFAULTS.enabled);
	assert.equal(normalizeConfig(null).enabled, DEFAULTS.enabled);
});
