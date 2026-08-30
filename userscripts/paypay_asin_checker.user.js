// ==UserScript==
// @name         PayPay Flea Market ASIN Checker
// @namespace    http://tampermonkey.net/
// @version      1.8
// @description  PayPayフリマ出品中商品をlist.json(pmax)と照合して仕入れ候補を表示（ブランドID指定検索＋新着順ソート対応）
// @match        https://paypayfleamarket.yahoo.co.jp/*
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @updateURL    https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/paypay_asin_checker.user.js
// @downloadURL  https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/paypay_asin_checker.user.js
// ==/UserScript==

(function () {
    'use strict';

    const SERVER_URL = 'http://localhost:8766/check-mercari';
    const MFR_URL    = 'http://localhost:8766/get-manufacturers';
    const MAX_PAGE   = 20; // 最大20ページ = 2000件/メーカー
    const EXCLUDE_KW = ['開封済み', '破れ', 'ダメージ', '傷あり', '汚れあり', '水没', 'ジャンク'];

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
    container.appendChild(statusEl);
    container.appendChild(batchBtn);
    container.appendChild(stopBtn);
    document.body.appendChild(container);

    let running = false;

    function updateStatus(msg) { statusEl.style.display = 'block'; statusEl.textContent = msg; }
    function setRunningUI(on) {
        batchBtn.style.display = on ? 'none'  : 'block';
        stopBtn.style.display  = on ? 'block' : 'none';
    }
    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    // ===== PayPayフリマ API fetch（出品中・新品・価格帯はmfrURLから取得）=====
    // 2026-08-31追加：yahooBrandIdが分かっているメーカーはbrandIds指定で検索する
    // （キーワード検索だと同名異業種の商品が混入するため。実測でASIN不一致率が
    // メルカリの約3倍だった精度問題への対策）。無ければ従来のキーワード検索にフォールバック。
    // sort=openTime&order=desc（新着順）も追加：指定無しだと新着優先にならず、
    // 取得件数の上限内で古い出品ばかり拾ってしまうことが実測で判明したため。
    async function fetchPayPayItems(mfrName, priceMin, priceMax, yahooBrandId) {
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
            if (yahooBrandId) {
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
                };
            });

            const returned = data.totalResultsReturned || pageItems.length;
            offset += returned;
            if (offset >= totalAvailable || returned === 0) break;
            await sleep(300);
        }
        return allItems;
    }

    // ===== サーバー送信（照合） =====
    function sendToServer(itemList, onDone) {
        GM_xmlhttpRequest({
            method:  'POST',
            url:     SERVER_URL,
            headers: { 'Content-Type': 'application/json' },
            data:    JSON.stringify({ items: itemList }),
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

    // ===== クローラーリサーチ本体 =====
    async function runBatchFetch(mfrs, selected) {
        const targets  = selected.map(s => s.toUpperCase());
        const filtered = (targets.includes('ALL')
            ? mfrs
            : mfrs.filter(m => targets.includes((m.group || '').toUpperCase()))
        ).filter(m => !(m.url || '').includes('category_id')); // カテゴリ検索行はPPフリマ非対応のためスキップ
        if (filtered.length === 0) { updateStatus('対象なし'); return; }

        running = true;
        setRunningUI(true);
        let errors = 0;
        let totalCollected = 0, totalHits = 0;

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

            try {
                const fetched = await fetchPayPayItems(mfr.name, priceMin, priceMax, mfr.yahoo_brand_id);
                errors = 0;
                const itemList = Object.values(fetched);
                totalCollected += itemList.length;
                updateStatus(`[${i+1}/${filtered.length}] ${mfr.name} ${itemList.length}件 → 照合中`);
                const result = await new Promise(resolve => sendToServer(itemList, resolve));
                totalHits += (result.matches || []).length;
                await sleep(500);
            } catch(e) {
                errors++;
                updateStatus(`[${i+1}/${filtered.length}] ${mfr.name} エラー(${errors}): ${e.message}`);
                if (errors >= 3) {
                    updateStatus(`エラー連続3回 → 停止: ${e.message}`);
                    running = false;
                    setRunningUI(false);
                    return;
                }
                await sleep(2000);
            }
        }

        running = false;
        setRunningUI(false);
        if (running === false) {
            updateStatus(`完了 ${filtered.length}件巡回 / 累計${totalCollected}件 / ヒット${totalHits}件`);
        }
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

    // ===== ボタン処理 =====
    batchBtn.onclick = () => {
        GM_xmlhttpRequest({
            method: 'GET',
            url: MFR_URL,
            onload: res => {
                try {
                    const data = JSON.parse(res.responseText);
                    const mfrs = data.manufacturers || [];
                    if (mfrs.length === 0) { updateStatus('メーカーリストが空です'); return; }
                    showGroupPicker(mfrs);
                } catch(e) {
                    updateStatus('取得失敗: ' + e);
                }
            },
            onerror: () => updateStatus('サーバー未起動 (localhost:8766)'),
        });
    };

    stopBtn.onclick = () => { running = false; };

})();
