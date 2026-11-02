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
// 旧スクリプトとの差の検定(Mann-Whitney U、正規近似)
const mwu = (a, b) => {
	const all = [...a.map((v) => [v, 0]), ...b.map((v) => [v, 1])].sort((x, y) => x[0] - y[0]);
	const rk = all.map((_, i) => i + 1);
	for (let i = 0; i < all.length;) {
		let j = i;
		while (j + 1 < all.length && all[j + 1][0] === all[i][0]) j++;
		for (let k = i; k <= j; k++) rk[k] = (i + j) / 2 + 1;
		i = j + 1;
	}
	const n1 = a.length, n2 = b.length;
	const u = all.reduce((acc, [, g], i) => acc + (g === 0 ? rk[i] : 0), 0) - n1 * (n1 + 1) / 2;
	const z = (u - n1 * n2 / 2) / Math.sqrt(n1 * n2 * (n1 + n2 + 1) / 12);
	const t = 1 / (1 + 0.2316419 * Math.abs(z));
	const tail = 0.3989423 * Math.exp(-z * z / 2) * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
	return 2 * tail;
};
for (const r of tmRows) {
	const old = {C_own: "B_own", C_eq: "B_all"}[r.cond];
	if (!old) continue;
	const tot = (c) => tm.filter((x) => x.page === r.page && x.cond === c).map((x) => (x.byBucket.tampermonkey || 0) + (x.byBucket.userscript || 0));
	r.p_vs_old = r2(mwu(tot(old), tot(r.cond)));
}
write("tampermonkey", tmRows);

console.log("wrote", OUT, {cpu: cpu.length, breakdown: breakdown.length, load: load.length, dom: dom.length, idle: idle.length, mem: mem.length, tm: tmRows.length});

// ======== 実際の Tampermonkey での計測(results/tm-*.jsonl) ========
// レポートは、シムでしか測れない DOM の重複アクセスを除き、こちらの値を使う。
{
	const {SourceMap} = await import("./sourcemap.mjs");
	const {matchesUrl} = await import("./userscript.mjs");
	const {loadConditions} = await import("./conditions.mjs");
	const {PAGES: URLS} = await import("./pages.mjs");
	const conds = loadConditions({analysisBuild: true});
	const map = new SourceMap(new URL("../scripts/cptoolkit/CpToolkit.analysis.user.js.map", import.meta.url).pathname);
	const TM_CONDS = ["A", "B_own", "C_own", "B_all", "C_eq"];
	const tmRead = (f) => read(f);
	const cpuRows = tmRead("tm-cpu-x1.jsonl"), memRows = tmRead("tm-memory-x1.jsonl");
	const perf1 = tmRead("tm-perf-x1.jsonl"), perf4 = tmRead("tm-perf-x4.jsonl"), idleRows = tmRead("tm-idle-x1.jsonl");

	// Tampermonkey 上の行から、ソースマップの行へ直して機能を決める
	const ownerCache = new Map();
	const owner = (stack, offset) => {
		const key = `${offset}|${stack}`;
		if (ownerCache.has(key)) return ownerCache.get(key);
		let first = null, found = null;
		for (const f of stack.split(" < ")) {
			const m = /(\d+):(\d+)$/.exec(f);
			if (!m) continue;
			const hit = map.lookup(Number(m[1]) - offset, Number(m[2]));
			if (!hit) continue;
			const src = hit.source.replace(/^(\.\.\/)+/, "");
			first ??= src;
			const fm = /src\/features\/([^/]+)\//.exec(src);
			if (fm) { found = fm[1]; break; }
		}
		if (!found) {
			const lm = /src\/(app|adapters|application|ui|domain|catalog)\//.exec(first ?? "");
			found = lm ? `(core:${lm[1]})` : (first ?? "").startsWith("shared/") ? "(core:shared)" : first ? "(lib)" : "(top-level)";
		}
		ownerCache.set(key, found);
		return found;
	};

	// 動作確認: 各回で、その URL に当てはまるスクリプトが全部動いたか
	const checks = [];
	const all = [...cpuRows, ...memRows, ...perf1, ...perf4, ...idleRows];
	for (const r of all) {
		const expected = conds[r.cond].scripts.filter((s) => matchesUrl(s, URLS[r.page])).map((s) => s.id).sort();
		const ran = r.ran ?? [];
		const missing = expected.filter((id) => !ran.includes(id));
		checks.push({mode: r.mode, throttle: r.throttle, page: r.page, cond: r.cond, expected: expected.length, ran: ran.length, missing: missing.join(",")});
	}
	const bad = checks.filter((c) => c.missing);
	write("tm_checks", [{runs: checks.length, complete: checks.length - bad.length, incomplete: bad.length, failed: ["tm-cpu-x1.jsonl", "tm-memory-x1.jsonl", "tm-perf-x1.jsonl", "tm-perf-x4.jsonl", "tm-idle-x1.jsonl"].reduce((s2, f) => s2 + (existsSync(R + f) ? readFileSync(R + f, "utf8").split("\n").filter((l) => l.includes('"failed"')).length : 0), 0)}]);
	if (bad.length) console.log("incomplete runs:", bad.slice(0, 10));

	const by = (rows, page, cond) => rows.filter((r) => r.page === page && r.cond === cond);
	const usSum = (o) => Object.entries(o ?? {}).filter(([k]) => k.startsWith("us:")).reduce((s2, [, v]) => s2 + v, 0);

	// CPU
	const tmCpu = [];
	for (const page of Object.keys(PAGES)) for (const cond of TM_CONDS) {
		const rs = by(cpuRows, page, cond);
		if (!rs.length) continue;
		const mgr = rs.map((r) => r.byBucket.tampermonkey || 0), us = rs.map((r) => usSum(r.byBucket));
		tmCpu.push({...base(page, cond), manager_ms: r1(median(mgr)), script_ms: r1(median(us)), total_ms: r1(median(rs.map((_, i) => mgr[i] + us[i]))), scripts: rs[0].installed, runs: rs.length});
	}
	for (const r of tmCpu) {
		const old = {C_own: "B_own", C_eq: "B_all"}[r.cond];
		if (!old) continue;
		const tot = (c) => by(cpuRows, r.page, c).map((x) => (x.byBucket.tampermonkey || 0) + usSum(x.byBucket));
		r.p_vs_old = r2(mwu(tot(old), tot(r.cond)));
	}
	write("tm_cpu", tmCpu);

	// CPU の内訳(問題文・解説一覧)
	const tmBd = [];
	for (const page of ["task", "editorial"]) for (const cond of ["B_all", "C_eq"]) {
		const rs = by(cpuRows, page, cond);
		const acc = {};
		for (const r of rs) {
			const one = {"Tampermonkey 自身": r.byBucket.tampermonkey || 0};
			if (cond === "C_eq") {
				for (const [stack, ms] of Object.entries(r.toolkitStacks ?? {})) {
					const o = LABEL(stack ? owner(stack, (r.toolkitLineOffset ?? 0)) : "(top-level)");
					one[o] = (one[o] || 0) + ms;
				}
			} else {
				for (const [k, v] of Object.entries(r.byBucket)) if (k.startsWith("us:")) one[k.slice(3)] = v;
			}
			for (const [k, v] of Object.entries(one)) (acc[k] ??= []).push(v);
		}
		for (const [part, vs] of Object.entries(acc)) {
			const m = median([...vs, ...new Array(rs.length - vs.length).fill(0)]);
			if (m >= 0.1) tmBd.push({...base(page, cond), part, ms: r2(m)});
		}
	}
	write("tm_cpu_breakdown", tmBd);

	// メモリ
	const tmMem = [];
	for (const page of Object.keys(PAGES)) {
		const a = median(by(memRows, page, "A").map((r) => r.afterGc.JSHeapUsedSize / 1048576));
		for (const cond of TM_CONDS) {
			const rs = by(memRows, page, cond);
			if (!rs.length) continue;
			const heap = median(rs.map((r) => r.afterGc.JSHeapUsedSize / 1048576));
			tmMem.push({...base(page, cond), heap_mb: r2(heap), heap_overhead_mb: r2(heap - a), script_kb: Math.round(median(rs.map((r) => usSum(r.heapByBucket) / 1024))), manager_kb: Math.round(median(rs.map((r) => (r.heapByBucket.tampermonkey || 0) / 1024))), runs: rs.length});
		}
	}
	write("tm_memory", tmMem);
	const tmMemBd = [];
	for (const cond of ["B_all", "C_eq"]) {
		const rs = by(memRows, "task", cond);
		const acc = {};
		for (const r of rs) {
			const one = {"Tampermonkey 自身": (r.heapByBucket.tampermonkey || 0) / 1024};
			if (cond === "C_eq") {
				for (const [stack, b] of Object.entries(r.heapToolkitStacks ?? {})) {
					const o = LABEL(stack ? owner(stack, (r.toolkitLineOffset ?? 0)) : "(top-level)");
					one[o] = (one[o] || 0) + b / 1024;
				}
			} else {
				for (const [k, v] of Object.entries(r.heapByBucket)) if (k.startsWith("us:")) one[k.slice(3)] = v / 1024;
			}
			for (const [k, v] of Object.entries(one)) (acc[k] ??= []).push(v);
		}
		for (const [part, vs] of Object.entries(acc)) {
			const m = median([...vs, ...new Array(rs.length - vs.length).fill(0)]);
			if (m >= 1) tmMemBd.push({...base("task", cond), part, kb: r1(m)});
		}
	}
	write("tm_memory_breakdown", tmMemBd);

	// ページ全体の読み込みコスト
	const tmLoad = [];
	for (const [th, rows] of [[1, perf1], [4, perf4]]) for (const page of Object.keys(PAGES)) {
		const a = by(rows, page, "A");
		if (!a.length) continue;
		const med = (rs, f) => median(rs.map(f));
		const task = (r) => r.metrics.TaskDuration * 1000, script = (r) => r.metrics.ScriptDuration * 1000;
		const ls = (r) => (r.metrics.LayoutDuration + r.metrics.RecalcStyleDuration) * 1000;
		for (const cond of TM_CONDS) {
			const rs = by(rows, page, cond);
			if (!rs.length) continue;
			const q = (p) => {
				const x = rs.map(task).sort((m, n) => m - n);
				const pos = (x.length - 1) * p;
				return x[Math.floor(pos)] + (x[Math.ceil(pos)] - x[Math.floor(pos)]) * (pos - Math.floor(pos));
			};
			const row = {...base(page, cond), throttle: th, task_ms: r1(med(rs, task)), task_q1: r1(q(.25)), task_q3: r1(q(.75)),
				task_overhead_ms: r1(med(rs, task) - med(a, task)), script_overhead_ms: r1(med(rs, script) - med(a, script)),
				layout_style_overhead_ms: r1(med(rs, ls) - med(a, ls)), longtask_ms: r1(med(rs, (r) => r.page_.longtasks?.total ?? 0)), runs: rs.length};
			const old = {C_own: "B_own", C_eq: "B_all"}[cond];
			if (old) row.p_vs_old = r2(mwu(by(rows, page, old).map(task), rs.map(task)));
			tmLoad.push(row);
		}
	}
	write("tm_load", tmLoad);

	// 放置時
	const tmIdle = [];
	for (const page of [...new Set(idleRows.map((r) => r.page))]) for (const cond of TM_CONDS) {
		const rs = by(idleRows, page, cond);
		if (!rs.length) continue;
		const per = (k) => median(rs.map((r) => r.idle[k] * 1000 / (r.idleMs / 1000)));
		tmIdle.push({...base(page, cond), task_ms_per_s: r2(per("TaskDuration")), script_ms_per_s: r2(per("ScriptDuration")), runs: rs.length});
	}
	write("tm_idle", tmIdle);
	console.log("tm:", {cpu: tmCpu.length, bd: tmBd.length, mem: tmMem.length, memBd: tmMemBd.length, load: tmLoad.length, idle: tmIdle.length, checks: checks.length, incomplete: bad.length});
}
