// results/summary.json と生データから、レポートに載せる表(JSON の行の配列)を書き出す。
//   node harness/export.mjs  → results/report/*.json
import {mkdirSync, readFileSync, writeFileSync, existsSync} from "node:fs";

const R = new URL("../results/", import.meta.url).pathname;
const OUT = R + "report/";
mkdirSync(OUT, {recursive: true});
const s = JSON.parse(readFileSync(R + "summary.json", "utf8"));
const read = (f) => existsSync(R + f) ? readFileSync(R + f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => !r.failed) : [];
const median = (a) => {
	const x = [...a].sort((p, q) => p - q);
	const m = (x.length - 1) / 2;
	return (x[Math.floor(m)] + x[Math.ceil(m)]) / 2;
};
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;

const PAGES = {
	top: "トップ", contests: "コンテスト一覧", contest: "コンテストのトップ", tasks: "問題一覧", task: "問題文",
	editorial: "解説一覧", user: "ユーザー", history: "コンテスト成績表", tessoku: "鉄則本の問題一覧",
};
const CONDS = {
	A: "スクリプトなし", B_own: "旧 nsubaru 版 8本", C_own: "CP Toolkit(旧8本と同じ機能)",
	B_all: "旧スクリプト 26本", C_eq: "CP Toolkit(旧26本と同じ機能)", C_default: "CP Toolkit(既定の設定)",
};
const base = (page, cond) => ({page, page_name: PAGES[page], cond, cond_name: CONDS[cond]});
const write = (name, rows) => writeFileSync(OUT + name + ".json", JSON.stringify(rows));

// 1. CPU プロファイル: UserScript に帰属する CPU 時間(読み込み〜3秒後)
const SHIM = ["run", "onDcl", "onRoot", "__usBoot"];
const prof = read("profile-x1.jsonl");
const cpu = [];
for (const page of Object.keys(PAGES)) for (const cond of Object.keys(CONDS)) {
	const rs = prof.filter((r) => r.page === page && r.cond === cond);
	if (!rs.length) continue;
	const run = rs.map((r) => Object.entries(r.byScript).filter(([k]) => k.startsWith("us:")).reduce((a, [, v]) => a + v, 0));
	const boot = rs.map((r) => SHIM.reduce((a, k) => a + (r.byScript[k] || 0), 0));
	cpu.push({...base(page, cond), run_ms: r1(median(run)), load_ms: r1(median(boot)), total_ms: r1(median(rs.map((_, i) => run[i] + boot[i]))), runs: rs.length});
}
write("cpu_profile", cpu);

// 2. 内訳: 問題文と解説一覧で、旧スクリプトごと / CP Toolkit の機能ごと
const LABEL = (k) => k.replace(/^\(core:(.+)\)$/, "共通部分($1)").replace(/^\((unknown|top-level)\)$/, "トップレベル").replace(/^\(lib\)$/, "ライブラリ");
const breakdown = [];
for (const page of ["task", "editorial"]) {
	for (const [cond, key] of [["B_all", "perScript"], ["C_eq", "perFeature"]]) {
		const src = s.profile[page][cond][key];
		for (const [name, ms] of Object.entries(src)) if (ms >= 0.05) breakdown.push({...base(page, cond), part: LABEL(name), ms: r2(ms)});
		const bootRow = cpu.find((r) => r.page === page && r.cond === cond);
		breakdown.push({...base(page, cond), part: "コードの読み込み(eval)", ms: r2(bootRow.load_ms)});
	}
}
write("cpu_breakdown", breakdown);

// 3. ページ全体の読み込みコスト(CDP Performance.getMetrics)
const load = [];
for (const [th, key] of [[1, "perfX1"], [4, "perfX4"]]) {
	for (const page of Object.keys(PAGES)) {
		const b = s[key].pages[page]?.byCond;
		if (!b) continue;
		for (const cond of Object.keys(CONDS)) {
			const x = b[cond];
			if (!x) continue;
			load.push({
				...base(page, cond), throttle: th,
				task_ms: r1(x.TaskDuration.median), task_q1: r1(x.TaskDuration.q1), task_q3: r1(x.TaskDuration.q3),
				task_overhead_ms: r1(x.TaskDuration.median - b.A.TaskDuration.median),
				script_overhead_ms: r1(x.ScriptDuration.median - b.A.ScriptDuration.median),
				layout_style_overhead_ms: r1(x.LayoutDuration.median + x.RecalcStyleDuration.median - b.A.LayoutDuration.median - b.A.RecalcStyleDuration.median),
				sync_ms: r1(x.UserscriptSyncMs.median),
				runs: x.TaskDuration.n,
			});
		}
	}
}
write("load_metrics", load);

// 4. 検定(旧 vs CP Toolkit、ページ全体の TaskDuration)
const tests = [];
for (const [th, key] of [[1, "perfX1"], [4, "perfX4"]]) for (const page of Object.keys(PAGES)) {
	for (const pair of ["B_own_vs_C_own", "B_all_vs_C_eq"]) {
		const c = s[key].pages[page]?.comparisons?.[pair]?.TaskDuration;
		if (!c) continue;
		tests.push({page, page_name: PAGES[page], throttle: th, pair, diff_ms: r1(c.diff), p: r2(c.p), cliffs_delta: r2(c.cliffsDelta)});
	}
}
write("load_tests", tests);

// 5. DOM への重複アクセス
const dom = [];
for (const page of Object.keys(PAGES)) for (const cond of Object.keys(CONDS)) {
	const t = s.trace[page]?.[cond];
	if (!t) continue;
	dom.push({
		...base(page, cond), elements: t.elementsTouched, ops: t.totalOps, repeated: t.repeatedSameKind,
		shared: t.elementsByMultipleOwners, shared_write: t.elementsWrittenByMultipleOwners, forced: t.forcedLayoutSuspects,
		queries: t.queryCalls, qsa_nodes: t.nodesScannedByQuerySelectorAll, observers: t.mutationObserversSubtree,
		listeners: t.addEventListener,
	});
}
write("dom_access", dom);

// 6. 放置時
const idle = [];
for (const page of Object.keys(s.idle)) for (const cond of Object.keys(CONDS)) {
	const x = s.idle[page][cond];
	if (!x) continue;
	idle.push({...base(page, cond), task_ms_per_s: r2(x.taskMsPerSec.median), script_ms_per_s: r2(x.scriptMsPerSec.median)});
}
write("idle", idle);

// 7. メモリ(GC 後)
const mem = [];
for (const page of Object.keys(PAGES)) for (const cond of Object.keys(CONDS)) {
	const x = s.memory?.[page]?.[cond];
	const a = s.memory?.[page]?.A;
	if (!x || !a) continue;
	mem.push({
		...base(page, cond), heap_mb: r2(x.heapAfterGcMB.median), heap_overhead_mb: r2(x.heapAfterGcMB.median - a.heapAfterGcMB.median),
		script_data_kb: Math.round(x.userscriptKB.median), script_code_kb: Math.round(x.scriptCodeKB.median),
		nodes: x.domNodes.median, listeners: x.listeners.median, runs: x.heapAfterGcMB.n,
	});
}
write("memory", mem);

const memParts = [];
for (const page of ["task"]) for (const [cond, key] of [["B_all", "perScript"], ["C_eq", "perFeature"]]) {
	const x = s.memory?.[page]?.[cond];
	if (!x) continue;
	for (const [name, kb] of Object.entries(x[key])) if (kb >= 1) memParts.push({...base(page, cond), part: LABEL(name), kb: r1(kb)});
	memParts.push({...base(page, cond), part: "読み込んだコード", kb: r1(x.scriptCodeKB.median)});
}
write("memory_breakdown", memParts);
// 8. 実際の Tampermonkey での CPU 時間(Tampermonkey 自身 + UserScript 本体)
const tm = read("tm-x1.jsonl");
const tmRows = [];
for (const page of Object.keys(PAGES)) for (const cond of Object.keys(CONDS)) {
	const rs = tm.filter((r) => r.page === page && r.cond === cond);
	if (!rs.length) continue;
	const mgr = rs.map((r) => r.byBucket.tampermonkey || 0);
	const us = rs.map((r) => r.byBucket.userscript || 0);
	tmRows.push({
		...base(page, cond), manager_ms: r1(median(mgr)), script_ms: r1(median(us)), total_ms: r1(median(rs.map((_, i) => mgr[i] + us[i]))),
		task_ms: r1(median(rs.map((r) => r.metrics.TaskDuration * 1000))), scripts: rs[0].installed, runs: rs.length,
	});
}
write("tampermonkey", tmRows);

console.log("wrote", OUT, {cpu: cpu.length, breakdown: breakdown.length, load: load.length, dom: dom.length, idle: idle.length, mem: mem.length, tm: tmRows.length});
