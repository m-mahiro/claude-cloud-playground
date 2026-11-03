// 条件ごとに、ページへ先に注入するスクリプト(GM_* のシム + UserScript の起動)を組み立てる。
// Tampermonkey の代わりに、どの条件にも同じシムを使う。
import {readFileSync} from "node:fs";
import {loadRequire, matchesUrl} from "./userscript.mjs";

const TRACE_JS = readFileSync(new URL("./page/dom-trace.js", import.meta.url), "utf8");
const SHIM_JS = readFileSync(new URL("./page/gm-shim.js", import.meta.url), "utf8");

export function buildInitScript(condition, url, {trace = false} = {}) {
	const entries = condition.scripts
		.filter((s) => matchesUrl(s, url))
		.map((s) => ({
			id: s.id,
			name: s.name,
			version: s.version,
			runAt: s.runAt,
			store: s.store ?? {},
			requires: s.require.map((u) => ({name: u.split("/").pop(), code: loadRequire(u)})),
			code: s.code,
		}));
	const parts = [
		"(() => { if (window.top !== window) return;",
		trace ? TRACE_JS : "",
		SHIM_JS,
		`window.__usBoot(${JSON.stringify(entries)});`,
		"})();",
	];
	return {script: parts.join("\n"), scripts: entries.map((e) => e.id)};
}
