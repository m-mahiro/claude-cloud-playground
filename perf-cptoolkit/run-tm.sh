#!/usr/bin/env bash
# 実際の Tampermonkey での計測。TM_CRX に Tampermonkey の .crx を展開したフォルダを渡す
#   curl -L -o tm.crx "https://clients2.google.com/service/update2/crx?response=redirect&prodversion=131.0&acceptformat=crx2,crx3&x=id%3Ddhdgffkkebhmkfjojejmpbldmpobfkfo%26uc"
#   mkdir tm-ext && (cd tm-ext && unzip -q ../tm.crx)
# ブラウザを起動し直すとスクリプトが動かなくなるので、全モードを1回の起動で続けて測る(約3時間)
set -u
cd "$(dirname "$0")"
node harness/tm-measure.mjs --crx "$TM_CRX" --profiles "${TM_PROFILES:-/tmp/cp-perf-tm-profiles}" \
	--plan cpu:8,memory:5,perf:10,perf:6:4,idle:3 --out results/tm
echo TM_DONE
