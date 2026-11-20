import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Where the switch log lives: override with SMART_MODEL_FAILOVER_LOG, else $DSH_HOME/smart-model-failover.log. */
export function logPath() {
	if (process.env.SMART_MODEL_FAILOVER_LOG) return process.env.SMART_MODEL_FAILOVER_LOG;
	const home = process.env.DSH_HOME || join(homedir(), ".dsh");
	return join(home, "smart-model-failover.log");
}

/**
 * JSON-lines switch log. Deliberately NOT written into the session: a plugin
 * appending its own session events can leave that session unopenable later.
 */
export function createLog(file = logPath()) {
	return function log(record) {
		try {
			mkdirSync(dirname(file), { recursive: true });
			appendFileSync(file, `${new Date().toISOString()}  ${JSON.stringify(record)}\n`, "utf8");
		} catch {
			/* a failed log line must never stop a switch */
		}
	};
}
