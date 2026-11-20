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

		const MODEL_HINT = "按顺序尝试；拖动行或使用 ↑↓ 调整，保存后按此顺序切换。";
		const PROVIDER_HINT = "自动发现时优先尝试的厂商；可新增、拖动或删除。";

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

		const rowStyle = {
			display: "flex",
			alignItems: "center",
			gap: "8px",
			padding: "8px 10px",
			border: "1px solid rgba(127,127,127,0.28)",
			borderRadius: "8px",
			background: "rgba(127,127,127,0.06)",
			marginBottom: "6px",
			cursor: "grab",
		};
		const handleStyle = { userSelect: "none", opacity: 0.7, fontSize: 16, lineHeight: "20px" };
		const smallButtonStyle = {
			border: "1px solid rgba(127,127,127,0.3)",
			background: "transparent",
			borderRadius: "6px",
			padding: "2px 7px",
			cursor: "pointer",
			fontSize: 13,
		};

		/**
		 * A drag-and-drop list editor over a comma-separated settings field.
		 * @param props - field name, title, hint, rows, and the change sinks.
		 * @returns the list editor.
		 */
		function ListEditor(props) {
			const [draft, setDraft] = React.useState("");
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
				if (Number.isInteger(from)) commit(moveRow(rows, from, index));
			};
			return h(
				"section",
				{ style: { marginBottom: "18px" } },
				h("div", { style: { fontWeight: 600, marginBottom: 2 } }, props.title),
				h(
					"div",
					{ style: { fontSize: 12, opacity: 0.7, marginBottom: 8 } },
					props.hint,
					" ",
					props.note ? h("span", { style: { opacity: 0.85 } }, `（${props.note}）`) : null,
				),
				rows.length === 0
					? h(
						"div",
						{ style: { fontSize: 12, opacity: 0.65, padding: "8px 0" } },
						props.empty,
					)
					: rows.map((row, index) =>
						h(
							"div",
							{
								key: `${row}-${index}`,
								style: rowStyle,
								draggable: !disabled,
								onDragStart: (event) => {
									dragFrom.current = index;
									event.dataTransfer.effectAllowed = "move";
									try { event.dataTransfer.setData("text/plain", String(index)); } catch { /* older browsers */ }
								},
								onDragOver: (event) => { event.preventDefault(); },
								onDrop: (event) => { if (!disabled) onDrop(event, index); },
							},
							h("span", { style: handleStyle, title: "拖动排序" }, "≡"),
							h(
								"span",
								{ style: { flex: "1", fontFamily: "monospace", overflowWrap: "anywhere" } },
								row,
							),
							h("button", {
								type: "button", style: smallButtonStyle, disabled: disabled || index === 0,
								title: "上移", "aria-label": `上移 ${row}`,
								onClick: () => { up(index); },
							}, "↑"),
							h("button", {
								type: "button", style: smallButtonStyle, disabled: disabled || index === rows.length - 1,
								title: "下移", "aria-label": `下移 ${row}`,
								onClick: () => { down(index); },
							}, "↓"),
							h("button", {
								type: "button", style: { ...smallButtonStyle, color: "#d9534f" }, disabled,
								title: "删除", "aria-label": `删除 ${row}`,
								onClick: () => { remove(index); },
							}, "×"),
						),
					),
				h(
					"div",
					{ style: { display: "flex", gap: 6, marginTop: 8 } },
					h("input", {
						type: "text",
						value: draft,
						placeholder: props.placeholder,
						disabled,
						list: optionList.length > 0 ? props.optionsId : undefined,
						"aria-label": `新增${props.title}`,
						style: {
							flex: "1", padding: "6px 8px", borderRadius: "6px",
							border: "1px solid rgba(127,127,127,0.35)", background: "transparent",
							color: "inherit",
						},
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
						type: "button", style: { ...smallButtonStyle, padding: "5px 10px" }, disabled,
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
					null,
					h(
						"div",
						{ style: { display: "flex", alignItems: "center", gap: "12px", margin: "0 0 16px" } },
						h(
							"div",
							{ style: { flex: "1" } },
							h("div", { style: { fontWeight: 600 } }, "启用错误自动切换"),
							h("div", { style: { fontSize: 12, opacity: 0.7, marginTop: 2 } }, "关闭后，模型请求失败时不会自动切换并续跑。"),
						),
						h(Switch, {
							checked: state.enabled.text === "true",
							disabled,
							label: "启用错误自动切换",
							onChange: (next) => { props.edit("enabled", next ? "true" : "false"); },
						}),
					),
					h(ListEditor, {
						title: "模型调用顺序",
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
