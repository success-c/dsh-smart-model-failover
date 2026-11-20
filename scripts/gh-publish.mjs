// Creates the GitHub repository, pushes `main`, sets the topics, and opens the
// awesome-dsh-plugin listing PR. Reads a classic PAT (repo scope) from
// ~/.gh-token. The token is only used in memory and in one git invocation;
// it is never written to .git/config or to stdout.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TOKEN = readFileSync(join(homedir(), ".gh-token"), "utf8").trim();
const REPO = "dsh-smart-model-failover";
const UPSTREAM = "awesome-dsh-plugin/awesome-dsh-plugin";
const ENTRY_FILE = `data/plugins/success-c__${REPO}.yml`;
const BRANCH = `add-success-c-${REPO}`;

const ENTRY = `url: https://github.com/success-c/${REPO}
name: success-c/${REPO}
category: model
description:
  en: 'Discovers the models of every configured and externally connected provider at runtime, switches to the next one when a request fails, and asks the agent to continue the interrupted work.'
  zh: '运行时发现所有已配置及外部接入厂商的可用模型，请求失败时自动切到下一个，并让 agent 继续被中断的工作。'
`;

const api = async (path, init = {}) => {
	const response = await fetch(`https://api.github.com${path}`, {
		...init,
		headers: {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${TOKEN}`,
			"X-GitHub-Api-Version": "2022-11-28",
			...(init.headers ?? {}),
		},
	});
	const text = await response.text();
	let body;
	try {
		body = text ? JSON.parse(text) : {};
	} catch {
		body = { message: text };
	}
	return { status: response.status, body };
};

const fail = (step, result) => {
	console.error(`\nFAILED at ${step}: ${result.status} ${result.body?.message ?? ""}`);
	if (result.body?.errors) console.error(JSON.stringify(result.body.errors, null, 2));
	process.exit(1);
};

const me = await api("/user");
if (me.status !== 200) fail("GET /user", me);
const owner = me.body.login;
console.log(`token owner: ${owner}`);

const created = await api("/user/repos", {
	method: "POST",
	body: JSON.stringify({
		name: REPO,
		description:
			"DSH plugin: when a model request fails, switch to the next routable model discovered from every configured provider (and every externally connected one, e.g. WorkBuddy), then resume the interrupted turn.",
		homepage: `https://github.com/${owner}/${REPO}`,
		private: false,
		has_issues: true,
		has_wiki: false,
	}),
});
if (created.status === 201) console.log(`repo created: ${created.body.html_url}`);
else if (created.status === 422) console.log("repo already exists, continuing");
else fail("POST /user/repos", created);

const topics = await api(`/repos/${owner}/${REPO}/topics`, {
	method: "PUT",
	body: JSON.stringify({ names: ["dsh-plugin", "dsh", "deepseek-harness", "cordis", "failover"] }),
});
if (topics.status !== 200) fail("PUT topics", topics);
console.log(`topics: ${topics.body.names.join(", ")}`);

execFileSync(
	"git",
	["push", `https://x-access-token:${TOKEN}@github.com/${owner}/${REPO}.git`, "HEAD:main"],
	{ stdio: "inherit", cwd: dirname(dirname(fileURLToPath(import.meta.url))) },
);
console.log("pushed main");

const fork = await api(`/repos/${UPSTREAM}/forks`, { method: "POST", body: "{}" });
if (fork.status !== 202 && fork.status !== 200) fail("POST fork", fork);
let forkReady = fork.status === 200;
for (let attempt = 0; attempt < 40 && !forkReady; attempt += 1) {
	await new Promise((resolve) => setTimeout(resolve, 3000));
	const probe = await api(`/repos/${owner}/awesome-dsh-plugin`);
	forkReady = probe.status === 200;
}
if (!forkReady) {
	console.error("\nFAILED: the upstream fork did not become available in time");
	process.exit(1);
}
console.log(`fork ready: ${owner}/awesome-dsh-plugin`);

const base = await api(`/repos/${UPSTREAM}/git/ref/heads/main`);
if (base.status !== 200) fail("GET upstream main", base);

const ref = await api(`/repos/${owner}/awesome-dsh-plugin/git/refs`, {
	method: "POST",
	body: JSON.stringify({ ref: `refs/heads/${BRANCH}`, sha: base.body.object.sha }),
});
if (ref.status !== 201 && ref.status !== 422) fail("POST fork branch", ref);

const commit = await api(`/repos/${owner}/awesome-dsh-plugin/contents/${ENTRY_FILE}`, {
	method: "PUT",
	body: JSON.stringify({
		message: `Add ${owner}/${REPO}`,
		content: Buffer.from(ENTRY, "utf8").toString("base64"),
		branch: BRANCH,
	}),
});
if (commit.status !== 201) fail("PUT entry file", commit);
console.log(`entry committed: ${ENTRY_FILE}`);

const pull = await api(`/repos/${UPSTREAM}/pulls`, {
	method: "POST",
	body: JSON.stringify({
		title: `Add ${owner}/${REPO}`,
		head: `${owner}:${BRANCH}`,
		base: "main",
		body: [
			`Adds \`${owner}/${REPO}\` under \`model\`.`,
			"",
			"**What it does** — listens to `agent/request-error`, discovers the models of every provider registered with `ctx.llm` (including externally connected ones such as WorkBuddy), switches the agent's route with `agent.model.select()`, and resumes the interrupted turn with `agent.followup()` once the agent is idle. Attempt order, per-provider priority, cooldowns and a master switch are configurable through the settings form; the attempt order falls back to the providers' registration order with one model per provider.",
			"",
			"**npm** — `dsh-smart-model-failover@0.1.0`, `repository` points here, `@deepseek-ai/schemastery` is a `peerDependency`.",
			"**Repo age** — created today; the 1-day gate should clear on its own.",
		].join("\n"),
	}),
});
if (pull.status !== 201) fail("POST pull request", pull);
console.log(`\nPR: ${pull.body.html_url}`);
