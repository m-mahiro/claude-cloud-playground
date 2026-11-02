# CP Toolkit 統合の性能検証

[nsubaru11/competitive-programming-tools](https://github.com/nsubaru11/competitive-programming-tools) の CP Toolkit(28 機能を 1 本にまとめた UserScript)と、統合前の UserScript 群を同じ条件で動かし、CPU 時間・DOM 走査・要素への重複アクセスを比べるハーネス。

## 比較する条件

| 条件 | 中身 |
|---|---|
| `A` | スクリプトなし(基準) |
| `B_own` | 統合前の nsubaru 版 8 本(`7c4fc38^` の最終版) |
| `C_own` | CP Toolkit。`B_own` と同じ機能だけ ON |
| `B_all` | `B_own` + SOURCES.md の「派生/模倣」元の公開スクリプト 18 本(計 26 本) |
| `C_eq` | CP Toolkit。`B_all` と同じ機能だけ ON |
| `C_default` | CP Toolkit の既定の設定 |

対応表は `harness/conditions.mjs` の `LEGACY_TO_FEATURES`。Chrome 拡張(Statement Lens、comfortable-atcoder)は UserScript ではないので含めない。

## 仕組み

- **ページの固定**: 1 回だけ実際のサイトから取得して `fixtures/` に保存し、計測ではそれだけを返す(`harness/fixtures.mjs`)。広告・解析系は全条件で遮断。
- **Tampermonkey の代わり**: `harness/page/gm-shim.js`。`GM_*` を実装し、`@match`/`@exclude`/`@run-at`/`@require` に従って起動する。全条件で同じものを使うので、Tampermonkey 自体の負荷(スクリプト本数に比例する分)は含まれない。
- **計測**(`harness/measure.mjs`)
  - `perf`: CDP `Performance.getMetrics`(TaskDuration・ScriptDuration・Layout・RecalcStyle ほか)、Long Task、UserScript の同期実行時間
  - `idle`: 読み込み後に放置した間の CPU 時間
  - `profile`: CPU プロファイル(100µs 間隔)をスクリプトごと、CP Toolkit は機能ごとに集計(ソースマップで `src/features/*` へ対応付け)
  - `memory`: GC を2回かけた後のヒープ(`JSHeapUsedSize`)と DOM カウンタ。サンプリングヒーププロファイラ(1KB 間隔)で、生き残ったメモリを確保したスクリプトごと(CP Toolkit は機能ごと)に集計
  - `trace`: DOM API を包んで、要素ごとに「誰が・何を・何回」したかを記録(`harness/page/dom-trace.js`)。負荷が大きいので時間の計測とは別の回
- **集計**: `harness/analyze.mjs` → `results/summary.json`。中央値・四分位範囲、Mann-Whitney U 検定、Cliff の δ。

## 再現

```bash
./fetch-scripts.sh                     # 比較対象のスクリプトを取得(scripts.lock と照合)
node harness/measure.mjs --mode record  # ページを録画
./run-all.sh                           # 全計測(直列。約 2.5 時間)
node harness/analyze.mjs
```

Chromium と Playwright が必要。
