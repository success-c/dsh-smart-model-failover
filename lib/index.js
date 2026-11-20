import { createCatalog, rankCandidates } from "./catalog.js";
import { Config } from "./config.js";
import { createLog } from "./log.js";
import { NON_SWITCH_CODES, normalizeConfig, formatPrompt, LONG_COOLDOWN_CODES, LONG_COOLDOWN_MS, routeLabel } from "./util.js";

export const name = "smart-model-failover";
export const inject = ["agents", "llm"];
export { Config };

/** Give the host a beat to close the failed turn before we re-drive it. */
const RESUME_DELAY_MS = 600;

/**
 * Automatic model failover across every provider the host knows about.
 *
 * Flow: `agent/request-error` -> let downstream owners (llm-retry, ...) decide
 * first -> pick the next routable route from the live catalog ->
 * `agent.model.select()` -> return `undefined` so this turn ends cleanly ->
 * when the agent goes idle, `agent.followup()` re-drives the interrupted work.
 *
 * The switch itself is recorded by the host (`model/selection` + the
 * "[model changed: ...]" notice), so this plugin never writes session events.
 */
export function apply(ctx, config = {}) {
	const cfg = normalizeConfig(config);
	const log = createLog();
	log({ kind: "loaded", chain: cfg.chain.length, enabled: cfg.enabled });
	if (!cfg.enabled) return;

	const catalog = createCatalog(ctx, cfg, log);

	/** Per-agent episode: which routes already failed in this turn, and how many switches happened. */
	const episodes = new WeakMap();
	/** route label -> timestamp until which it is parked. */
	const cooling = new Map();
	/** agent -> the switch waiting to be resumed. */
	const pendingResume = new WeakMap();
	/** agent -> fallback timer that re-drives it if the idle event never arrives. */
	const resumeTimers = new WeakMap();
	/** Every live fallback timer, so dispose can clear them all. */
	const liveTimers = new Set();

	function episodeOf(agent) {
		let episode = episodes.get(agent);
		if (!episode) {
			episode = { tried: new Set(), switches: 0 };
			episodes.set(agent, episode);
		}
		return episode;
	}

	function markCooling(label, code) {
		const base = LONG_COOLDOWN_CODES.has(code) ? Math.max(cfg.cooldownMs, LONG_COOLDOWN_MS) : cfg.cooldownMs;
		if (base > 0) cooling.set(label, Date.now() + base);
	}

	function isCooling(label, now = Date.now()) {
		const until = cooling.get(label);
		if (until === undefined) return false;
		if (until <= now) {
			cooling.delete(label);
			return false;
		}
		return true;
	}

	/** The route that just failed: prefer the recorded selection, fall back to the event's provider. */
	function currentRoute(agent, payload) {
		try {
			const selection = agent?.model?.current?.();
			if (selection?.provider && selection?.model) return { provider: selection.provider, model: selection.model };
		} catch {
			/* fall through to the event payload */
		}
		if (payload?.provider) return { provider: payload.provider, model: undefined };
		return undefined;
	}

	function scheduleResume(agent) {
		if (!cfg.resume || !pendingResume.has(agent)) {
			pendingResume.delete(agent);
			return;
		}
		const previous = resumeTimers.get(agent);
		if (previous) {
			clearTimeout(previous);
			liveTimers.delete(previous);
		}
		const timer = setTimeout(() => {
			liveTimers.delete(timer);
			resumeTimers.delete(agent);
			tryResume(agent);
		}, RESUME_DELAY_MS);
		timer.unref?.();
		resumeTimers.set(agent, timer);
		liveTimers.add(timer);
	}

	async function tryResume(agent) {
		const pending = pendingResume.get(agent);
		if (!pending) return;
		if (agent?.status !== "idle") return;
		pendingResume.delete(agent);
		const text = formatPrompt(cfg.promptTemplate, {
			from: pending.from,
			to: routeLabel(pending.to),
			code: pending.code,
		});
		try {
			await agent.followup({ content: [{ type: "text", text }], source: { kind: "user" } });
			log({ kind: "resume-sent", to: routeLabel(pending.to), code: pending.code });
		} catch (error) {
			log({ kind: "resume-failed", to: routeLabel(pending.to), error: String(error?.message ?? error) });
		}
	}

	async function onRequestError(payload, next) {
		const downstream = await next();
		// Another listener (llm-retry, a skill, a human) already owns recovery.
		if (downstream !== undefined) return downstream;
		if (!payload || payload.signal?.aborted) return undefined;

		const agent = payload.agent;
		const failure = payload.failure;
		if (!agent || !failure) return undefined;

		const code = failure.code ?? "UNKNOWN";
		if (NON_SWITCH_CODES.has(code)) {
			log({ kind: "skip-code", code, provider: payload.provider });
			return undefined;
		}

		const episode = episodeOf(agent);
		const from = currentRoute(agent, payload);
		const fromLabel = routeLabel(from);
		if (from?.model) {
			episode.tried.add(fromLabel);
			markCooling(fromLabel, code);
		}

		if (cfg.maxSwitches > 0 && episode.switches >= cfg.maxSwitches) {
			log({ kind: "max-switches", from: fromLabel, code, switches: episode.switches });
			return undefined;
		}

		const routes = await catalog.list();
		const candidates = rankCandidates(routes, {
			from,
			failedProvider: from?.provider ?? payload.provider,
			tried: episode.tried,
			isCooling,
			chain: cfg.chain,
			config: cfg,
		});
		const target = candidates[0];
		if (!target) {
			log({ kind: "exhausted", from: fromLabel, code, candidates: routes.length });
			return undefined;
		}

		try {
			agent.model.select({ provider: target.provider, model: target.model });
		} catch (error) {
			log({ kind: "select-failed", from: fromLabel, to: routeLabel(target), error: String(error?.message ?? error) });
			return undefined;
		}

		const applied = agent.model?.current?.();
		if (!applied || applied.provider !== target.provider || applied.model !== target.model) {
			log({ kind: "select-not-applied", from: fromLabel, to: routeLabel(target) });
			return undefined;
		}

		episode.switches += 1;
		log({ kind: "switch", from: fromLabel, to: routeLabel(target), code, episode: episode.switches, candidates: candidates.length });

		// Hand the rest of the turn back to the host: it closes the failed step,
		// we re-drive it from the idle state.
		if (cfg.resume) {
			pendingResume.set(agent, { from: fromLabel, to: target, code });
			if (agent.status === "idle") scheduleResume(agent);
		}
		return undefined;
	}

	function onStatus(payload) {
		const agent = payload?.agent;
		if (!agent || payload?.status !== "idle") return;
		if (!pendingResume.has(agent)) {
			episodes.delete(agent);
			return;
		}
		tryResume(agent);
	}

	const invalidate = (reason) => catalog.invalidate(reason);
	const onAdaptersUpdated = () => invalidate("adapters-updated");
	const onModelsUpdated = (provider) => invalidate(`models-updated:${provider}`);

	ctx.effect(() => {
		// Warm the catalog in the background so the first failure is fast.
		const warm = setTimeout(() => catalog.warm(), 0);
		warm.unref?.();
		const disposers = [
			ctx.on("agent/request-error", onRequestError),
			ctx.on("agent/status", onStatus),
			ctx.on("llm/adapters-updated", onAdaptersUpdated),
			ctx.on("llm/models-updated", onModelsUpdated),
		].filter((disposer) => typeof disposer === "function");
		return () => {
			clearTimeout(warm);
			for (const timer of liveTimers) clearTimeout(timer);
			liveTimers.clear();
			for (const dispose of disposers) dispose();
		};
	}, "smart-model-failover: hooks");
}
