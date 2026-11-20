import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Context } from "@deepseek-ai/cordis";

import * as plugin from "../lib/index.js";

// These tests mount the plugin on a real cordis Context — the same framework the host
// runs — instead of hand-calling the listeners. That is what proves `inject`,
// `ctx.effect`, `ctx.on` and waterfall dispatch actually line up with the host.

function tempLog() {
  const dir = mkdtempSync(join(tmpdir(), "smf-cordis-"));
  return join(dir, "failover.log");
}

function readKinds(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    // The file is `<ISO timestamp>  <json>`, not pure JSON per line.
    .map((line) => JSON.parse(line.slice(line.indexOf("{"))).kind);
}

function makeAgent(provider = "huoshan", model = "deepseek-v4-1-flash-260910") {
  const state = { status: "running", route: { provider, model }, selects: [], followups: [] };
  const agent = {
    get status() {
      return state.status;
    },
    model: {
      current: () => ({ ...state.route }),
      select(selection) {
        state.selects.push(selection);
        state.route = { provider: selection.provider, model: selection.model };
      },
    },
    followup(message) {
      state.followups.push(message);
    },
  };
  return { agent, state };
}

const PROVIDERS = [
  { id: "huoshan", name: "火山-孟" },
  { id: "huoshanhong", name: "火山-红" },
  { id: "workbuddy1", name: "WorkBuddy" },
];

function catalog(providers = PROVIDERS) {
  return {
    listProviders: () => [...providers],
    listModels: async (id) => {
      if (id === "huoshan" || id === "huoshanhong") {
        return [{ provider: id, id: "deepseek-v4-1-flash-260910", name: "DeepSeek V4.1 Flash" }];
      }
      return [{ provider: id, id: "hy4flash-free", name: "HY4 Flash" }];
    },
  };
}

async function mount({ llm = catalog(), agents = {}, config = {}, log = tempLog() } = {}) {
  process.env.SMART_MODEL_FAILOVER_LOG = log;
  const root = new Context();
  root.provide("llm");
  root.provide("agents");
  root.provide("webServer");
  const registered = [];
  root.set("llm", llm);
  root.set("agents", agents);
  root.set("webServer", {
    register: (route) => {
      registered.push(route);
      return () => {
        const index = registered.indexOf(route);
        if (index >= 0) registered.splice(index, 1);
      };
    },
  });
  const fiber = await root.plugin(plugin, config);
  return { root, fiber, log, registered };
}

function failurePayload(agent, provider, code = "SERVER") {
  return {
    agent,
    turn: 4,
    step: 2,
    provider,
    failure: { message: `${provider} is down`, code },
    retryPolicy: undefined,
    signal: new AbortController().signal,
  };
}

test("mounts on a real cordis context and switches to another provider on failure", async () => {
  const { root, fiber, log } = await mount();
  const { agent, state } = makeAgent();

  const action = await root.waterfall("agent/request-error", failurePayload(agent, "huoshan"), async () => undefined);

  assert.equal(action, undefined, "the plugin owns the recovery and lets the failed step end");
  // Same model on another provider wins over a different model on the same provider.
  assert.deepEqual(state.route, { provider: "huoshanhong", model: "deepseek-v4-1-flash-260910" });
  assert.equal(state.selects.length, 1);

  state.status = "idle"; // the host flips status first, then emits
  await root.emit("agent/status", { agent, status: "idle" });
  assert.equal(state.followups.length, 1, "resumes once the agent is idle");
  assert.equal(state.followups[0].source.kind, "user");
  assert.match(state.followups[0].content[0].text, /huoshan/);
  assert.match(state.followups[0].content[0].text, /huoshanhong/);

  const kinds = readKinds(log);
  assert.ok(kinds.includes("switch"), `expected a switch record, got ${kinds.join(",")}`);
  assert.ok(kinds.includes("resume-sent"));

  await fiber.dispose();
});

test("delegates to a downstream retry and leaves the route alone", async () => {
  const { root, fiber } = await mount();
  const { agent, state } = makeAgent();

  const action = await root.waterfall("agent/request-error", failurePayload(agent, "huoshan"), async () => ({
    kind: "retry",
  }));

  assert.deepEqual(action, { kind: "retry" }, "a downstream decision is passed through untouched");
  assert.equal(state.selects.length, 0);
  assert.deepEqual(state.route, { provider: "huoshan", model: "deepseek-v4-1-flash-260910" });

  await fiber.dispose();
});

test("survives a provider whose catalog cannot be listed", async () => {
  const llm = {
    listProviders: () => [...PROVIDERS],
    listModels: async (id) => {
      if (id === "huoshan" || id === "huoshanhong") throw new Error("catalog unavailable");
      return [{ provider: id, id: "hy4flash-free", name: "HY4 Flash" }];
    },
  };
  const { root, fiber, log } = await mount({ llm });
  const { agent, state } = makeAgent();

  await root.waterfall("agent/request-error", failurePayload(agent, "huoshan"), async () => undefined);

  assert.deepEqual(state.route, { provider: "workbuddy1", model: "hy4flash-free" });
  assert.ok(readKinds(log).includes("discover-failed"));

  await fiber.dispose();
});

test("disposal removes every hook it registered", async () => {
  const { root, fiber, log } = await mount();
  const { agent, state } = makeAgent();

  await fiber.dispose();
  const kindsBefore = readKinds(log).length;

  await root.waterfall("agent/request-error", failurePayload(agent, "huoshan"), async () => undefined);
  await root.emit("agent/status", { agent, status: "idle" });

  assert.equal(state.selects.length, 0);
  assert.equal(state.followups.length, 0);
  assert.equal(readKinds(log).length, kindsBefore, "nothing was logged after disposal");
});

test("serves the settings picker only the profile's discovered models", async () => {
  const { fiber, registered } = await mount();
  const route = registered.find((entry) => entry.path === "/smart-model-failover/plan");
  assert.ok(route, "the settings page needs a read-only plan route");

  const response = await route.resource();
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  const payload = await response.json();

  assert.equal(payload.source, "auto");
  assert.deepEqual(payload.routes, [
    "huoshan/deepseek-v4-1-flash-260910",
    "huoshanhong/deepseek-v4-1-flash-260910",
    "workbuddy1/hy4flash-free",
  ]);
  const models = [
    "huoshan/deepseek-v4-1-flash-260910",
    "huoshanhong/deepseek-v4-1-flash-260910",
    "workbuddy1/hy4flash-free",
  ].sort((left, right) => left.localeCompare(right));
  assert.deepEqual(payload.models, models, "the picker lists the catalog, not a market-wide list");
  assert.ok(!("market" in payload));

  await fiber.dispose();
  assert.equal(registered.length, 0, "disposal unregisters the route");
});

test("the plan route keeps every discovered model when an order is pinned", async () => {
  const { fiber, registered } = await mount({ config: { order: ["workbuddy1/hy4flash-free"] } });
  const route = registered.find((entry) => entry.path === "/smart-model-failover/plan");
  assert.ok(route);

  const payload = await (await route.resource()).json();
  assert.equal(payload.source, "configured");
  assert.equal(payload.routes[0], "workbuddy1/hy4flash-free", "pinned order wins in the plan");
  assert.equal(payload.models.length, 3, "the picker still offers all configured providers' models");

  await fiber.dispose();
});
