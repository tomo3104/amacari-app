// ==UserScript==
// @name         Mercari Description Model Finder
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  タイトルに型番がない商品の説明文から型番を抽出してlist.jsonと照合
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
    const _uw             = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

    // タイトルに型番が含まれるか判定
    // 型番パターン: 英字2文字以上 + ハイフン + 英数字2文字以上（SP-P10など）
    //            または 英字1〜3文字 + 数字3文字以上（LC2412など）
    const HAS_MODEL_RE = /\b(?:[A-Z]{2,}-[A-Z0-9]{2,}|[A-Z]{1,3}[0-9]{3,}[A-Z0-9]*)\b/i;

    // 説明文から「型番: XXXXX」形式を抽出
    const DESC_MODEL_RE = /(?:型番|品番|モデル(?:番号)?)[：:]\s*([A-Za-z0-9][A-Za-z0-9\-\/\.]{3,})/;

    const TARGET_KEYWORD    = 'エレコム';
    const DESC_FETCH_DELAY  = 2500; // ms（説明文取得の間隔）
    const MAX_PAGES         = 20;

    // ===== UI =====
    const container = document.createElement('div');
    container.style.cssText = `
        position:fixed; bottom:20px; left:20px; z-index:99999;
        display:flex; flex-direction:column; align-items:flex-start; gap:8px;
    `;
    const statusEl = document.createElement('div');
    statusEl.style.cssText = `
        background:rgba(0,0,0,0.78); color:#fff; padding:6px 14px;
        border-radius:6px; font-size:13px; display:none; max-width:320px; text-align:left;
    `;
    const searchBtn = document.createElement('button');
    searchBtn.textContent = '説明文リサーチ（ELECOM）';
    searchBtn.style.cssText = `
        padding:12px 18px; background:#F57C00; color:#fff;
        border:none; border-radius:6px; font-size:14px;
        cursor:pointer; box-shadow:0 2px 6px rgba(0,0,0,0.3);
    `;
    const stopBtn = document.createElement('button');
    stopBtn.textContent = '中止';
    stopBtn.style.cssText = `
        padding:12px 18px; background:#f44336; color:#fff;
        border:none; border-radius:6px; font-size:14px;
        cursor:pointer; box-shadow:0 2px 6px rgba(0,0,0,0.3); display:none;
    `;
    container.appendChild(statusEl);
    container.appendChild(searchBtn);
    container.appendChild(stopBtn);
    document.body.appendChild(container);

    let running = false;

    function updateStatus(msg) { statusEl.style.display = 'block'; statusEl.textContent = msg; }
    function setRunningUI(on) {
        searchBtn.style.display = on ? 'none'  : 'block';
        stopBtn.style.display   = on ? 'block' : 'none';
    }
    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    function _getSharedTpl() {
        try {
            const s = _uw.localStorage.getItem(_SHARED_TPL_KEY);
            return s ? JSON.parse(s) : null;
        } catch(e) { return null; }
    }

    // タイトルに型番が含まれるか判定
    function hasModelInTitle(title) {
        return HAS_MODEL_RE.test(title);
    }

    // 説明文から型番を抽出
    function extractModelFromDesc(html) {
        const m = DESC_MODEL_RE.exec(html);
        return m ? m[1].toUpperCase() : null;
    }

    // エレコム販売中商品を一括収集
    async function fetchElecomerItems(tpl) {
        const allItems = {};
        let pageToken = '';

        for (let page = 0; page < MAX_PAGES; page++) {
            const bodyObj = JSON.parse(tpl.body);
            const sc = bodyObj.searchCondition = bodyObj.searchCondition || {};
            sc.keyword        = TARGET_KEYWORD;
            sc.status         = ['STATUS_ON_SALE'];
            sc.itemConditionId = [1]; // 新品
            sc.shippingPayerId = [2]; // 送料込み
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
                    method: tpl.method, headers: tpl.headers,
                    credentials: 'include', body: JSON.stringify(bodyObj),
                    signal: ctrl.signal,
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

    // Mercari APIで商品説明を取得して型番を探す
    async function findModelInItemPage(itemId, tpl) {
        try {
            const res = await fetch(`https://api.mercari.jp/items/get?id=${itemId}`, {
                method: 'GET',
                headers: tpl.headers,
                credentials: 'include',
            });
            if (!res.ok) return null;
            const data = await res.json();
            const description = data?.data?.description
                             || data?.item?.description
                             || data?.description
                             || '';
            return extractModelFromDesc(description);
        } catch(e) {
            return null;
        }
    }

    // 結果表示パネル
    function showResults(matches) {
        const old = document.getElementById('desc-model-panel');
        if (old) old.remove();

        if (matches.length === 0) {
            updateStatus('照合完了 — ヒットなし');
            setTimeout(() => { statusEl.style.display = 'none'; }, 5000);
            return;
        }

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
                <div style="font-weight:bold; color:#222; margin-bottom:3px;">${m.model}</div>
                <div style="color:#888; font-size:11px; margin-bottom:4px;">${(m.name || '').slice(0, 65)}</div>
                <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
                    <span style="color:#f44336; font-weight:bold; font-size:15px;">¥${Number(m.mercari_price).toLocaleString()}</span>
                    <span style="color:#999;">→ Amazon ¥${m.amazon_price ? Number(m.amazon_price).toLocaleString() : '?'}</span>
                    <span style="color:#4CAF50; font-weight:bold;">pmax ¥${Number(m.pmax).toLocaleString()}</span>
                </div>
                <div style="color:#F57C00; font-size:12px; margin-top:3px;">
                    差益 ¥${Number(m.diff).toLocaleString()} ／ ASIN: ${m.asin}
                </div>
                <div style="margin-top:4px;">
                    <a href="${m.mercari_url}" target="_blank" style="color:#FF6600; font-size:11px;">メルカリで見る →</a>
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

    // サーバー送信
    function sendToServer(itemList) {
        GM_xmlhttpRequest({
            method:  'POST',
            url:     SERVER_URL,
            headers: { 'Content-Type': 'application/json' },
            data:    JSON.stringify({ items: itemList }),
            timeout: 120000,
            onload: res => {
                running = false;
                setRunningUI(false);
                try {
                    const result = JSON.parse(res.responseText);
                    showResults(result.matches || []);
                } catch(e) {
                    updateStatus('サーバー応答エラー');
                }
            },
            ontimeout: () => { running = false; setRunningUI(false); updateStatus('タイムアウト — ヒットはシートに保存済み'); },
            onerror:   () => { running = false; setRunningUI(false); updateStatus('サーバー未起動（ASINリサーチ_1_サーバー起動.bat を実行してください）'); },
        });
    }

    // メイン処理
    async function runDescriptionSearch() {
        const tpl = _getSharedTpl();
        if (!tpl) {
            updateStatus('テンプレート未取得 → 先にメルカリで1回検索してください');
            return;
        }

        running = true;
        setRunningUI(true);

        // 1. エレコム販売中・新品商品を一括収集
        updateStatus(`${TARGET_KEYWORD} 収集中...`);
        let allItems;
        try {
            allItems = await fetchElecomerItems(tpl);
        } catch(e) {
            updateStatus(`収集エラー: ${e.message}`);
            running = false; setRunningUI(false); return;
        }
        if (!running) { setRunningUI(false); updateStatus('中止しました'); return; }

        const itemList = Object.values(allItems);
        updateStatus(`${itemList.length}件収集 → タイトルフィルタ中...`);

        // 2. タイトルに型番がないものだけ選別
        const noModelItems = itemList.filter(item => !hasModelInTitle(item.name));
        if (noModelItems.length === 0) {
            updateStatus('型番なしタイトルの商品が見つかりませんでした');
            running = false; setRunningUI(false); return;
        }

        // 3. 各商品の説明文ページを取得して型番を探す
        const serverItems = [];
        for (let i = 0; i < noModelItems.length; i++) {
            if (!running) break;
            const item = noModelItems[i];
            updateStatus(`[${i+1}/${noModelItems.length}] 説明文確認中 (型番取得済:${serverItems.length}件)`);

            const model = await findModelInItemPage(item.id, tpl);
            if (model) {
                serverItems.push({
                    name:  `${item.name} ${model}`, // 型番をタイトルに付加してサーバーで照合
                    price: item.price,
                    url:   item.url,
                    image: item.image,
                });
            }

            await sleep(DESC_FETCH_DELAY);
        }

        if (!running) { setRunningUI(false); updateStatus('中止しました'); return; }

        if (serverItems.length === 0) {
            updateStatus('説明文から型番を取得できた商品がありませんでした');
            running = false; setRunningUI(false); return;
        }

        // 4. サーバーに送って list.json と照合
        updateStatus(`説明文から型番${serverItems.length}件取得 → list.jsonと照合中...`);
        sendToServer(serverItems);
    }

    searchBtn.addEventListener('click', runDescriptionSearch);
    stopBtn.addEventListener('click',   () => { running = false; });

})();
