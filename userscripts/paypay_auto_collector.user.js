// ==UserScript==
// @name         PayPay Flea Market Auto Collector
// @namespace    http://tampermonkey.net/
// @version      1.9
// @description  PayPayフリマ売り切れ商品を全メーカー自動収集 → 型番抽出（8765サーバー連携・ブランドID指定検索＋新着順ソート対応・mercari_auto_collector.user.jsと同様url/_pageを送信しクロール深度計測に対応）
// @match        https://paypayfleamarket.yahoo.co.jp/*
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @updateURL    https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/paypay_auto_collector.user.js
// @downloadURL  https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/paypay_auto_collector.user.js
// ==/UserScript==

(function () {
    'use strict';

    const SERVER     = 'http://localhost:8765';
    const MAX_PAGE   = 20; // 最大20ページ = 2000件/メーカー
    const EXCLUDE_KW = ['開封済み', '破れ', 'ダメージ', '傷あり', '汚れあり', '水没', 'ジャンク'];

    // ===== UI =====
    const container = document.createElement('div');
    container.style.cssText = `
        position:fixed; bottom:20px; right:20px; z-index:99999;
        display:flex; flex-direction:column; align-items:flex-end; gap:8px;
    `;
    const statusEl = document.createElement('div');
    statusEl.style.cssText = `
        background:rgba(0,0,0,0.78); color:#fff; padding:6px 14px;
        border-radius:6px; font-size:13px; display:none; max-width:280px;
    `;
    const crawlerBtn = document.createElement('button');
    crawlerBtn.textContent = 'PPフリマ コレクト';
    crawlerBtn.style.cssText = `
        padding:12px 20px; background:#e60012; color:#fff;
        border:none; border-radius:6px; font-size:14px;
        cursor:pointer; box-shadow:0 2px 6px rgba(0,0,0,0.3);
    `;
    const stopBtn = document.createElement('button');
    stopBtn.textContent = '中止';
    stopBtn.style.cssText = `
        padding:12px 20px; background:#555; color:#fff;
        border:none; border-radius:6px; font-size:14px;
        cursor:pointer; box-shadow:0 2px 6px rgba(0,0,0,0.3); display:none;
    `;
    container.appendChild(statusEl);
    container.appendChild(crawlerBtn);
    container.appendChild(stopBtn);
    document.body.appendChild(container);

    const logPanel = document.createElement('div');
    logPanel.style.cssText = `
        position:fixed; bottom:120px; right:20px; z-index:99998;
        width:320px; max-height:320px; overflow-y:auto;
        background:rgba(0,0,0,0.88); color:#d0d0d0; padding:8px 12px;
        border-radius:8px; font-size:12px; font-family:monospace;
        display:none; line-height:1.7; box-shadow:0 2px 10px rgba(0,0,0,0.4);
    `;
    document.body.appendChild(logPanel);

    function addLog(msg, color) {
        const line = document.createElement('div');
        line.textContent = msg;
        if (color) line.style.color = color;
        logPanel.appendChild(line);
        logPanel.scrollTop = logPanel.scrollHeight;
        logPanel.style.display = 'block';
    }
    function clearLog() { logPanel.innerHTML = ''; logPanel.style.display = 'none'; }
    function updateStatus(msg) { statusEl.style.display = 'block'; statusEl.textContent = msg; }
    function setRunningUI(on) {
        crawlerBtn.style.display = on ? 'none' : 'block';
        stopBtn.style.display    = on ? 'block' : 'none';
    }
    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    // ===== PayPayフリマ API fetch（売り切れ・新品・価格帯はcrawl_urlから取得）=====
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
                sold:     '1',
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
            params.append('statuses', 'SOLD');
            const url = `https://paypayfleamarket.yahoo.co.jp/api/v1/search?${params}`;

            let data;
            const res = await fetch(url, { credentials: 'include' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            data = await res.json();

            if (totalAvailable === null) totalAvailable = data.totalResultsAvailable || 0;

            const pageItems = data.items || [];
            pageItems.forEach(item => {
                if (!item.id || !item.title || item.condition !== 'new') return;
                if (item.itemStatus && item.itemStatus !== 'SOLD') return; // 売り切れのみ収集
                if (item.isBulkPurchaseItem) return;
                if (EXCLUDE_KW.some(kw => item.title.includes(kw))) return;
                allItems[item.id] = {
                    name:  item.title,
                    price: String(item.price || 0),
                    url:   `https://paypayfleamarket.yahoo.co.jp/item/${item.id}`,
                    _page: page + 1,
                };
            });

            const returned = data.totalResultsReturned || pageItems.length;
            offset += returned;
            if (offset >= totalAvailable || returned === 0) break;
            await sleep(300);
        }

        return allItems;
    }

    // ===== 収集メインループ =====
    let running = false;

    async function runCrawler(mfrs, selected) {
        const targets  = selected.map(s => s.toUpperCase());
        const filtered = (targets.includes('ALL')
            ? mfrs
            : mfrs.filter(m => targets.includes((m.group || '').toUpperCase()))
        ).filter(m => !(m.url || '').includes('category_id')); // カテゴリ検索行はPPフリマ非対応のためスキップ
        if (filtered.length === 0) { updateStatus('対象なし'); return; }

        running = true;
        setRunningUI(true);
        clearLog();
        addLog('▶ PPフリマ コレクト開始 ' + filtered.length + '件', '#ff8888');

        GM_xmlhttpRequest({
            method: 'POST', url: SERVER + '/log-start',
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify({ total_mfr: filtered.length, group: selected.join(',') }),
        });

        const allItems = {};
        let errors = 0;

        for (let i = 0; i < filtered.length; i++) {
            if (!running) break;
            const mfr = filtered[i];
            // crawl_url（F列）からprice_min/price_maxを取得（なければデフォルト値）
            let priceMin = 1000, priceMax = 20000;
            try {
                const refUrl = mfr.crawl_url || mfr.url || '';
                if (refUrl) {
                    const sp = new URLSearchParams(new URL(refUrl).search);
                    if (sp.get('price_min')) priceMin = Number(sp.get('price_min'));
                    if (sp.get('price_max')) priceMax = Number(sp.get('price_max'));
                }
            } catch(_) {}
            updateStatus('[' + (i+1) + '/' + filtered.length + '] ' + mfr.name + ' ¥' + priceMin + '〜¥' + priceMax + ' 収集中...');

            try {
                const fetched = await fetchPayPayItems(mfr.name, priceMin, priceMax, mfr.yahoo_brand_id);
                errors = 0;
                Object.assign(allItems, fetched);
                const cnt   = Object.keys(fetched).length;
                const total = Object.keys(allItems).length;
                addLog('[' + (i+1) + '/' + filtered.length + '] ' + mfr.name + '  ' + cnt + '件  (累計' + total + '件)');
                updateStatus('[' + (i+1) + '/' + filtered.length + '] ' + mfr.name + ' ' + cnt + '件');

                const itemsForLog = Object.values(fetched).map(it => ({
                    name: it.name, price: Number(it.price) || 0,
                    url: it.url || '', _page: it._page || 0,
                }));
                GM_xmlhttpRequest({
                    method: 'POST', url: SERVER + '/log-progress',
                    headers: { 'Content-Type': 'application/json' },
                    data: JSON.stringify({ index: i+1, total_mfr: filtered.length, name: mfr.name, count: cnt, cumulative: total, items: itemsForLog }),
                });
                await sleep(300);
            } catch(e) {
                errors++;
                addLog('[' + (i+1) + '/' + filtered.length + '] ' + mfr.name + '  エラー: ' + e.message, '#ff8888');
                if (errors >= 3) {
                    updateStatus('エラー連続3回 → 停止: ' + e.message);
                    running = false;
                    setRunningUI(false);
                    return;
                }
                await sleep(2000);
            }
        }

        if (!running) {
            setRunningUI(false);
            updateStatus('中止しました');
            addLog('--- 中止 ---', '#ffaa44');
            return;
        }

        const grandTotal = Object.keys(allItems).length;
        updateStatus('型番抽出中... (' + grandTotal + '件)');
        addLog('-------------------------');
        addLog('収集完了: ' + grandTotal + '件 → 型番抽出中...', '#88ccff');

        const itemList = Object.values(allItems).map(it => ({ name: it.name, price: Number(it.price) || 0 }));
        const result = await new Promise(resolve => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: SERVER + '/collect-items',
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify({ items: itemList }),
                timeout: 120000,
                onload:    res => { try { resolve(JSON.parse(res.responseText)); } catch(e) { resolve({}); } },
                onerror:   ()  => resolve({}),
                ontimeout: ()  => resolve({}),
            });
        });

        running = false;
        setRunningUI(false);
        const newCount    = result.new_count || 0;
        const totalModels = result.total      || 0;
        addLog('新規型番: ' + newCount + '件  累計型番: ' + totalModels + '件', '#88ff88');
        updateStatus('完了！ ' + grandTotal + '件収集 / 新規型番' + newCount + '件');
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
        title.textContent = 'PPフリマ コレクト - グループ選択';
        title.style.cssText = 'font-weight:bold; font-size:15px; margin-bottom:14px; color:#333;';
        box.appendChild(title);

        const list = document.createElement('div');
        list.style.cssText = 'display:flex; flex-direction:column; gap:8px; margin-bottom:16px;';

        function makeOption(value, label, checked) {
            const wrap = document.createElement('label');
            wrap.style.cssText = 'display:flex; align-items:center; gap:8px; font-size:14px; color:#333; cursor:pointer;';
            const cb = document.createElement('input');
            cb.type = 'checkbox'; cb.className = 'pp-group-check'; cb.value = value; cb.checked = !!checked;
            wrap.appendChild(cb);
            const span = document.createElement('span'); span.textContent = label;
            wrap.appendChild(span);
            return wrap;
        }

        const allCheckEl = makeOption('ALL', 'ALL（全件・' + mfrs.length + '件）', true);
        list.appendChild(allCheckEl);
        const groupEls = groups.map(g => {
            const el = makeOption(g, g + '（' + groupCounts[g] + '件）', false);
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
        okBtn.style.cssText = `flex:1; padding:10px; background:#e60012; color:#fff; border:none; border-radius:6px; font-size:14px; cursor:pointer;`;
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
            const checked  = Array.from(list.querySelectorAll('.pp-group-check:checked')).map(c => c.value);
            const selected = checked.length > 0 ? checked : ['ALL'];
            overlay.remove();
            runCrawler(mfrs, selected);
        };
    }

    // ===== ボタン処理 =====
    crawlerBtn.onclick = () => {
        GM_xmlhttpRequest({
            method: 'GET',
            url: SERVER + '/get-manufacturers',
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
            onerror: () => updateStatus('サーバー未起動 (localhost:8765)'),
        });
    };

    stopBtn.onclick = () => { running = false; };

})();
