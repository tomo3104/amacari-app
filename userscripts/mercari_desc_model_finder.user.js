// ==UserScript==
// @name         Mercari Description Model Finder
// @namespace    http://tampermonkey.net/
// @version      2.2
// @description  タイトルに型番がない商品の説明文から型番を抽出してlist.jsonと照合（DOMアクセス方式）
// @match        https://jp.mercari.com/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      localhost
// @updateURL    https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/mercari_desc_model_finder.user.js
// @downloadURL  https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/mercari_desc_model_finder.user.js
// ==/UserScript==

(function () {
    'use strict';

    const SERVER_URL      = 'http://localhost:8766/check-mercari';
    const _SHARED_TPL_KEY = 'mercari_api_shared_tpl';
    const QUEUE_KEY       = 'desc_model_queue';
    const RESULT_KEY      = 'desc_model_results';
    const _uw             = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

    // タイトルに型番が含まれるか判定
    const HAS_MODEL_RE  = /\b(?:[A-Z]{2,}-[A-Z0-9]{2,}|[A-Z]{1,3}[0-9]{3,}[A-Z0-9]*)\b/i;
    // 説明文から「型番: XXXXX」形式を抽出
    const DESC_MODEL_RE = /(?:型番|品番|モデル(?:番号)?)[：:]\s*([A-Za-z0-9][A-Za-z0-9\-\/\.]{3,})/;
    // 説明文DOMセレクター（メルカリのPREタグ）
    const DESC_SEL      = 'pre[class*="merText"]';

    const TARGET_KEYWORD = 'エレコム';
    const MAX_PAGES      = 20;

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    function _getSharedTpl() {
        try {
            const s = _uw.localStorage.getItem(_SHARED_TPL_KEY);
            return s ? JSON.parse(s) : null;
        } catch(e) { return null; }
    }

    function hasModelInTitle(title) { return HAS_MODEL_RE.test(title); }

    function extractModelFromDesc(text) {
        const m = DESC_MODEL_RE.exec(text);
        return m ? m[1].toUpperCase() : null;
    }

    // ===== ステータスUI（全ページ共通） =====
    const statusEl = document.createElement('div');
    statusEl.style.cssText = `
        position:fixed; bottom:20px; left:20px; z-index:99999;
        background:rgba(0,0,0,0.80); color:#fff; padding:8px 16px;
        border-radius:8px; font-size:13px; display:none;
        max-width:360px; font-family:sans-serif; line-height:1.5;
    `;
    document.body.appendChild(statusEl);

    function showStatus(msg, bg) {
        statusEl.style.display = 'block';
        statusEl.style.background = bg || 'rgba(0,0,0,0.80)';
        statusEl.textContent = msg;
    }
    function hideStatus() { statusEl.style.display = 'none'; }

    // ========================================================
    //  モード判定
    // ========================================================
    const itemMatch = location.pathname.match(/^\/item\/(m[A-Za-z0-9]+)/);

    if (itemMatch) {
        // ============ 商品ページモード ============
        runItemPageMode(itemMatch[1]);
    } else {
        // ============ 起動ページモード ============
        runLaunchMode();
    }

    // ========================================================
    //  商品ページモード：DOMから説明文を読んで次へ進む
    // ========================================================
    function runItemPageMode(currentId) {
        const queueStr = localStorage.getItem(QUEUE_KEY);
        if (!queueStr) return; // スクリプト未起動なら何もしない

        let queue;
        try { queue = JSON.parse(queueStr); } catch(e) { return; }
        if (!queue.running) return;

        const items = queue.items;
        const idx   = items.findIndex(i => i.id === currentId);
        if (idx === -1) { localStorage.removeItem(QUEUE_KEY); return; }

        const total = items.length;

        // 中止ボタン
        const stopBtn = document.createElement('button');
        stopBtn.textContent = '収集中止';
        stopBtn.style.cssText = `
            position:fixed; bottom:70px; left:20px; z-index:99999;
            padding:8px 16px; background:#f44336; color:#fff;
            border:none; border-radius:6px; font-size:13px; cursor:pointer;
            box-shadow:0 2px 6px rgba(0,0,0,0.3);
        `;
        stopBtn.onclick = () => {
            localStorage.removeItem(QUEUE_KEY);
            localStorage.removeItem(RESULT_KEY);
            stopBtn.remove();
            showStatus('中止しました', 'rgba(160,0,0,0.88)');
            setTimeout(hideStatus, 3000);
        };
        document.body.appendChild(stopBtn);

        showStatus(`[${idx + 1}/${total}] 説明文を読み込み中...`);

        // 次ページへ進む内部関数
        function goNext() {
            if (!localStorage.getItem(QUEUE_KEY)) return; // 中止済み
            const nextIdx = idx + 1;
            if (nextIdx < total) {
                window.location.href = items[nextIdx].url;
            } else {
                finishAndSend(stopBtn);
            }
        }

        // DOMのレンダリングを待ちながら説明文を取得
        const waitForDesc = (retries) => {
            if (!localStorage.getItem(QUEUE_KEY)) { stopBtn.remove(); return; } // 中止済み

            const el = document.querySelector(DESC_SEL);
            if (el) {
                const desc  = el.innerText || '';
                const model = extractModelFromDesc(desc);

                if (model) {
                    const results = JSON.parse(localStorage.getItem(RESULT_KEY) || '[]');
                    const item    = items[idx];
                    results.push({
                        name:  `${item.name} ${model}`,
                        price: item.price,
                        url:   item.url,
                        image: item.image,
                    });
                    localStorage.setItem(RESULT_KEY, JSON.stringify(results));
                    showStatus(`[${idx + 1}/${total}] 型番取得: ${model}\n取得済: ${results.length}件`, 'rgba(20,110,0,0.88)');
                } else {
                    const gotSoFar = JSON.parse(localStorage.getItem(RESULT_KEY) || '[]').length;
                    showStatus(`[${idx + 1}/${total}] 型番なし → スキップ（取得済: ${gotSoFar}件）`);
                }

                setTimeout(goNext, 1500);

            } else if (retries > 0) {
                setTimeout(() => waitForDesc(retries - 1), 500);
            } else {
                // タイムアウト → スキップ
                const gotSoFar = JSON.parse(localStorage.getItem(RESULT_KEY) || '[]').length;
                showStatus(`[${idx + 1}/${total}] タイムアウト → スキップ（取得済: ${gotSoFar}件）`);
                setTimeout(goNext, 1000);
            }
        };

        // エラーページ（商品削除/売り切れ）を早期検出してスキップ
        function isErrorPage() {
            const bodyText = document.body.innerText || '';
            return bodyText.includes('このページは存在しません') ||
                   bodyText.includes('商品が見つかりません') ||
                   bodyText.includes('ページが見つかりません') ||
                   bodyText.includes('404');
        }

        // Reactのレンダリングが完了するまで2秒待つ
        setTimeout(() => {
            if (isErrorPage()) {
                const gotSoFar = JSON.parse(localStorage.getItem(RESULT_KEY) || '[]').length;
                showStatus(`[${idx + 1}/${total}] 商品削除済み → スキップ（取得済: ${gotSoFar}件）`);
                setTimeout(goNext, 800);
            } else {
                waitForDesc(20);
            }
        }, 2000);
    }

    // ========================================================
    //  全件完了 → サーバーへ送信
    // ========================================================
    function finishAndSend(stopBtn) {
        const results = JSON.parse(localStorage.getItem(RESULT_KEY) || '[]');
        localStorage.removeItem(QUEUE_KEY);
        localStorage.removeItem(RESULT_KEY);
        if (stopBtn) stopBtn.remove();

        if (results.length === 0) {
            showStatus('説明文から型番を取得できた商品はありませんでした', 'rgba(100,80,0,0.88)');
            setTimeout(hideStatus, 6000);
            return;
        }

        showStatus(`説明文型番 ${results.length}件 → list.jsonと照合中...`, 'rgba(0,70,160,0.88)');

        GM_xmlhttpRequest({
            method:  'POST',
            url:     SERVER_URL,
            headers: { 'Content-Type': 'application/json' },
            data:    JSON.stringify({ items: results }),
            timeout: 120000,
            onload: res => {
                try {
                    const result = JSON.parse(res.responseText);
                    showResults(result.matches || []);
                } catch(e) {
                    showStatus('サーバー応答エラー', 'rgba(160,0,0,0.88)');
                }
            },
            ontimeout: () => showStatus('タイムアウト — ヒットはシートに保存済み', 'rgba(100,80,0,0.88)'),
            onerror:   () => showStatus('サーバー未起動（ASINリサーチ_1_サーバー起動.bat を実行してください）', 'rgba(160,0,0,0.88)'),
        });
    }

    // ========================================================
    //  起動ページモード：ボタン表示 → 収集開始
    // ========================================================
    function runLaunchMode() {
        const btnContainer = document.createElement('div');
        btnContainer.style.cssText = `
            position:fixed; bottom:20px; left:20px; z-index:99999;
            display:flex; flex-direction:column; align-items:flex-start; gap:8px;
        `;

        const searchBtn = document.createElement('button');
        searchBtn.textContent = '説明文リサーチ（ELECOM）';
        searchBtn.style.cssText = `
            padding:12px 18px; background:#F57C00; color:#fff;
            border:none; border-radius:6px; font-size:14px;
            cursor:pointer; box-shadow:0 2px 6px rgba(0,0,0,0.3);
        `;

        btnContainer.appendChild(searchBtn);
        document.body.appendChild(btnContainer);

        searchBtn.addEventListener('click', async () => {
            const tpl = _getSharedTpl();
            if (!tpl) {
                showStatus('テンプレート未取得 → 先にメルカリで1回検索してください', 'rgba(160,0,0,0.88)');
                return;
            }

            searchBtn.disabled = true;
            searchBtn.textContent = '収集中...';

            // エレコム販売中・新品・送料込み商品を収集
            showStatus(`${TARGET_KEYWORD} 検索中...`);
            let allItems;
            try {
                allItems = await fetchItems(tpl);
            } catch(e) {
                showStatus(`収集エラー: ${e.message}`, 'rgba(160,0,0,0.88)');
                searchBtn.disabled = false;
                searchBtn.textContent = '説明文リサーチ（ELECOM）';
                return;
            }

            const itemList     = Object.values(allItems);
            const noModelItems = itemList.filter(item => !hasModelInTitle(item.name));

            showStatus(`${itemList.length}件収集 → 型番なし: ${noModelItems.length}件`);

            if (noModelItems.length === 0) {
                showStatus('型番なしの商品が見つかりませんでした', 'rgba(100,80,0,0.88)');
                searchBtn.disabled = false;
                searchBtn.textContent = '説明文リサーチ（ELECOM）';
                return;
            }

            // キューを保存して最初の商品ページへ遷移
            localStorage.setItem(QUEUE_KEY, JSON.stringify({
                items:     noModelItems,
                running:   true,
                startedAt: Date.now(),
            }));
            localStorage.setItem(RESULT_KEY, JSON.stringify([]));

            showStatus(`${noModelItems.length}件の説明文を順番に収集します。ページが自動的に移動します...`);
            await sleep(1500);
            window.location.href = noModelItems[0].url;
        });
    }

    // ========================================================
    //  エレコム商品収集（Search API）
    // ========================================================
    async function fetchItems(tpl) {
        const allItems = {};
        let pageToken  = '';

        for (let page = 0; page < MAX_PAGES; page++) {
            const bodyObj = JSON.parse(tpl.body);
            const sc      = bodyObj.searchCondition = bodyObj.searchCondition || {};
            sc.keyword         = TARGET_KEYWORD;
            sc.status          = ['STATUS_ON_SALE'];
            sc.itemConditionId = [1];  // 新品
            sc.shippingPayerId = [2];  // 送料込み
            delete sc.categoryId;
            delete sc.brandId;
            delete sc.priceMin;
            delete sc.priceMax;
            bodyObj.pageToken = pageToken;
            bodyObj.pageSize  = 120;

            const ctrl  = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 15000);
            let data;
            try {
                const res = await fetch(tpl.url, {
                    method:      tpl.method,
                    headers:     tpl.headers,
                    credentials: 'include',
                    body:        JSON.stringify(bodyObj),
                    signal:      ctrl.signal,
                });
                clearTimeout(timer);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                data = await res.json();
            } catch(e) {
                clearTimeout(timer);
                throw e;
            }

            (data.items || []).forEach(item => {
                const id = item.id || item.itemId;
                if (!id || !item.name || item.price == null) return;
                if (item.auction && item.auction.bidDeadline) return;
                allItems[id] = {
                    id,
                    name:  item.name,
                    price: String(item.price),
                    url:   `https://jp.mercari.com/item/${id}`,
                    image: (item.thumbnails && item.thumbnails[0]) || '',
                };
            });

            const nextToken = (data.meta && data.meta.nextPageToken) || data.nextPageToken || '';
            if (!nextToken || (data.items || []).length === 0) break;
            pageToken = nextToken;
            await sleep(300);
        }
        return allItems;
    }

    // ========================================================
    //  結果パネル表示
    // ========================================================
    function showResults(matches) {
        hideStatus();

        if (matches.length === 0) {
            showStatus('照合完了 — ヒットなし', 'rgba(100,80,0,0.88)');
            setTimeout(hideStatus, 6000);
            return;
        }

        const old = document.getElementById('desc-model-panel');
        if (old) old.remove();

        const panel = document.createElement('div');
        panel.id = 'desc-model-panel';
        panel.style.cssText = `
            position:fixed; top:20px; right:20px; z-index:99998;
            background:#fff; border:2px solid #F57C00; border-radius:10px;
            padding:16px; width:420px; max-height:80vh; overflow-y:auto;
            box-shadow:0 4px 20px rgba(0,0,0,0.25); font-size:13px; font-family:sans-serif;
        `;

        const header = document.createElement('div');
        header.style.cssText = 'font-weight:bold; font-size:16px; margin-bottom:12px; color:#F57C00;';
        header.textContent = `★ 仕入れ候補（説明文型番） ${matches.length}件`;
        panel.appendChild(header);

        matches.forEach(m => {
            const row = document.createElement('div');
            row.style.cssText = 'border-top:1px solid #eee; padding:10px 0;';
            row.innerHTML = `
                <div style="font-weight:bold;color:#222;margin-bottom:3px;">${m.model}</div>
                <div style="color:#888;font-size:11px;margin-bottom:4px;">${(m.name||'').slice(0,65)}</div>
                <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
                    <span style="color:#f44336;font-weight:bold;font-size:15px;">¥${Number(m.mercari_price).toLocaleString()}</span>
                    <span style="color:#999;">→ Amazon ¥${m.amazon_price?Number(m.amazon_price).toLocaleString():'?'}</span>
                    <span style="color:#4CAF50;font-weight:bold;">pmax ¥${Number(m.pmax).toLocaleString()}</span>
                </div>
                <div style="color:#F57C00;font-size:12px;margin-top:3px;">
                    差益 ¥${Number(m.diff).toLocaleString()} ／ ASIN: ${m.asin}
                </div>
                <a href="${m.mercari_url}" target="_blank" style="color:#FF6600;font-size:11px;">メルカリで見る →</a>
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

        showStatus(`照合完了 — ${matches.length}件ヒット！`, 'rgba(0,100,0,0.88)');
    }

})();
