#!/usr/bin/env bash
# 実際の Tampermonkey での計測。TM_CRX に Tampermonkey の .crx を展開したフォルダを渡す
#   curl -L -o tm.crx "https://clients2.google.com/service/update2/crx?response=redirect&prodversion=131.0&acceptformat=crx2,crx3&x=id%3Ddhdgffkkebhmkfjojejmpbldmpobfkfo%26uc"
#   mkdir tm-ext && (cd tm-ext && unzip -q ../tm.crx)
set -u
cd "$(dirname "$0")"
node harness/tm-measure.mjs --crx "$TM_CRX" --profiles "${TM_PROFILES:-/tmp/cp-perf-tm-profiles}" --n 8 --out results/tm-x1.jsonl
echo TM_DONE
