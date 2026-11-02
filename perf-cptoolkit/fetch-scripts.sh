#!/usr/bin/env bash
# 比較に使うスクリプトを集め直す。第三者のスクリプトにはライセンスの表記がないものもあるので、
# リポジトリには入れず、ここから取得する。取得した版は scripts.lock と照合する。
set -euo pipefail
cd "$(dirname "$0")"
TOOLKIT_COMMIT="${TOOLKIT_COMMIT:-$(cat cptoolkit-commit.txt)}"
WORK="${WORK:-$(mktemp -d)}"
mkdir -p scripts/legacy-nsubaru scripts/legacy-public scripts/cptoolkit scripts/requires

git clone -q https://github.com/nsubaru11/competitive-programming-tools.git "$WORK/cpt"
cd "$WORK/cpt"
# 旧スクリプトは「更新を終了する」変更(7c4fc38)の直前の最終版を使う
for f in AtCoderCustomDefaultSubmissions AtCoderEasyTestForJava AtCoderHighlighter AtCoderListingTasks \
	AtCoderMarkdownCopier AtCoderPerformanceOverlay AtCoderWidenContainer JavaCodeSubmitter; do
	git show "7c4fc38^:userscripts/$f/dist/$f.user.js" > "$OLDPWD/scripts/legacy-nsubaru/$f.user.js"
done
git checkout -q "$TOOLKIT_COMMIT"
cp userscripts/CpToolkit/dist/CpToolkit.user.js "$OLDPWD/scripts/cptoolkit/"
# 帰属の解析用に、ソースマップ付き・整形なしの版も作る(動作は配布物と同じ)
bun install >/dev/null
cd userscripts
cp build.ts build-analysis.ts
sed -i 's|\t\tminify: false,|\t\tminify: false,\n\t\tsourcemap: "external",|; s|\tawait formatUserscriptOutput(outfile, banner, await loadNotices(name));|\t// analysis build|' build-analysis.ts
bun run data:types >/dev/null
bun build-analysis.ts CpToolkit >/dev/null
cp CpToolkit/dist/CpToolkit.user.js "$OLDPWD/scripts/cptoolkit/CpToolkit.analysis.user.js"
cp CpToolkit/dist/CpToolkit.user.js.map "$OLDPWD/scripts/cptoolkit/CpToolkit.analysis.user.js.map"
cd "$OLDPWD"

gf() { curl -fsSL -o "scripts/legacy-public/$1.user.js" "https://update.greasyfork.org/scripts/$2.user.js"; }
gf EasyAccordion 532617
gf QuestionCopier 597743
gf ProblemCopier 565854
gf EfficientLayout 453117
gf SearchQueryHolder 460696
gf LanguageButtons 421663
gf ResultNotifier 371225
gf AverageResult 429155
gf SubmissionTimer 451696
gf TasksColorizeDuringContest 426049
gf ViewAllEditorials 416554
gf ContestDescriptionLink 579801
gf RedirectRecentABC 508772
gf AwcTab 566748
gf GoogleCalender 390758
gf TessokuDifficulty 453352
gf PerformanceColorizer 371693
curl -fsSL -o scripts/legacy-public/VirtualTimer.user.js https://raw.githubusercontent.com/ocha98/AtCoderVirtualTimer/HEAD/src/index.js

grep -h '@require' scripts/legacy-*/*.js | awk '{print $3}' | sort -u | while read -r u; do
	curl -fsSL -o "scripts/requires/$(echo "$u" | sed 's|https\?://||; s|[/:]|_|g')" "$u"
done

# 版の照合。Greasy Fork 側が更新されていれば差分が出る
while read -r hash _ path; do
	actual=$(sha256sum "$path" | cut -c1-16)
	[ "$actual" = "$hash" ] || echo "changed since the measurement: $path"
done < scripts.lock
