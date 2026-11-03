// 比較する条件。各条件は「どのスクリプトを入れ、CP Toolkit の設定をどうするか」で決まる。
import {readdirSync} from "node:fs";
import {join} from "node:path";
import {parseUserscript} from "./userscript.mjs";

const SCRIPTS = new URL("../scripts/", import.meta.url).pathname;
const load = (dir) => readdirSync(join(SCRIPTS, dir))
	.filter((f) => f.endsWith(".user.js"))
	.sort()
	.map((f) => parseUserscript(join(SCRIPTS, dir, f)));

/** 旧スクリプトと CP Toolkit の機能の対応。SOURCES.md の「移植」「派生」「模倣」に基づく。 */
export const LEGACY_TO_FEATURES = {
	// nsubaru さんの旧スクリプト(統合前の最終版)
	AtCoderWidenContainer: ["wide-layout"],
	AtCoderHighlighter: ["statement-highlight"],
	AtCoderMarkdownCopier: ["statement-copy"],
	AtCoderCustomDefaultSubmissions: ["submission-shortcuts"],
	AtCoderListingTasks: ["task-dropdown"],
	AtCoderPerformanceOverlay: ["rating-graph"],
	AtCoderEasyTestForJava: ["easy-test"],
	JavaCodeSubmitter: ["java-submit"],
	// 公開スクリプト
	EasyAccordion: ["hover-menu"],
	QuestionCopier: ["statement-copy"],
	ProblemCopier: ["statement-copy"],
	EfficientLayout: ["efficient-layout"],
	SearchQueryHolder: ["submission-query"],
	LanguageButtons: ["language-buttons"],
	ResultNotifier: ["result-notifier"],
	AverageResult: ["average-result"],
	SubmissionTimer: ["submission-timer"],
	TasksColorizeDuringContest: ["task-status"],
	ViewAllEditorials: ["editorial-list"],
	ContestDescriptionLink: ["top-links"],
	RedirectRecentABC: ["latest-contests"],
	AwcTab: ["latest-contests"],
	GoogleCalender: ["contest-calendar"],
	VirtualTimer: ["virtual-timer"],
	TessokuDifficulty: ["tessoku-difficulty"],
	PerformanceColorizer: ["history-colors"],
};

export const ALL_FEATURES = [
	"wide-layout", "hover-menu", "statement-highlight", "variable-hover", "statement-copy", "efficient-layout",
	"submission-query", "submission-shortcuts", "language-buttons", "source-comments", "result-notifier",
	"clar-notifier", "average-result", "submission-timer", "task-dropdown", "task-status", "editorial-list",
	"top-links", "latest-contests", "contest-calendar", "virtual-timer", "tessoku-difficulty", "rating-graph",
	"history-colors", "local-runner", "java-submit", "easy-test", "paiza-language",
];

function toolkitSettings(enabledFeatures) {
	const set = new Set(enabledFeatures);
	return {
		settings: {
			version: 1,
			features: Object.fromEntries(ALL_FEATURES.map((id) => [id, {enabled: set.has(id), options: {}}])),
		},
	};
}

function featuresOf(scripts) {
	return [...new Set(scripts.flatMap((s) => LEGACY_TO_FEATURES[s.id] ?? []))];
}

export function loadConditions({analysisBuild = false} = {}) {
	const own = load("legacy-nsubaru");
	const pub = load("legacy-public");
	const toolkitFile = analysisBuild ? "CpToolkit.analysis.user.js" : "CpToolkit.user.js";
	const toolkit = parseUserscript(join(SCRIPTS, "cptoolkit", toolkitFile));
	toolkit.id = "CpToolkit";
	for (const s of [...own, ...pub]) {
		if (!LEGACY_TO_FEATURES[s.id]) throw new Error(`unmapped legacy script: ${s.id}`);
	}
	return {
		A: {label: "スクリプトなし", scripts: []},
		B_own: {label: "旧 nsubaru 版 8本", scripts: own},
		C_own: {label: "CP Toolkit(旧8本と同じ機能だけ ON)", scripts: [{...toolkit, store: toolkitSettings(featuresOf(own))}]},
		B_all: {label: "旧スクリプト 26本", scripts: [...own, ...pub]},
		C_eq: {label: "CP Toolkit(旧26本と同じ機能だけ ON)", scripts: [{...toolkit, store: toolkitSettings(featuresOf([...own, ...pub]))}]},
		C_default: {label: "CP Toolkit(既定の設定)", scripts: [{...toolkit, store: {}}]},
	};
}
