/**
 * Browser page for the plugin's configuration on the DSH Plugins page.
 *
 * The Host exposes the `Config` schema as the `smart-model-failover` settings
 * namespace. This client registers the bundle's `plugins.bundle.config` page.
 *
 * The page shows the effective model order, not just the raw `order` array:
 * when `order` is empty it reads the live discovery plan from the Host and
 * renders it as the default. Any edit (drag, add, remove) turns that plan into
 * an explicit `order` list, which is exactly how the Host already ranks routes.
 */
window.__ModuleLoader__.load({
	id: "dsh-smart-model-failover",
	factory: (require) => {
		const module = { exports: {} };
		const exports = module.exports;
		const React = require("react");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		const { SettingsForm, SettingsFormModel, SettingsValueField, Switch } = primitives;
		const h = React.createElement;

		/** Loader entry id of the plugin in the profile patch. */
		const NAMESPACE = "smart-model-failover";
		/** Package name the Plugins page renders this bundle's configuration under. */
		const BUNDLE = "dsh-smart-model-failover";
		/** Read-only route served by the plugin Host half. */
		const PLAN_ROUTE = "/smart-model-failover/plan";

		const LABELS = {
			unavailable: "当前无法读取该插件配置。",
			readOnly: "当前配置为只读。",
			saveFailed: "保存失败，请重试。",
			save: "保存",
			saving: "保存中…",
		};

		const MODEL_HINT =
			"按顺序尝试；拖动行或使用 ↑↓ 调整，保存后按此顺序切换。默认顺序优先同一模型家族（deepseek），同一家族内版本更高的排前面（v4.1 先于 v4）；失败过的模型默认冷却 5 小时，429/请求过多、502 等临时错误冷却 5 分钟，冷却期内不会被再次选中。";
		const PROVIDER_HINT = "自动发现时优先尝试的厂商；可新增、拖动或删除。";

		/** Stylesheet id; one copy per mount, removed with the plugin. */
		const STYLE_ID = "dsh-smart-model-failover-styles";
		const STYLES = `
			.smf-panel { display: flex; flex-direction: column; gap: 18px; }
			.smf-card {
				border: 1px solid rgba(127,127,127,0.22);
				border-radius: 12px;
				padding: 14px 16px;
				background: rgba(127,127,127,0.045);
			}
			.smf-head { display: flex; align-items: center; gap: 14px; }
			.smf-head-text { flex: 1; min-width: 0; }
			.smf-title { font-weight: 600; font-size: 14px; }
			.smf-sub { font-size: 12px; opacity: 0.7; margin-top: 3px; line-height: 1.5; }
			.smf-section-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
			.smf-section-title { font-weight: 600; font-size: 13px; }
			.smf-chip {
				font-size: 11px; line-height: 16px; padding: 0 7px; border-radius: 999px;
				border: 1px solid rgba(127,127,127,0.3); opacity: 0.85; white-space: nowrap;
			}
			.smf-chip-accent { border-color: rgba(64,158,255,0.55); color: #409eff; opacity: 1; }
			.smf-hint { font-size: 12px; opacity: 0.65; flex-basis: 100%; line-height: 1.5; }
			.smf-row {
				display: grid; grid-template-columns: 22px 16px 1fr auto; align-items: center; gap: 10px;
				padding: 9px 10px; margin-bottom: 6px; border-radius: 8px;
				border: 1px solid rgba(127,127,127,0.2);
				background: rgba(127,127,127,0.05);
				cursor: grab; transition: border-color 120ms ease, background 120ms ease, opacity 120ms ease;
			}
			.smf-row:hover { border-color: rgba(64,158,255,0.5); background: rgba(64,158,255,0.07); }
			.smf-row[data-dragging="true"] { opacity: 0.4; }
			.smf-row[data-drop="true"] { border-color: #409eff; border-style: dashed; }
			.smf-index {
				font-size: 11px; opacity: 0.55; text-align: right; font-variant-numeric: tabular-nums;
				user-select: none;
			}
			.smf-handle { opacity: 0.45; font-size: 15px; line-height: 1; user-select: none; }
			.smf-body { min-width: 0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
			.smf-provider {
				font-size: 11px; line-height: 17px; padding: 0 7px; border-radius: 5px;
				border: 1px solid rgba(127,127,127,0.3); opacity: 0.8; white-space: nowrap;
			}
			.smf-model { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; overflow-wrap: anywhere; }
			.smf-actions { display: flex; gap: 4px; opacity: 0; transition: opacity 120ms ease; }
			.smf-row:hover .smf-actions, .smf-row:focus-within .smf-actions { opacity: 1; }
			.smf-btn {
				border: 1px solid rgba(127,127,127,0.3); background: transparent; color: inherit;
				border-radius: 6px; padding: 2px 7px; cursor: pointer; font-size: 12px; line-height: 18px;
				transition: border-color 120ms ease, color 120ms ease;
			}
			.smf-btn:hover:not(:disabled) { border-color: #409eff; color: #409eff; }
			.smf-btn:disabled { opacity: 0.35; cursor: default; }
			.smf-btn-danger:hover:not(:disabled) { border-color: #d9534f; color: #d9534f; }
			.smf-add { display: flex; gap: 8px; margin-top: 10px; }
			.smf-input {
				flex: 1; min-width: 0; padding: 6px 9px; border-radius: 7px; font-size: 12.5px;
				border: 1px solid rgba(127,127,127,0.32); background: transparent; color: inherit;
				transition: border-color 120ms ease;
			}
			.smf-input:focus { outline: none; border-color: #409eff; }
			.smf-empty { font-size: 12px; opacity: 0.6; padding: 10px 2px; line-height: 1.5; }
		`;

		/** Install the stylesheet once per page; returns the node we created, if any. */
		function ensureStyles() {
			if (typeof document === "undefined" || !document.head) return null;
			if (document.getElementById(STYLE_ID)) return null;
			const node = document.createElement("style");
			node.id = STYLE_ID;
			node.textContent = STYLES;
			document.head.appendChild(node);
			return node;
		}

		/** Split a `string[]` field's comma-separated draft into rows. */
		function splitList(text) {
			return text
				.split(",")
				.map((entry) => entry.trim())
				.filter((entry) => entry.length > 0);
		}

		/** A `string[]` field serialized as comma-separated text. */
		function listSpec(field) {
			return {
				field,
				format: (value) => (Array.isArray(value) ? value.join(", ") : ""),
				parse: (text) => ({
					kind: "set",
					value: splitList(text),
				}),
			};
		}

		/** The master switch, represented as `true`/`false` draft text. */
		const ENABLED_SPEC = {
			field: "enabled",
			format: (value) => (value === true ? "true" : value === false ? "false" : ""),
			parse: (text) => {
				if (text === "true") return { kind: "set", value: true };
				if (text === "false") return { kind: "set", value: false };
				return undefined;
			},
		};

		function buildForm(scope) {
			const form = new SettingsFormModel(scope, [
				ENABLED_SPEC,
				listSpec("order"),
				listSpec("providerPriority"),
			]);
			const state = form.bind(() => ({
				...form.shell(),
				enabled: form.field("enabled"),
				order: form.field("order"),
				providerPriority: form.field("providerPriority"),
			}));
			return { form, state };
		}

		/** Add one non-empty draft to a row list unless it is already present. */
		function appendRow(rows, draft) {
			const value = draft.trim();
			if (value === "" || rows.includes(value)) return rows;
			return [...rows, value];
		}

		/** Move one row to another position. */
		function moveRow(rows, from, to) {
			if (from === to || from < 0 || to < 0 || from >= rows.length || to >= rows.length) return rows;
			const next = rows.slice();
			const [item] = next.splice(from, 1);
			next.splice(to, 0, item);
			return next;
		}

		/** Split `provider/model` into its two halves for display. */
		function splitRoute(text) {
			const cut = String(text).indexOf("/");
			return cut > 0 ? { provider: text.slice(0, cut), model: text.slice(cut + 1) } : { provider: "", model: text };
		}

		/**
		 * A drag-and-drop list editor over a comma-separated settings field.
		 * @param props - field name, title, hint, rows, and the change sinks.
		 * @returns the list editor.
		 */
		function ListEditor(props) {
			const [draft, setDraft] = React.useState("");
			const [dragging, setDragging] = React.useState(-1);
			const [dropping, setDropping] = React.useState(-1);
			const dragFrom = React.useRef(null);
			const disabled = props.disabled;
			const rows = props.rows;
			const optionList = Array.isArray(props.options) ? props.options : [];
			const commit = (next) => { props.onChange(next); };
			const add = () => {
				const next = appendRow(rows, draft);
				if (next !== rows) commit(next);
				setDraft("");
			};
			const remove = (index) => commit(rows.filter((_, i) => i !== index));
			const up = (index) => commit(moveRow(rows, index, index - 1));
			const down = (index) => commit(moveRow(rows, index, index + 1));
			const onDrop = (event, index) => {
				event.preventDefault();
				const from = dragFrom.current ?? Number(event.dataTransfer.getData("text/plain"));
				dragFrom.current = null;
				setDragging(-1);
				setDropping(-1);
				if (Number.isInteger(from)) commit(moveRow(rows, from, index));
			};
			return h(
				"section",
				null,
				h(
					"div",
					{ className: "smf-section-head" },
					h("span", { className: "smf-section-title" }, props.title),
					h("span", { className: "smf-chip" }, `${rows.length} 项`),
					props.note ? h("span", { className: "smf-chip smf-chip-accent" }, props.note) : null,
					h("span", { className: "smf-hint" }, props.hint),
				),
				rows.length === 0
					? h("div", { className: "smf-empty" }, props.empty)
					: rows.map((row, index) => {
						const parts = props.split === "route" ? splitRoute(row) : { provider: "", model: row };
						return h(
							"div",
							{
								key: `${row}-${index}`,
								className: "smf-row",
								"data-dragging": String(dragging === index),
								"data-drop": String(dropping === index && dragging !== index),
								draggable: !disabled,
								onDragStart: (event) => {
									dragFrom.current = index;
									setDragging(index);
									event.dataTransfer.effectAllowed = "move";
									try { event.dataTransfer.setData("text/plain", String(index)); } catch { /* older browsers */ }
								},
								onDragEnd: () => { setDragging(-1); setDropping(-1); },
								onDragOver: (event) => {
									event.preventDefault();
									if (dropping !== index) setDropping(index);
								},
								onDragLeave: () => { setDropping(-1); },
								onDrop: (event) => { if (!disabled) onDrop(event, index); },
							},
							h("span", { className: "smf-index" }, String(index + 1)),
							h("span", { className: "smf-handle", title: "拖动排序" }, "≡"),
							h(
								"span",
								{ className: "smf-body" },
								parts.provider ? h("span", { className: "smf-provider" }, parts.provider) : null,
								h("span", { className: "smf-model" }, parts.model),
							),
							h(
								"span",
								{ className: "smf-actions" },
								h("button", {
									type: "button", className: "smf-btn", disabled: disabled || index === 0,
									title: "上移", "aria-label": `上移 ${row}`,
									onClick: () => { up(index); },
								}, "↑"),
								h("button", {
									type: "button", className: "smf-btn", disabled: disabled || index === rows.length - 1,
									title: "下移", "aria-label": `下移 ${row}`,
									onClick: () => { down(index); },
								}, "↓"),
								h("button", {
									type: "button", className: "smf-btn smf-btn-danger", disabled,
									title: "删除", "aria-label": `删除 ${row}`,
									onClick: () => { remove(index); },
								}, "×"),
							),
						);
					}),
				h(
					"div",
					{ className: "smf-add" },
					h("input", {
						type: "text",
						className: "smf-input",
						value: draft,
						placeholder: props.placeholder,
						disabled,
						list: optionList.length > 0 ? props.optionsId : undefined,
						"aria-label": `新增${props.title}`,
						onChange: (event) => { setDraft(event.target.value); },
						onKeyDown: (event) => { if (event.key === "Enter") { event.preventDefault(); add(); } },
					}),
					optionList.length > 0
						? h(
							"datalist",
							{ id: props.optionsId },
							optionList.map((option) => h("option", { key: option, value: option })),
						)
						: null,
					h("button", {
						type: "button", className: "smf-btn", style: { padding: "5px 12px" }, disabled,
						onClick: add,
					}, "新增"),
				),
			);
		}

		function ConfigPage(props) {
			const state = props.useFailoverForm((value) => value);
			if (props.view === "summary") return "模型调用顺序、厂商顺序与自动切换总开关";

			const configuredOrder = state.order.text;
			const configuredProvider = state.providerPriority.text;
			const disabled = !state.writable || state.saving;

			const [orderRows, setOrderRows] = React.useState(() => splitList(configuredOrder));
			const [providerRows, setProviderRows] = React.useState(() => splitList(configuredProvider));
			const [modelOptions, setModelOptions] = React.useState([]);
			const [planSource, setPlanSource] = React.useState("auto");
			const [planError, setPlanError] = React.useState(false);
			const lastOrderText = React.useRef(configuredOrder);
			const lastProviderText = React.useRef(configuredProvider);

			React.useEffect(() => {
				if (configuredOrder === lastOrderText.current) return;
				lastOrderText.current = configuredOrder;
				const next = splitList(configuredOrder);
				if (configuredOrder !== "") setOrderRows(next);
			}, [configuredOrder]);

			React.useEffect(() => {
				if (configuredProvider === lastProviderText.current) return;
				lastProviderText.current = configuredProvider;
				setProviderRows(splitList(configuredProvider));
			}, [configuredProvider]);

			React.useEffect(() => {
				let cancelled = false;
				fetch(PLAN_ROUTE, { headers: { accept: "application/json" } })
					.then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
					.then((payload) => {
						if (cancelled) return;
						const routes = Array.isArray(payload?.routes) ? payload.routes.filter((route) => typeof route === "string") : [];
						const models = Array.isArray(payload?.models) ? payload.models.filter((route) => typeof route === "string") : [];
						setModelOptions(models);
						setPlanSource(payload?.source === "configured" ? "configured" : "auto");
						setPlanError(false);
						// The Host's live plan is the default list only while `order` is empty.
						if (configuredOrder === "" && routes.length > 0) setOrderRows(routes);
					})
					.catch(() => { if (!cancelled) setPlanError(true); });
				return () => { cancelled = true; };
			}, [configuredOrder]);

			const orderNote = configuredOrder !== ""
				? "已保存的显式顺序"
				: planError
					? "自动发现（保存后固定为显式顺序）"
					: planSource === "configured"
						? "来自配置"
						: "默认顺序（自动发现）";

			const setOrder = (rows) => {
				setOrderRows(rows);
				props.edit("order", rows.join(", "));
			};
			const setProviders = (rows) => {
				setProviderRows(rows);
				props.edit("providerPriority", rows.join(", "));
			};
			// The pickers list only what this profile's configured providers can
			// actually run — the same live discovery the switcher uses.
			const providerOptions = Array.from(
				new Set(modelOptions.map((route) => route.split("/")[0]).filter(Boolean)),
			).sort((left, right) => left.localeCompare(right));

			return h(
				SettingsForm,
				{ labels: LABELS, state, onSave: props.save, onDiscard: props.discard },
				h(
					"div",
					{ className: "smf-panel" },
					h(
						"section",
						{ className: "smf-card smf-head" },
						h(
							"div",
							{ className: "smf-head-text" },
							h("div", { className: "smf-title" }, "启用错误自动切换"),
							h("div", { className: "smf-sub" }, "关闭后，模型请求失败时不会自动切换并续跑。"),
						),
						h(Switch, {
							checked: state.enabled.text === "true",
							disabled,
							label: "启用错误自动切换",
							onChange: (next) => { props.edit("enabled", next ? "true" : "false"); },
						}),
					),
					h(
						"section",
						{ className: "smf-card" },
						h(ListEditor, {
							title: "模型调用顺序",
							split: "route",
							hint: MODEL_HINT,
							note: orderNote,
							rows: orderRows,
							options: modelOptions,
							optionsId: "smart-model-failover-model-options",
							empty: planError ? "无法读取默认顺序；可直接新增路由。" : "正在读取默认顺序…",
							placeholder: "选择或输入 provider/model",
							disabled,
							onChange: setOrder,
						}),
					),
					h(
						"section",
						{ className: "smf-card" },
						h(ListEditor, {
							title: "厂商优先顺序",
							hint: PROVIDER_HINT,
							note: providerRows.length === 0 ? "留空表示自动发现" : "已配置",
							rows: providerRows,
							options: providerOptions,
							optionsId: "smart-model-failover-provider-options",
							empty: "未配置厂商优先级；留空时按自动发现顺序。",
							placeholder: "选择或输入厂商名",
							disabled,
							onChange: setProviders,
						}),
					),
				),
			);
		}

		/**
		 * Mount the bundle configuration page while the Host serves the
		 * plugin's settings namespace.
		 * @param ctx - client plugin lifetime.
		 * @returns nothing; the whileServed effect owns the registration.
		 */
		function apply(ctx) {
			ctx.effect(
				() => {
					const node = ensureStyles();
					return () => { node?.remove(); };
				},
				"dsh-smart-model-failover: settings styles",
			);
			ctx.effect(
				() =>
					ctx.configForms.whileServed([NAMESPACE], () => {
						const { form, state } = buildForm(ctx.configForms.get(NAMESPACE));
						const disposeSlot = ctx.slots.inject("plugins.bundle.config", () =>
							ctx.slots.register(
								{
									name: "plugins.bundle.config",
									key: BUNDLE,
									inject: () => ({ hooks: { failoverForm: state }, ...form.actions() }),
								},
								ConfigPage,
							),
						);
						return () => {
							disposeSlot?.();
							form.dispose();
						};
					}),
				"dsh-smart-model-failover: settings page",
			);
		}

		exports.apply = apply;
		exports.inject = ["slots", "configForms"];
		return module.exports;
	},
});
