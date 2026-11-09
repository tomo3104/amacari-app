// ==UserScript==
// @name         PayPay Flea Market ASIN Checker
// @namespace    http://tampermonkey.net/
// @version      3.3
// @description  PayPayフリマ出品中商品をlist.json(pmax)と照合して仕入れ候補を表示（ブランドID指定検索＋新着順ソート対応・実行進捗ログ(mfr_timing)＋完了時の入念調査自動連鎖に対応・メルカリ側からの自動連鎖起動(?auto_research=)に対応・カテゴリ巡回ボタン追加(2026-10-24・manufacturersシートとは別管理)・売り切れ深堀り分析ボタン追加(2026-11-03)・リピート検索(高速・実験)ボタン追加(2026-11-09)）
// @match        https://paypayfleamarket.yahoo.co.jp/*
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @updateURL    https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/paypay_asin_checker.user.js
// @downloadURL  https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/paypay_asin_checker.user.js
// ==/UserScript==

(function () {
    'use strict';

    const SERVER_URL   = 'http://localhost:8766/check-mercari';
    const MFR_URL      = 'http://localhost:8766/get-manufacturers';
    // 2026-10-24追加：カテゴリ巡回の対象はmanufacturersシート（enabled列をメルカリの
    // 自動クロールと共有）には混ぜず、完全に別ファイル・別エンドポイントで管理する。
    // 混ぜると「ALL」グループ実行時にメルカリ側がPayPayフリマのURLを開きに行ってしまい、
    // 毎晩の自動化を壊すリスクがあったため（ユーザー指摘で発覚）。
    const CATEGORY_URL = 'http://localhost:8766/get-paypay-categories';
    const MAX_PAGE   = 20; // 最大20ページ = 2000件/メーカー
    // 2026-09-27追加：ブランドID(yahoo_brand_id)未設定のメーカーはPayPayの実行対象から外す。
    // ID指定が無いとメーカー名のキーワード検索になり、同名の別業種の商品が混ざる。
    // 9/20以降の実データ（別物判定の集計）で、ID設定あり=別物率7.2%・採用2.3%に対し、
    // ID未設定=別物率28.8%・採用0.3%（393件中1件）と差が明確だったため。
    // 戻したくなったらfalseにすれば従来通り全メーカーを対象にする。
    const REQUIRE_BRAND_ID = true;
    const EXCLUDE_KW = ['開封済み', '破れ', 'ダメージ', '傷あり', '汚れあり', '水没', 'ジャンク'];
    // 2026-10-24追加：巡回規模を94→127社に拡大した直後、ユーザーがPayPayフリマを
    // 手動精査しようとしたらアクセス遮断（一時的・時間経過で解除）に遭遇した。
    // ページ間/メーカー間の間隔が今の規模には短すぎた可能性が高いため広げる。
    const PAGE_SLEEP_MS = 800;   // 旧300ms
    const MFR_SLEEP_MS  = 1500;  // 旧500ms

    // ===== UI =====
    const container = document.createElement('div');
    container.style.cssText = `
        position:fixed; bottom:20px; left:20px; z-index:99999;
        display:flex; flex-direction:column; align-items:flex-start; gap:8px;
    `;
    const statusEl = document.createElement('div');
    statusEl.style.cssText = `
        background:rgba(0,0,0,0.78); color:#fff; padding:6px 14px;
        border-radius:6px; font-size:13px; display:none; max-width:300px;
    `;
    const batchBtn = document.createElement('button');
    batchBtn.textContent = 'PPフリマ リサーチ';
    batchBtn.style.cssText = `
        padding:12px 22px; background:#9C27B0; color:#fff;
        border:none; border-radius:6px; font-size:14px;
        cursor:pointer; box-shadow:0 2px 6px rgba(0,0,0,0.3);
    `;
    const stopBtn = document.createElement('button');
    stopBtn.textContent = '中止';
    stopBtn.style.cssText = `
        padding:12px 22px; background:#555; color:#fff;
        border:none; border-radius:6px; font-size:14px;
        cursor:pointer; box-shadow:0 2px 6px rgba(0,0,0,0.3); display:none;
    `;
    // 2026-10-24追加：カテゴリ巡回ボタン（ブランドIDが無い新規メーカー発掘用。
    // manufacturersシートとは独立したpaypay_category_targets.jsonを巡回する）。
    const catBtn = document.createElement('button');
    catBtn.textContent = 'PPフリマ カテゴリ巡回';
    catBtn.style.cssText = `
        padding:12px 22px; background:#6A1B9A; color:#fff;
        border:none; border-radius:6px; font-size:14px;
        cursor:pointer; box-shadow:0 2px 6px rgba(0,0,0,0.3);
    `;
    // 2026-11-03追加：メルカリ側の「深堀り分析」と同じ目的（売り切れ全件読み・
    // 仕入れ対象率とリピート型番の調査）をPPフリマでも行うためのボタン。
    const deepScanBtn = document.createElement('button');
    deepScanBtn.textContent = '深堀り分析（売り切れ）';
    deepScanBtn.style.cssText = 'padding:8px 14px; background:#555; color:#fff; border:none; border-radius:8px; font-size:12px; font-weight:600; cursor:pointer; box-shadow:0 2px 6px rgba(0,0,0,0.3);';
    const deepScanMultiBtn = document.createElement('button');
    deepScanMultiBtn.textContent = '深堀り分析（複数メーカー）';
    deepScanMultiBtn.style.cssText = 'padding:8px 14px; background:#333; color:#fff; border:none; border-radius:8px; font-size:12px; font-weight:600; cursor:pointer; box-shadow:0 2px 6px rgba(0,0,0,0.3);';
    // 2026-11-08追加：メルカリ側と同じ「リピート検索」（確定済み型番リストを能動的に
    // キーワード検索）。PPフリマのキーワード検索は曖昧なメーカー名だと別物混入率が
    // メルカリの約3倍という実測結果があるが（上のbrandIds優先の理由を参照）、型番は
    // メーカー名よりずっと固有性が高く、かつサーバー側のfind_matches()で型番の正確な
    // 一致判定を別途行うため、ここでの多少のノイズが誤ヒットに直結するリスクは低いと判断。
    const repeatSearchBtn = document.createElement('button');
    repeatSearchBtn.textContent = 'リピート検索';
    repeatSearchBtn.style.cssText = `
        padding:12px 22px; background:#00796B; color:#fff;
        border:none; border-radius:6px; font-size:14px;
        cursor:pointer; box-shadow:0 2px 6px rgba(0,0,0,0.3);
    `;
    // 2026-11-08追加：メルカリ側のリピート検索(高速・実験)と同じ発想（並列フェッチで
    // 短縮を試す実験版）。PayPayフリマ側のレート制限の厳しさは未検証のため、
    // まずは小規模テスト（search_queueシートに数件貼って並列2）から試すこと。
    // 安定版runRepeatSearchPP()は一切変更していないので、何かあればそちらに戻せる。
    const repeatSearchFastBtn = document.createElement('button');
    repeatSearchFastBtn.textContent = 'リピート検索(高速・実験)';
    repeatSearchFastBtn.style.cssText = 'padding:8px 14px; background:#004D40; color:#fff; border:none; border-radius:8px; font-size:12px; font-weight:600; cursor:pointer; box-shadow:0 2px 6px rgba(0,0,0,0.3);';
    container.appendChild(statusEl);
    container.appendChild(batchBtn);
    container.appendChild(catBtn);
    container.appendChild(repeatSearchBtn);
    container.appendChild(repeatSearchFastBtn);
    container.appendChild(deepScanBtn);
    container.appendChild(deepScanMultiBtn);
    container.appendChild(stopBtn);
    document.body.appendChild(container);

    let running = false;

    function updateStatus(msg) { statusEl.style.display = 'block'; statusEl.textContent = msg; }
    function setRunningUI(on) {
        batchBtn.style.display = on ? 'none'  : 'block';
        catBtn.style.display   = on ? 'none'  : 'block';
        repeatSearchBtn.style.display = on ? 'none' : 'block';
        repeatSearchFastBtn.style.display = on ? 'none' : 'block';
        deepScanBtn.style.display = on ? 'none' : 'block';
        deepScanMultiBtn.style.display = on ? 'none' : 'block';
        stopBtn.style.display  = on ? 'block' : 'none';
    }
    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    // ===== PayPayフリマ API fetch（出品中・新品・価格帯はmfrURLから取得）=====
    // 2026-08-31追加：yahooBrandIdが分かっているメーカーはbrandIds指定で検索する
    // （キーワード検索だと同名異業種の商品が混入するため。実測でASIN不一致率が
    // メルカリの約3倍だった精度問題への対策）。無ければ従来のキーワード検索にフォールバック。
    // sort=openTime&order=desc（新着順）も追加：指定無しだと新着優先にならず、
    // 取得件数の上限内で古い出品ばかり拾ってしまうことが実測で判明したため。
    async function fetchPayPayItems(mfrName, priceMin, priceMax, yahooBrandId, genreCategoryId) {
        const allItems = {};
        let offset = 0;
        let totalAvailable = null;

        for (let page = 0; page < MAX_PAGE; page++) {
            const params = new URLSearchParams({
                minPrice: String(priceMin),
                maxPrice: String(priceMax),
                results:  '100',
                offset:   String(offset),
                sort:     'openTime',
                order:    'desc',
            });
            // 2026-10-24追加：カテゴリ巡回用。genreCategoryIdが指定された時はそちらを
            // 優先する（ブランドID・キーワード検索と排他）。実データで動作確認済み
            // （/api/v1/search?genreCategoryIds={id}で存在しないIDは0件・実在IDは
            // そのジャンルの商品のみ返ることを確認済み）。
            if (genreCategoryId) {
                params.append('genreCategoryIds', genreCategoryId);
            } else if (yahooBrandId) {
                params.append('brandIds', yahooBrandId);
            } else {
                params.append('query', mfrName);
            }
            params.append('itemStatuses', 'NEW');
            params.append('statuses', 'OPEN');
            const url = `https://paypayfleamarket.yahoo.co.jp/api/v1/search?${params}`;

            const res = await fetch(url, { credentials: 'include' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();

            if (totalAvailable === null) totalAvailable = data.totalResultsAvailable || 0;

            const pageItems = data.items || [];
            pageItems.forEach(item => {
                if (!item.id || !item.title || item.price == null) return;
                if (item.itemStatus && item.itemStatus !== 'OPEN') return; // 売り切れ除外（APIフィルタ非機能のためクライアント側で対処）
                if (item.condition !== 'new') return;
                if (item.isBulkPurchaseItem) return;
                if (EXCLUDE_KW.some(kw => item.title.includes(kw))) return;
                allItems[item.id] = {
                    name:  item.title,
                    price: String(item.price),
                    url:   `https://paypayfleamarket.yahoo.co.jp/item/${item.id}`,
                    image: item.thumbnailImageUrl || item.imageUrl || '',
                    _page: page + 1,
                };
            });

            const returned = data.totalResultsReturned || pageItems.length;
            offset += returned;
            if (offset >= totalAvailable || returned === 0) break;
            await sleep(PAGE_SLEEP_MS);
        }
        return allItems;
    }

    // ===== 深堀り分析（売り切れ・サルベージリサーチ）=====
    // 2026-11-03追加：mercari_asin_checker.user.jsの深堀り分析と同じ目的。
    // PPフリマAPIは「statuses=OPEN」を指定しても実際には売り切れ商品も返ってくる
    // （fetchPayPayItems内のコメント参照：APIフィルタが非機能のためクライアント側で
    // item.itemStatus!=='OPEN'を弾いている）。つまりAPI自体は既に売り切れ商品を
    // 返してきているので、その除外条件を反転するだけで売り切れ全件スキャンが作れる。
    // hitsシートには保存しない（dry_run=trueでサーバーに照合だけさせる）。
    const DEEP_SCAN_PP_MAX_PAGE    = 500;  // 500p×100件 = 最大50,000件
    const DEEP_SCAN_PP_BATCH_PAGES = 10;

    // 2026-11-03修正：メーカー(ブランドID)版とカテゴリ版で丸ごと重複実装しないよう、
    // 検索条件を明示的なオプションに切り出した。genreCategoryIdがあればカテゴリ巡回
    // (runCategoryBatchFetchと同じ優先順位：genreCategoryId > yahooBrandId > キーワード)。
    async function runDeepScanPayPay({ makerNameRaw, priceMin = 1000, priceMax = 20000, yahooBrandId, genreCategoryId }) {
        const makerName = `${makerNameRaw} [Yahoo]`; // メルカリ側の深堀りログと混同しないよう明示タグ
        const sessionId  = new Date().toISOString().replace(/[:.]/g, '-');
        let offset        = 0;
        let totalAvailable = null;
        let pending        = [];
        let totalItems     = 0;
        let totalMatches   = 0;
        let totalNewCands  = 0;
        const modelCount   = new Map();
        let pagesFetched    = 0;
        let stoppedByError  = '';

        async function flushBatch() {
            if (pending.length === 0) return;
            const itemList = pending;
            pending = [];
            const result = await new Promise(resolve => {
                GM_xmlhttpRequest({
                    method: 'POST', url: SERVER_URL,
                    headers: { 'Content-Type': 'application/json' },
                    data: JSON.stringify({ items: itemList, maker: makerName, dry_run: true, deep_scan_session: sessionId }),
                    timeout: 120000,
                    onload:  res => { try { resolve(JSON.parse(res.responseText)); } catch(e) { resolve({}); } },
                    ontimeout: () => resolve({}),
                    onerror:   () => resolve({ _serverDown: true }),
                });
            });
            if (result._serverDown) throw new Error('サーバー未起動');
            totalMatches  += (result.matches || []).length;
            totalNewCands += result.new_candidates_count || 0;
            (result.matches || []).forEach(m => {
                modelCount.set(m.model, (modelCount.get(m.model) || 0) + 1);
            });
        }

        updateStatus(`[深堀り分析] ${makerName} 売り切れページを読み込み中...`);

        for (let page = 0; page < DEEP_SCAN_PP_MAX_PAGE; page++) {
            if (!running) break;
            const params = new URLSearchParams({
                minPrice: String(priceMin), maxPrice: String(priceMax),
                results: '100', offset: String(offset), sort: 'openTime', order: 'desc',
            });
            if (genreCategoryId) params.append('genreCategoryIds', genreCategoryId);
            else if (yahooBrandId) params.append('brandIds', yahooBrandId);
            else params.append('query', makerNameRaw);
            params.append('itemStatuses', 'NEW');
            const url = `https://paypayfleamarket.yahoo.co.jp/api/v1/search?${params}`;

            let data;
            try {
                const res = await fetch(url, { credentials: 'include' });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                data = await res.json();
            } catch (e) {
                stoppedByError = e.message;
                break;
            }
            pagesFetched = page + 1;
            if (totalAvailable === null) totalAvailable = data.totalResultsAvailable || 0;

            const pageItems = (data.items || []).filter(item => {
                if (!item.id || !item.title || item.price == null) return false;
                if (!item.itemStatus || item.itemStatus === 'OPEN') return false; // 出品中は対象外、売り切れのみ採用
                if (item.condition !== 'new') return false;
                if (item.isBulkPurchaseItem) return false;
                if (EXCLUDE_KW.some(kw => item.title.includes(kw))) return false;
                return true;
            });
            pageItems.forEach(item => {
                totalItems++;
                pending.push({
                    name: item.title, price: String(item.price),
                    url: `https://paypayfleamarket.yahoo.co.jp/item/${item.id}`,
                    image: item.thumbnailImageUrl || item.imageUrl || '',
                    created: item.openTime || null,
                });
            });

            updateStatus(`[深堀り分析] ${makerName} p${pagesFetched} 収集${totalItems}件 仕入対象${totalMatches}件（照合中…）`);

            if (page % DEEP_SCAN_PP_BATCH_PAGES === DEEP_SCAN_PP_BATCH_PAGES - 1) {
                try { await flushBatch(); } catch (e) { stoppedByError = e.message; break; }
                updateStatus(`[深堀り分析] ${makerName} p${pagesFetched} 収集${totalItems}件 仕入対象${totalMatches}件`);
            }

            const returned = data.totalResultsReturned || (data.items || []).length;
            offset += returned;
            if (offset >= totalAvailable || returned === 0) break;
            await sleep(PAGE_SLEEP_MS);
        }

        try { await flushBatch(); } catch (e) { if (!stoppedByError) stoppedByError = e.message; }

        const repeatModels = [...modelCount.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]);
        const endReason = stoppedByError ? `エラーで中断: ${stoppedByError}`
            : !running ? '中止ボタンで中断'
            : pagesFetched >= DEEP_SCAN_PP_MAX_PAGE ? `上限${DEEP_SCAN_PP_MAX_PAGE}ページに到達（本当に打ち止めか未確認）`
            : '新着/重複切れで自然終了（これ以上は無い）';

        await new Promise(resolve => {
            GM_xmlhttpRequest({
                method: 'POST', url: SERVER_URL,
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify({
                    items: [], maker: makerName, dry_run: true, deep_scan_session: sessionId,
                    meta: { maker: makerName, yahooBrandId, genreCategoryId, endReason, pagesFetched, totalItems, totalMatches, totalNewCands, repeatModels },
                }),
                timeout: 30000,
                onload: () => resolve(), ontimeout: () => resolve(), onerror: () => resolve(),
            });
        });

        const summaryLines = [
            `=== 深堀り分析: ${makerName}（売り切れ） ===`,
            `終了理由: ${endReason}`,
            `到達ページ数: ${pagesFetched}（最大${pagesFetched * 100}件相当）`,
            `収集件数: ${totalItems}件`,
            `list.json基準で仕入れ対象: ${totalMatches}件`,
            `うち同一型番が2回以上出現（リピート型番）: ${repeatModels.length}種類`,
            ...repeatModels.slice(0, 20).map(([m, n]) => `  ${m}: ${n}回`),
            `新規型番候補（list.json未収録・収集済み）: ${totalNewCands}件`,
        ];
        const summary = summaryLines.join('\n');
        console.log(summary);
        updateStatus(summary);
        return { makerName, endReason, pagesFetched, totalItems, totalMatches, totalNewCands, repeatModels, summary };
    }

    function startDeepScanPayPay() {
        const makerName = prompt('深堀り分析するメーカー名を入力（manufacturersシートの表記と一致させる）', 'エレコム');
        if (!makerName) return;
        running = true;
        setRunningUI(true);
        updateStatus(`[深堀り分析] ${makerName} の情報を検索中...`);
        fetchEligibleMfrs(mfrs => {
            const mfr = mfrs.find(m => m.name === makerName.trim());
            if (!mfr) {
                alert(`manufacturersシートに「${makerName}」が見つかりません（ブランドID未設定の場合も対象外です）`);
                running = false; setRunningUI(false);
                return;
            }
            let priceMin = 1000, priceMax = 20000;
            try {
                if (mfr.url) {
                    const sp = new URLSearchParams(new URL(mfr.url).search);
                    if (sp.get('price_min')) priceMin = Number(sp.get('price_min'));
                    if (sp.get('price_max')) priceMax = Number(sp.get('price_max'));
                }
            } catch (_) {}
            runDeepScanPayPay({ makerNameRaw: makerName.trim(), priceMin, priceMax, yahooBrandId: mfr.yahoo_brand_id }).then(result => {
                if (result) alert(result.summary);
            }).finally(() => { running = false; setRunningUI(false); });
        });
    }

    function fetchPpCategories() {
        return new Promise(resolve => {
            GM_xmlhttpRequest({
                method: 'GET', url: CATEGORY_URL,
                onload: res => { try { resolve(JSON.parse(res.responseText).categories || []); } catch (e) { resolve([]); } },
                onerror: () => resolve([]),
            });
        });
    }

    // 2026-11-03追加：ちまちま1グループずつ指定するのが手間なため、
    // ALL（メーカー+カテゴリ全部）／メーカーのみ（全グループのメーカー）／
    // カテゴリのみ（PPフリマ独自のカテゴリ巡回対象全部）の3種類をまとめて選べるようにした。
    // 数字グループのカンマ区切り指定（メーカーのみに適用）も従来通り使える。
    async function startDeepScanPayPayMulti() {
        const modeInput = prompt(
            '深堀り分析する対象を入力:\n' +
            '  ALL = メーカー(ブランドID設定済み)+カテゴリ全部\n' +
            '  メーカーのみ = メーカー全部\n' +
            '  カテゴリのみ = PPフリマカテゴリ巡回対象全部\n' +
            '  または数字グループをカンマ区切り(メーカーのみに適用。例: 1 / 1,2)\n' +
            '1社ずつ自動で順番に実行します（並列ではありません）。',
            'ALL',
        );
        if (!modeInput) return;
        const mode = modeInput.trim();
        const modeUpper = mode.toUpperCase();
        const wantAllMfr = modeUpper === 'ALL' || mode === 'メーカーのみ';
        const wantAllCat = modeUpper === 'ALL' || mode === 'カテゴリのみ';
        const isGroupMode = !wantAllMfr && !wantAllCat;
        const groups = isGroupMode ? mode.split(',').map(s => s.trim().toUpperCase()).filter(Boolean) : null;

        const excludeInput = prompt('除外するメーカー/カテゴリ名があればカンマ区切りで入力（既に個別実行済み等・空欄でなし）', '');
        const excludeNames = (excludeInput || '').split(',').map(s => s.trim()).filter(Boolean);

        running = true;
        setRunningUI(true);
        updateStatus('[深堀り分析（複数）] 対象リストを取得中...');

        let mfrs = [];
        if (wantAllMfr || isGroupMode) {
            try {
                mfrs = await new Promise((resolve, reject) => {
                    const timer = setTimeout(() => reject(new Error('タイムアウト')), 15000);
                    fetchEligibleMfrs(result => { clearTimeout(timer); resolve(result); });
                });
            } catch (_) {}
        }
        const categories = (wantAllCat) ? await fetchPpCategories() : [];

        const groupMatches = (groupValue) => {
            const g = (groupValue || '').toUpperCase();
            return (groups || []).some(s => s === 'カテゴリ' ? g.indexOf('カテゴリ') === 0 : s === g);
        };
        const mfrTargets = (wantAllMfr || isGroupMode)
            ? mfrs.filter(m => (wantAllMfr || groupMatches(m.group)) && !excludeNames.includes(m.name))
            : [];
        const catTargets = wantAllCat
            ? categories.filter(c => !excludeNames.includes(c.name))
            : [];

        const targets = [
            ...mfrTargets.map(m => ({ kind: 'mfr', name: m.name, mfr: m })),
            ...catTargets.map(c => ({ kind: 'cat', name: c.name, cat: c })),
        ];
        if (targets.length === 0) {
            alert('対象が見つかりません（メーカーはブランドID設定済みのもののみ対象です）');
            running = false; setRunningUI(false);
            return;
        }
        const ok = confirm(
            `${targets.length}件（メーカー${mfrTargets.length}・カテゴリ${catTargets.length}）を1件ずつ順番に深堀り分析します。\n` +
            `1件あたり数分〜十数分かかるため、全体では長時間になります。\n` +
            `続行しますか？（「中止」ボタンでいつでも中断できます）`,
        );
        if (!ok) { running = false; setRunningUI(false); return; }

        const results = [];
        for (let i = 0; i < targets.length; i++) {
            if (!running) break;
            const t = targets[i];
            updateStatus(`[深堀り分析（複数） ${i + 1}/${targets.length}] ${t.name} 実行中...`);
            try {
                if (t.kind === 'mfr') {
                    let priceMin = 1000, priceMax = 20000;
                    try {
                        if (t.mfr.url) {
                            const sp = new URLSearchParams(new URL(t.mfr.url).search);
                            if (sp.get('price_min')) priceMin = Number(sp.get('price_min'));
                            if (sp.get('price_max')) priceMax = Number(sp.get('price_max'));
                        }
                    } catch (_) {}
                    results.push(await runDeepScanPayPay({ makerNameRaw: t.name, priceMin, priceMax, yahooBrandId: t.mfr.yahoo_brand_id }));
                } else {
                    results.push(await runDeepScanPayPay({ makerNameRaw: t.name, priceMin: 1000, priceMax: 20000, genreCategoryId: t.cat.id }));
                }
            } catch (e) {
                results.push({ makerName: `${t.name} [Yahoo]`, endReason: `エラー: ${e.message}`, totalItems: 0, totalMatches: 0, totalNewCands: 0 });
            }
        }

        const grandTotal = results.reduce((acc, r) => ({
            items: acc.items + (r.totalItems || 0),
            matches: acc.matches + (r.totalMatches || 0),
            newCands: acc.newCands + (r.totalNewCands || 0),
        }), { items: 0, matches: 0, newCands: 0 });

        const summaryLines = [
            `=== 深堀り分析（複数・PPフリマ） 完了 ===`,
            `対象: ${results.length}/${targets.length}件（${running ? '全て完了' : '中止ボタンで中断'}）`,
            `合計収集: ${grandTotal.items}件 / 仕入れ対象: ${grandTotal.matches}件 / 新規型番候補: ${grandTotal.newCands}件`,
            '',
            ...results.map(r => `${r.makerName}: 収集${r.totalItems}件 仕入対象${r.totalMatches}件 新規${r.totalNewCands}件（${r.endReason}）`),
        ];
        const summary = summaryLines.join('\n');
        console.log(summary);
        alert(summary);
        running = false; setRunningUI(false);
    }

    // ===== サーバー送信（照合） =====
    // 2026-09-03：mercari_asin_checker.user.jsと同様、maker名をextraで送ることで
    // server.py側のtrack_page_depth()がクロール深度ログ（[ページ深度]）を出力できるようにした。
    function sendToServer(itemList, onDone, extra) {
        GM_xmlhttpRequest({
            method:  'POST',
            url:     SERVER_URL,
            headers: { 'Content-Type': 'application/json' },
            data:    JSON.stringify(Object.assign({ items: itemList }, extra || {})),
            timeout: 120000,
            onload: res => {
                let result = {};
                try {
                    result = JSON.parse(res.responseText);
                    showResults(result.matches || []);
                } catch(e) {
                    updateStatus('サーバー応答エラー');
                }
                if (onDone) onDone(result);
            },
            ontimeout: () => { updateStatus('タイムアウト — ヒットはシートに保存済み'); if (onDone) onDone({}); },
            onerror:   () => { updateStatus('サーバー未起動 (localhost:8766)');          if (onDone) onDone({}); },
        });
    }

    // ===== 結果パネル =====
    function showResults(matches) {
        const old = document.getElementById('pp-checker-panel');
        if (old) old.remove();

        if (matches.length === 0) {
            updateStatus('照合完了 — ヒットなし');
            setTimeout(() => { statusEl.style.display = 'none'; }, 5000);
            return;
        }

        const panel = document.createElement('div');
        panel.id = 'pp-checker-panel';
        panel.style.cssText = `
            position:fixed; top:20px; right:20px; z-index:99998;
            background:#fff; border:2px solid #9C27B0; border-radius:10px;
            padding:16px; width:420px; max-height:80vh; overflow-y:auto;
            box-shadow:0 4px 20px rgba(0,0,0,0.25); font-size:13px; font-family:sans-serif;
        `;

        const header = document.createElement('div');
        header.style.cssText = 'font-weight:bold; font-size:16px; margin-bottom:12px; color:#9C27B0;';
        header.textContent = `★ 仕入れ候補（PPフリマ） ${matches.length}件`;
        panel.appendChild(header);

        matches.forEach(m => {
            const row = document.createElement('div');
            row.style.cssText = 'border-top:1px solid #eee; padding:10px 0;';
            row.innerHTML = `
                <div style="font-weight:bold; color:#222; margin-bottom:3px;">${m.model}</div>
                <div style="color:#888; font-size:11px; margin-bottom:4px;">${(m.name || '').slice(0, 65)}</div>
                <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
                    <span style="color:#f44336; font-weight:bold; font-size:15px;">¥${Number(m.mercari_price).toLocaleString()}</span>
                    <span style="color:#999;">→ Amazon ¥${m.amazon_price ? Number(m.amazon_price).toLocaleString() : '?'}</span>
                    <span style="color:#4CAF50; font-weight:bold;">pmax ¥${Number(m.pmax).toLocaleString()}</span>
                </div>
                <div style="color:#9C27B0; font-size:12px; margin-top:3px;">
                    差益 ¥${Number(m.diff).toLocaleString()} ／ ASIN: ${m.asin}
                </div>
                <div style="margin-top:4px;">
                    <a href="${m.mercari_url}" target="_blank" style="color:#e60012; font-size:11px;">PPフリマで見る →</a>
                </div>
            `;
            panel.appendChild(row);
        });

        const closeBtn = document.createElement('button');
        closeBtn.textContent = '閉じる';
        closeBtn.style.cssText = `
            margin-top:12px; padding:8px; width:100%;
            background:#f0f0f0; border:none; border-radius:6px; cursor:pointer; font-size:13px;
        `;
        closeBtn.onclick = () => panel.remove();
        panel.appendChild(closeBtn);
        document.body.appendChild(panel);

        updateStatus(`照合完了 — ${matches.length}件ヒット！`);
        setTimeout(() => { statusEl.style.display = 'none'; }, 5000);
    }

    // ===== タイミングログ（2026-09-29追加）=====
    // mercari_asin_checker.user.jsのpostTimingと同じ仕組み。メルカリ側の実行と区別できるよう、
    // groupは'PP:'を付けて送り、mfr単位の記録にはroute:'PPリサーチ'を付けてserver.py側で
    // 「リサーチ」（メルカリ）と別ルートとして記録させる（mfr_timingのルート列で区別可能に）。
    // これにより①何社処理したか（＝全部終わったか）が後から確認できる ②type='end'を
    // server.pyが受け取ることで、メルカリと同様に入念調査・実績集計が自動連鎖するようになる
    // （以前は無くPayPayのヒットが精査待ちのまま溜まっていた）。
    function postTiming(data) {
        return new Promise(resolve => {
            GM_xmlhttpRequest({
                method:   'POST',
                url:      'http://localhost:8766/log-timing',
                headers:  { 'Content-Type': 'application/json' },
                data:     JSON.stringify(data),
                onload:   () => resolve(),
                onerror:  () => resolve(),
                ontimeout: () => resolve(),
            });
        });
    }

    // ===== クローラーリサーチ本体 =====
    async function runBatchFetch(mfrs, selected) {
        const targets  = selected.map(s => s.toUpperCase());
        const filtered = (targets.includes('ALL')
            ? mfrs
            : mfrs.filter(m => targets.includes((m.group || '').toUpperCase()))
        // 2026-11-03修正：category_idの有無で判定していたが、山善・カシオ・シャープ・エプソン・
        // キヤノン・ティファール等、ブランド名の曖昧さ対策でURLにcategory_idも併用している
        // 正規メーカーまで誤って除外してしまっていた（実機確認で発覚）。純粋なカテゴリ行は
        // brand_idを持たないため、brand_idの有無で判定するよう修正。
        ).filter(m => (m.url || '').includes('brand_id=')); // カテゴリ検索行(brand_id無し)はPPフリマ非対応のためスキップ
        if (filtered.length === 0) { updateStatus('対象なし'); return; }

        running = true;
        setRunningUI(true);
        let errors = 0;
        let totalCollected = 0, totalMatched = 0, totalHits = 0, totalNewCands = 0;
        const groupLabel = 'PP:' + selected.join(',');
        const batchStart = Date.now();
        postTiming({ type: 'start', group: groupLabel, total: filtered.length });

        for (let i = 0; i < filtered.length; i++) {
            if (!running) break;
            const mfr = filtered[i];
            // mfr.urlからprice_min/price_maxを取得（なければデフォルト値）
            let priceMin = 1000, priceMax = 20000;
            try {
                if (mfr.url) {
                    const sp = new URLSearchParams(new URL(mfr.url).search);
                    if (sp.get('price_min')) priceMin = Number(sp.get('price_min'));
                    if (sp.get('price_max')) priceMax = Number(sp.get('price_max'));
                }
            } catch(_) {}
            updateStatus(`[${i+1}/${filtered.length}] ${mfr.name} ¥${priceMin}〜¥${priceMax} fetch中...`);

            const mfrStart = Date.now();
            try {
                const fetched = await fetchPayPayItems(mfr.name, priceMin, priceMax, mfr.yahoo_brand_id);
                errors = 0;
                const itemList = Object.values(fetched);
                totalCollected += itemList.length;
                updateStatus(`[${i+1}/${filtered.length}] ${mfr.name} ${itemList.length}件 → 照合中`);
                const result = await new Promise(resolve => sendToServer(itemList, resolve, { maker: mfr.name }));
                const matched = result.n_model_match || 0;
                const hits    = (result.matches || []).length;
                const newCands = result.new_candidates_count || 0;
                totalMatched  += matched;
                totalHits     += hits;
                totalNewCands += newCands;
                postTiming({ type: 'mfr', name: mfr.name, group: mfr.group, route: 'PPリサーチ', elapsed_ms: Date.now() - mfrStart, item_count: itemList.length, matched, hits, new_cands: newCands });
                await sleep(MFR_SLEEP_MS);
            } catch(e) {
                errors++;
                updateStatus(`[${i+1}/${filtered.length}] ${mfr.name} エラー(${errors}): ${e.message}`);
                if (errors >= 3) {
                    updateStatus(`エラー連続3回 → 停止: ${e.message}`);
                    running = false;
                    setRunningUI(false);
                    await postTiming({ type: 'end', group: groupLabel, total: filtered.length, elapsed_ms: Date.now() - batchStart, collected: totalCollected, matched: totalMatched, hits: totalHits, new_candidates: totalNewCands });
                    return;
                }
                await sleep(2000);
            }
        }

        running = false;
        setRunningUI(false);
        await postTiming({ type: 'end', group: groupLabel, total: filtered.length, elapsed_ms: Date.now() - batchStart, collected: totalCollected, matched: totalMatched, hits: totalHits, new_candidates: totalNewCands });
        updateStatus(`完了 ${filtered.length}件巡回 / 累計${totalCollected}件 / ヒット${totalHits}件`);
    }

    // ===== カテゴリ巡回本体（2026-10-24追加・ブランドIDの無い新規メーカー発掘用）=====
    // runBatchFetchとほぼ同じ構造だが、対象がmanufacturersシートではなく
    // paypay_category_targets.json（別ファイル）で、genreCategoryId指定で検索する点が違う。
    async function runCategoryBatchFetch(categories) {
        if (categories.length === 0) { updateStatus('カテゴリ対象なし'); return; }
        running = true;
        setRunningUI(true);
        let errors = 0;
        let totalCollected = 0, totalMatched = 0, totalHits = 0, totalNewCands = 0;
        const groupLabel = 'PP-CATEGORY';
        const batchStart = Date.now();
        await postTiming({ type: 'start', group: groupLabel, total: categories.length });

        for (let i = 0; i < categories.length; i++) {
            if (!running) break;
            const cat = categories[i];
            updateStatus(`[カテゴリ${i+1}/${categories.length}] ${cat.name} fetch中...`);
            const mfrStart = Date.now();
            try {
                const fetched = await fetchPayPayItems(cat.name, 1000, 20000, null, cat.id);
                errors = 0;
                const itemList = Object.values(fetched);
                totalCollected += itemList.length;
                updateStatus(`[カテゴリ${i+1}/${categories.length}] ${cat.name} ${itemList.length}件 → 照合中`);
                const result = await new Promise(resolve => sendToServer(itemList, resolve, { maker: cat.name }));
                const matched = result.n_model_match || 0;
                const hits    = (result.matches || []).length;
                const newCands = result.new_candidates_count || 0;
                totalMatched  += matched;
                totalHits     += hits;
                totalNewCands += newCands;
                await postTiming({ type: 'mfr', name: cat.name, group: 'CATEGORY', route: 'PPカテゴリ', elapsed_ms: Date.now() - mfrStart, item_count: itemList.length, matched, hits, new_cands: newCands });
                await sleep(MFR_SLEEP_MS);
            } catch(e) {
                errors++;
                updateStatus(`[カテゴリ${i+1}/${categories.length}] ${cat.name} エラー(${errors}): ${e.message}`);
                if (errors >= 3) {
                    updateStatus(`エラー連続3回 → 停止: ${e.message}`);
                    running = false;
                    setRunningUI(false);
                    await postTiming({ type: 'end', group: groupLabel, total: categories.length, elapsed_ms: Date.now() - batchStart, collected: totalCollected, matched: totalMatched, hits: totalHits, new_candidates: totalNewCands });
                    return;
                }
                await sleep(2000);
            }
        }

        running = false;
        setRunningUI(false);
        await postTiming({ type: 'end', group: groupLabel, total: categories.length, elapsed_ms: Date.now() - batchStart, collected: totalCollected, matched: totalMatched, hits: totalHits, new_candidates: totalNewCands });
        updateStatus(`カテゴリ巡回完了 ${categories.length}件 / 累計${totalCollected}件 / ヒット${totalHits}件`);
    }

    // ===== グループ選択ダイアログ =====
    function showGroupPicker(mfrs) {
        const groups = [...new Set(mfrs.map(m => m.group).filter(g => g))].sort((a, b) => a.localeCompare(b, 'ja', { numeric: true }));
        const groupCounts = {};
        mfrs.forEach(m => { if (m.group) groupCounts[m.group] = (groupCounts[m.group] || 0) + 1; });

        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position:fixed; inset:0; z-index:100000;
            background:rgba(0,0,0,0.45); display:flex; align-items:center; justify-content:center;
        `;
        const box = document.createElement('div');
        box.style.cssText = `
            background:#fff; border-radius:10px; padding:20px; width:280px; max-height:80vh;
            overflow-y:auto; box-shadow:0 4px 20px rgba(0,0,0,0.3); font-family:sans-serif;
        `;

        const title = document.createElement('div');
        title.textContent = 'PPフリマ リサーチ - グループ選択';
        title.style.cssText = 'font-weight:bold; font-size:15px; margin-bottom:14px; color:#9C27B0;';
        box.appendChild(title);

        const list = document.createElement('div');
        list.style.cssText = 'display:flex; flex-direction:column; gap:8px; margin-bottom:16px;';

        function makeOption(value, label, checked) {
            const wrap = document.createElement('label');
            wrap.style.cssText = 'display:flex; align-items:center; gap:8px; font-size:14px; color:#333; cursor:pointer;';
            const cb = document.createElement('input');
            cb.type = 'checkbox'; cb.className = 'pp-res-group-check'; cb.value = value; cb.checked = !!checked;
            wrap.appendChild(cb);
            const span = document.createElement('span'); span.textContent = label;
            wrap.appendChild(span);
            return wrap;
        }

        const allCheckEl = makeOption('ALL', `ALL（全件・${mfrs.length}件）`, true);
        list.appendChild(allCheckEl);
        const groupEls = groups.map(g => {
            const el = makeOption(g, `${g}（${groupCounts[g]}件）`, false);
            list.appendChild(el);
            return el;
        });
        box.appendChild(list);

        const allCb  = allCheckEl.querySelector('input');
        const grpCbs = groupEls.map(el => el.querySelector('input'));
        allCb.addEventListener('change', () => { if (allCb.checked) grpCbs.forEach(c => { c.checked = false; }); });
        grpCbs.forEach(c => c.addEventListener('change', () => { if (c.checked) allCb.checked = false; }));

        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex; gap:8px;';
        const okBtn = document.createElement('button');
        okBtn.textContent = '開始';
        okBtn.style.cssText = `flex:1; padding:10px; background:#9C27B0; color:#fff; border:none; border-radius:6px; font-size:14px; cursor:pointer;`;
        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'キャンセル';
        cancelBtn.style.cssText = `flex:1; padding:10px; background:#f0f0f0; color:#333; border:none; border-radius:6px; font-size:14px; cursor:pointer;`;
        btnRow.appendChild(okBtn);
        btnRow.appendChild(cancelBtn);
        box.appendChild(btnRow);
        overlay.appendChild(box);
        document.body.appendChild(overlay);

        cancelBtn.onclick = () => overlay.remove();
        okBtn.onclick = () => {
            const checked  = Array.from(list.querySelectorAll('.pp-res-group-check:checked')).map(c => c.value);
            const selected = checked.length > 0 ? checked : ['ALL'];
            overlay.remove();
            runBatchFetch(mfrs, selected);
        };
    }

    // メーカーリスト取得＋ブランドID未設定の除外（ボタン押下・自動起動の両方から使う共通処理）
    function fetchEligibleMfrs(onReady) {
        GM_xmlhttpRequest({
            method: 'GET',
            url: MFR_URL,
            onload: res => {
                try {
                    const data = JSON.parse(res.responseText);
                    const allMfrs = data.manufacturers || [];
                    if (allMfrs.length === 0) { updateStatus('メーカーリストが空です'); return; }
                    // カテゴリ検索行はPPフリマ非対応で元々対象外（runBatchFetch側でも除外している）。
                    // 選択画面に「実行しても0件になるグループ」が出ないよう、ここで一覧からも外す。
                    // 2026-11-03修正：「category_idを含む」で判定していたが、山善・カシオ・シャープ・
                    // エプソン・キヤノン・ティファール等、ブランド名の曖昧さ対策でURLにcategory_idも
                    // 併用している正規メーカーまで誤って「カテゴリ行」と判定し除外してしまっていた
                    // （実機確認で発覚）。純粋なカテゴリ行はbrand_idを持たない一方、正規メーカー行は
                    // 必ずbrand_id=を含むため、brand_idの有無で判定するよう修正。
                    const isCat = m => !(m.url || '').includes('brand_id=');
                    const mfrs = REQUIRE_BRAND_ID ? allMfrs.filter(m => !isCat(m) && m.yahoo_brand_id) : allMfrs;
                    const skipped = allMfrs.filter(m => !isCat(m) && !m.yahoo_brand_id).length;
                    if (REQUIRE_BRAND_ID && skipped > 0) {
                        updateStatus(`ブランドID未設定の${skipped}社は対象外です（キーワード検索だと別物が混ざるため）`);
                    }
                    onReady(mfrs);
                } catch(e) {
                    updateStatus('取得失敗: ' + e);
                }
            },
            onerror: () => updateStatus('サーバー未起動 (localhost:8766)'),
        });
    }

    // ===== ボタン処理 =====
    batchBtn.onclick = () => fetchEligibleMfrs(showGroupPicker);
    deepScanBtn.onclick = startDeepScanPayPay;
    deepScanMultiBtn.onclick = startDeepScanPayPayMulti;
    catBtn.onclick = () => {
        GM_xmlhttpRequest({
            method: 'GET',
            url: CATEGORY_URL,
            onload: res => {
                try {
                    const data = JSON.parse(res.responseText);
                    runCategoryBatchFetch(data.categories || []);
                } catch(e) {
                    updateStatus('カテゴリ一覧取得失敗: ' + e);
                }
            },
            onerror: () => updateStatus('サーバー未起動 (localhost:8766)'),
        });
    };

    // ===== 自動起動（2026-09-30追加）=====
    // メルカリ側（mercari_asin_checker.user.js）が?auto_research=経由で起動された時、
    // 完了後にこのURL(?auto_research=ALL)へ自動遷移してくる。「メルカリとヤフーフリマの
    // 両方を仕掛けて寝る」使い方のためのチェーンの2番目。手動でタスクスケジューラ等から
    // 直接このURLを開いて単独起動することもできる。
    // @run-at指定なし(document-idle)のため、スクリプト実行時点で既にloadイベントが
    // 発火済みの場合があることに注意し、readyStateを見て即時実行にフォールバックする。
    (function () {
        const autoGroup = new URLSearchParams(location.search).get('auto_research');
        if (!autoGroup) return;
        const start = () => {
            setTimeout(() => {
                const groups = autoGroup.toUpperCase() === 'ALL' ? ['ALL'] : autoGroup.split(',');
                updateStatus('自動起動: メーカーリスト取得中...');
                fetchEligibleMfrs(mfrs => {
                    runBatchFetch(mfrs, groups).then(() => {
                        // 2026-10-26追加：自動起動時はブランド巡回に続けてカテゴリ巡回も自動実行する
                        // （メルカリ・ヤフー・ラクマ・発掘を一気通貫で繋ぐ構想の一部）。
                        // 完了後は発掘リサーチへ連鎖する（2026-09-30に「時間がかかりすぎる」理由で
                        // 自動連鎖から外していたが、desc_last_run_リセットバグ修正(2026-10-24)で
                        // 定常運用時は十分速くなったため復活させる）。
                        GM_xmlhttpRequest({
                            method: 'GET',
                            url: CATEGORY_URL,
                            onload: res => {
                                let categories = [];
                                try { categories = JSON.parse(res.responseText).categories || []; } catch (e) {}
                                runCategoryBatchFetch(categories).then(() => {
                                    updateStatus('→ 発掘リサーチへ自動移行中...');
                                    setTimeout(() => {
                                        window.location.href = 'https://jp.mercari.com/?start_desc=ALL';
                                    }, 3000);
                                });
                            },
                            onerror: () => updateStatus('カテゴリ一覧取得失敗（ブランド巡回のみで終了）'),
                        });
                    });
                });
            }, 3000);
        };
        if (document.readyState === 'complete') start();
        else window.addEventListener('load', start);
    })();

    // ===== リピート検索（2026-11-08追加）=====
    async function runRepeatSearchPP(modelList) {
        running = true;
        setRunningUI(true);

        let errors = 0;
        let completed = 0;
        let totalHits = 0;
        const batchStart = Date.now();

        for (let i = 0; i < modelList.length; i++) {
            if (!running) break;
            const model = modelList[i];
            updateStatus(`[リピート検索 ${i + 1}/${modelList.length}] ${model} fetch中...`);
            try {
                const fetched = await fetchPayPayItems(model, 1000, 20000, null, null);
                errors = 0;
                const itemList = Object.values(fetched).map(it => Object.assign({}, it, {
                    name: '[リピート検索] ' + it.name,
                }));
                if (itemList.length > 0) {
                    const result = await new Promise(resolve => sendToServer(itemList, resolve, { maker: 'リピート検索:' + model }));
                    if (result._serverDown) throw new Error('サーバー未起動');
                    totalHits += (result.matches || []).length;
                }
                completed++;
                await sleep(500);
            } catch (e) {
                errors++;
                updateStatus(`[リピート検索 ${i + 1}/${modelList.length}] ${model} エラー(${errors}): ${e.message}`);
                if (errors >= 5) {
                    updateStatus(`エラー連続${errors}回 → 中断（${completed}/${modelList.length}件で終了・ヒット${totalHits}件）`);
                    running = false; setRunningUI(false); return;
                }
                await sleep(2000);
            }
        }

        const stoppedByUser = !running;
        running = false;
        setRunningUI(false);
        const elapsedMin = Math.round((Date.now() - batchStart) / 60000);
        updateStatus(
            (stoppedByUser ? '中止しました。' : '全件完了！') +
            ` ${completed}/${modelList.length}件処理・ヒット${totalHits}件・${elapsedMin}分`
        );
    }

    // ===== リピート検索（高速・実験版・2026-11-08追加）=====
    // 安定版runRepeatSearchPP()は1モデルずつ逐次フェッチ→逐次サーバー送信だったため
    // 時間がかかる（実測：3312件で約5時間18分）。複数モデルを並列フェッチし、
    // まとめて1回のサーバー送信にすることで短縮できないか試す実験版（メルカリ側の
    // リピート検索(高速・実験)と同じ発想）。PayPayフリマ側のレート制限の厳しさは
    // 未検証のため、まずは小規模テストで様子を見ること。
    const RS_FAST_PP_CONCURRENCY = 5;
    const RS_FAST_PP_BATCH_SLEEP_MS = 400;

    async function runRepeatSearchPPFast(modelList, concurrency) {
        concurrency = concurrency || RS_FAST_PP_CONCURRENCY;
        running = true;
        setRunningUI(true);

        let completed = 0;
        let totalHits = 0;
        let consecutiveBatchErrors = 0;
        const batchStart = Date.now();

        for (let i = 0; i < modelList.length; i += concurrency) {
            if (!running) break;
            const batch = modelList.slice(i, i + concurrency);
            updateStatus(`[高速リピート検索 ${i + 1}〜${Math.min(i + concurrency, modelList.length)}/${modelList.length}] 並列fetch中(同時${concurrency}件)...`);

            const results = await Promise.allSettled(
                batch.map(model => fetchPayPayItems(model, 1000, 20000, null, null))
            );

            let combinedItems = [];
            let batchErrors = 0;
            results.forEach(r => {
                if (r.status === 'fulfilled') {
                    completed++;
                    const itemList = Object.values(r.value).map(it => Object.assign({}, it, {
                        name: '[リピート検索] ' + it.name,
                    }));
                    combinedItems = combinedItems.concat(itemList);
                } else {
                    batchErrors++;
                }
            });

            if (combinedItems.length > 0) {
                try {
                    const result = await new Promise(resolve => sendToServer(combinedItems, resolve, { maker: 'リピート検索(高速):' + batch.join(',') }));
                    if (result._serverDown) throw new Error('サーバー未起動');
                    totalHits += (result.matches || []).length;
                } catch (e) {
                    updateStatus(`サーバー送信エラー: ${e.message}`);
                }
            }

            if (batchErrors === batch.length) {
                consecutiveBatchErrors++;
                if (consecutiveBatchErrors >= 3) {
                    updateStatus(`バッチ全滅が${consecutiveBatchErrors}回連続 → 中断（${completed}/${modelList.length}件で終了・ヒット${totalHits}件）`);
                    running = false; setRunningUI(false); return;
                }
            } else {
                consecutiveBatchErrors = 0;
            }

            await sleep(RS_FAST_PP_BATCH_SLEEP_MS);
        }

        const stoppedByUser = !running;
        running = false;
        setRunningUI(false);
        const elapsedMin = Math.round((Date.now() - batchStart) / 60000);
        updateStatus(
            (stoppedByUser ? '中止しました。' : '全件完了！') +
            ` [高速版・同時${concurrency}件] ${completed}/${modelList.length}件処理・ヒット${totalHits}件・${elapsedMin}分`
        );
    }

    repeatSearchFastBtn.addEventListener('click', () => {
        const mode = prompt(
            'リピート検索(高速・実験)\n' +
            '1 = 全件（リピートリスト＋過去仕入れ実績）\n' +
            '2 = 指定（search_queueシートに貼ったリストのみ）',
            '1',
        );
        if (!mode) return;
        const concInput = prompt(
            'リピート検索(高速・実験)\n同時並列数を指定してください\n' +
            '2 = 安全重視（通常比そこそこ速く、負荷は小さめ）\n' +
            '5 = 速度重視（通常比最大5倍だが未検証・負荷大きめ）',
            '2'
        );
        if (concInput === null) return;
        const concurrency = Math.min(10, Math.max(1, parseInt(concInput.trim(), 10) || RS_FAST_PP_CONCURRENCY));
        const endpoint = mode.trim() === '2' ? '/get-search-queue' : '/get-repeat-search-list';
        GM_xmlhttpRequest({
            method: 'GET',
            url: `http://localhost:8766${endpoint}`,
            onload: res => {
                try {
                    const models = JSON.parse(res.responseText).models || [];
                    if (models.length === 0) { updateStatus('型番リストが空です'); return; }
                    runRepeatSearchPPFast(models, concurrency);
                } catch (e) {
                    updateStatus('型番リストの取得に失敗しました');
                }
            },
            ontimeout: () => { updateStatus('型番リスト取得タイムアウト'); },
            onerror:   () => { updateStatus('サーバー未起動（0_サーバー起動.batを実行してください）'); },
        });
    });

    // ===== リピート検索の自動起動（2026-11-08追加）=====
    // ?auto_repeat_search=ALL をつけてこのURLを開くと、ボタン操作・prompt()なしで
    // 全件モードのリピート検索が自動開始する（夜間にメルカリ・ヤフー・ラクマの
    // リピート検索を同時に仕掛けて放置する運用のため）。
    (function () {
        const autoFlag = new URLSearchParams(location.search).get('auto_repeat_search');
        if (!autoFlag) return;
        const start = () => {
            setTimeout(() => {
                updateStatus('自動起動: リピート検索リスト取得中...');
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: 'http://localhost:8766/get-repeat-search-list',
                    onload: res => {
                        try {
                            const models = JSON.parse(res.responseText).models || [];
                            if (models.length === 0) { updateStatus('リピート検索リストが空です'); return; }
                            runRepeatSearchPP(models);
                        } catch (e) {
                            updateStatus('型番リストの取得に失敗しました');
                        }
                    },
                    ontimeout: () => { updateStatus('型番リスト取得タイムアウト'); },
                    onerror:   () => { updateStatus('サーバー未起動（0_サーバー起動.batを実行してください）'); },
                });
            }, 3000);
        };
        if (document.readyState === 'complete') start();
        else window.addEventListener('load', start);
    })();

    repeatSearchBtn.onclick = () => {
        const mode = prompt(
            'リピート検索\n' +
            '1 = 全件（リピートリスト＋過去仕入れ実績）\n' +
            '2 = 指定（search_queueシートに貼ったリストのみ）',
            '1',
        );
        if (!mode) return;
        const endpoint = mode.trim() === '2' ? '/get-search-queue' : '/get-repeat-search-list';
        GM_xmlhttpRequest({
            method: 'GET',
            url: `http://localhost:8766${endpoint}`,
            onload: res => {
                try {
                    const models = JSON.parse(res.responseText).models || [];
                    if (models.length === 0) { updateStatus('型番リストが空です'); return; }
                    runRepeatSearchPP(models);
                } catch (e) {
                    updateStatus('型番リストの取得に失敗しました');
                }
            },
            ontimeout: () => { updateStatus('型番リスト取得タイムアウト'); },
            onerror:   () => { updateStatus('サーバー未起動（0_サーバー起動.batを実行してください）'); },
        });
    };

    stopBtn.onclick = () => { running = false; };

})();
