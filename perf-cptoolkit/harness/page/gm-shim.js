// ページ側で動く Tampermonkey の代わり。すべての条件で同じものを使う。
// window.__us に、スクリプトごとの同期実行時間とエラーを記録する。
window.__us = {sync: {}, errors: [], started: {}, finished: {}, clipboard: [], gmxhr: 0};

window.__usBoot = (entries) => {
	const us = window.__us;
	const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

	const makeGM = (entry) => {
		const store = new Map(Object.entries(entry.store));
		const listeners = new Map();
		let nextId = 1;
		const info = {
			script: {name: entry.name, version: entry.version, namespace: "perf-harness"},
			scriptHandler: "Tampermonkey",
			version: "5.3.3",
		};
		const getValue = (k, d) => (store.has(k) ? clone(store.get(k)) : d);
		const setValue = (k, v) => {
			const old = store.get(k);
			store.set(k, clone(v));
			for (const l of listeners.values()) if (l.key === k) l.fn(k, old, v, false);
		};
		const addStyle = (css) => {
			const style = document.createElement("style");
			style.textContent = css;
			(document.head || document.documentElement).appendChild(style);
			return style;
		};
		const xhr = (d) => {
			us.gmxhr++;
			const ctrl = new AbortController();
			fetch(`https://gmxhr.invalid/?u=${encodeURIComponent(new URL(d.url, location.href).href)}`, {
				method: d.method || "GET",
				headers: d.headers,
				body: d.data,
				signal: ctrl.signal,
			}).then(async (res) => {
				const text = await res.text();
				let response = text;
				if (d.responseType === "json") try {
					response = JSON.parse(text);
				} catch {
					response = null;
				}
				const r = {status: res.status, statusText: res.statusText, responseText: text, response, finalUrl: d.url, responseHeaders: "", readyState: 4};
				d.onreadystatechange?.(r);
				d.onload?.(r);
				d.onloadend?.(r);
			}).catch((e) => {
				d.onerror?.({error: String(e)});
				d.onloadend?.({});
			});
			return {abort: () => ctrl.abort()};
		};
		const api = {
			GM_info: info,
			GM_getValue: getValue,
			GM_setValue: setValue,
			GM_deleteValue: (k) => store.delete(k),
			GM_listValues: () => [...store.keys()],
			GM_addValueChangeListener: (key, fn) => {
				const id = nextId++;
				listeners.set(id, {key, fn});
				return id;
			},
			GM_removeValueChangeListener: (id) => listeners.delete(id),
			GM_registerMenuCommand: () => nextId++,
			GM_unregisterMenuCommand: () => {},
			GM_setClipboard: (t) => us.clipboard.push(String(t).length),
			GM_notification: () => {},
			GM_openInTab: () => ({close() {}}),
			GM_addStyle: addStyle,
			GM_xmlhttpRequest: xhr,
		};
		api.GM = {
			info,
			getValue: async (k, d) => getValue(k, d),
			setValue: async (k, v) => setValue(k, v),
			deleteValue: async (k) => store.delete(k),
			listValues: async () => [...store.keys()],
			addStyle,
			setClipboard: async (t) => api.GM_setClipboard(t),
			xmlHttpRequest: xhr,
			notification: () => {},
			openInTab: api.GM_openInTab,
			registerMenuCommand: api.GM_registerMenuCommand,
		};
		return api;
	};

	const GM_NAMES = ["GM_info", "GM_getValue", "GM_setValue", "GM_deleteValue", "GM_listValues", "GM_addValueChangeListener",
		"GM_removeValueChangeListener", "GM_registerMenuCommand", "GM_unregisterMenuCommand", "GM_setClipboard",
		"GM_notification", "GM_openInTab", "GM_addStyle", "GM_xmlhttpRequest", "GM"];

	const run = (entry) => {
		const gm = makeGM(entry);
		const t0 = performance.now();
		us.started[entry.id] = t0;
		try {
			let jq;
			if (entry.requires.length) {
				const saved = {$: window.$, jQuery: window.jQuery};
				for (const r of entry.requires) {
					(0, eval)(`${r.code}\n//# sourceURL=userscript://${entry.id}/require/${r.name}`);
				}
				// @require の jQuery はスクリプトの中だけで使う。ページの jQuery は戻す
				if (window.jQuery !== saved.jQuery) {
					jq = window.jQuery;
					window.$ = saved.$;
					window.jQuery = saved.jQuery;
				}
			}
			const params = [...GM_NAMES, "unsafeWindow", ...(jq ? ["$", "jQuery"] : [])];
			// 先頭行に続けて書き、行番号をソースマップと一致させる
			const fn = (0, eval)(`(function(${params.join(",")}){${entry.code}\n})\n//# sourceURL=userscript://${entry.id}/main.user.js`);
			fn.call(window, ...GM_NAMES.map((n) => gm[n]), window, ...(jq ? [jq, jq] : []));
		} catch (e) {
			us.errors.push({id: entry.id, phase: "sync", message: String(e && e.stack || e).slice(0, 500)});
		}
		const t1 = performance.now();
		us.finished[entry.id] = t1;
		us.sync[entry.id] = (us.sync[entry.id] || 0) + (t1 - t0);
	};

	window.addEventListener("error", (ev) => {
		const stack = String(ev.error?.stack || ev.filename || "");
		const m = /userscript:\/\/([^/]+)\//.exec(stack);
		if (m) us.errors.push({id: m[1], phase: "async", message: String(ev.message).slice(0, 300)});
	});
	window.addEventListener("unhandledrejection", (ev) => {
		const stack = String(ev.reason?.stack || "");
		const m = /userscript:\/\/([^/]+)\//.exec(stack);
		if (m) us.errors.push({id: m[1], phase: "promise", message: String(ev.reason).slice(0, 300)});
	});

	const onDcl = (fn) => {
		if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn, {once: true});
		else fn();
	};
	// Tampermonkey の document-start は <html> ができた直後に動く。init script はそれより早いので待つ
	const onRoot = (fn) => {
		if (document.documentElement) return fn();
		const mo = new MutationObserver(() => {
			if (!document.documentElement) return;
			mo.disconnect();
			fn();
		});
		mo.observe(document, {childList: true});
	};
	for (const entry of entries) {
		if (entry.runAt === "document-start") onRoot(() => run(entry));
		else if (entry.runAt === "document-end") onDcl(() => run(entry));
		else onDcl(() => setTimeout(() => run(entry), 0)); // document-idle(既定)と document-body
	}
};
