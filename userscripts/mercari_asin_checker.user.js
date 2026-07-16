// ==UserScript==
// @name         Mercari ASIN Checker
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  メルカリ検索結果をASINリストと照合して仕入れ候補を表示（クローラーリサーチのグループ選択をチェックボックスで複数選択可能に）
// @match        https://jp.mercari.com/*
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @updateURL    https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/mercari_asin_checker.user.js
// @downloadURL  https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/mercari_asin_checker.user.js
// ==/UserScript==

(function () {
    'use strict';

    const SERVER_URL   = 'http://localhost:8766/check-mercari';
    const MFR_URL      = 'http://localhost:8766/get-manufacturers';
    // メルカリ検索条件（クローラーリサーチ用）
    const BATCH_CONDITIONS = 'status=on_sale&item_condition_id=1&shipping_payer_id=2';
    const ITEM_SEL    = 'div.merItemThumbnail[itemtype="ITEM_TYPE_MERCARI"]';
    const NAME_SEL    = '[data-testid="thumbnail-item-name"]';
    const PRICE_SEL   = '.merPrice span:last-child';
    const IMAGE_SEL   = 'img';
    const NEXT_SEL    = '[data-testid="pagination-next-button"] a';
    const SCROLL_STEP = Math.floor(window.innerHeight * 0.75);
    const SCROLL_WAIT = 600;
    const MAX_SCROLL  = 90000;

    // ========== UI ==========
    const container = document.createElement('div');
    container.style.cssText = `
        position:fixed; bottom:20px; left:20px; z-index:99999;
        display:flex; flex-direction:column; align-items:flex-start; gap:8px;
    `;
    const statusEl = document.createElement('div');
    statusEl.style.cssText = `
        background:rgba(0,0,0,0.78); color:#fff; padding:6px 14px;
        border-radius:6px; font-size:13px; display:none; max-width:300px; text-align:left;
    `;
    const startBtn = document.createElement('button');
    startBtn.textContent = 'リサーチ';
    startBtn.style.cssText = `
        padding:12px 22px; background:#2196F3; color:#fff;
        border:none; border-radius:6px; font-size:16px;
        cursor:pointer; box-shadow:0 2px 6px rgba(0,0,0,0.3);
    `;
    const stopBtn = document.createElement('button');
    stopBtn.textContent = '中止';
    stopBtn.style.cssText = `
        padding:12px 22px; background:#f44336; color:#fff;
        border:none; border-radius:6px; font-size:16px;
        cursor:pointer; box-shadow:0 2px 6px rgba(0,0,0,0.3); display:none;
    `;
    const batchBtn = document.createElement('button');
    batchBtn.textContent = 'クローラーリサーチ';
    batchBtn.style.cssText = `
        padding:12px 22px; background:#9C27B0; color:#fff;
        border:none; border-radius:6px; font-size:14px;
        cursor:pointer; box-shadow:0 2px 6px rgba(0,0,0,0.3);
    `;
    container.appendChild(statusEl);
    container.appendChild(startBtn);
    container.appendChild(batchBtn);
    container.appendChild(stopBtn);
    document.body.appendChild(container);

    // ========== 状態 ==========
    let running = false;
    let items   = {};

    function updateStatus(msg) {
        statusEl.style.display = 'block';
        statusEl.textContent   = msg;
    }
    function setRunningUI(on) {
        startBtn.style.display = on ? 'none'  : 'block';
        stopBtn.style.display  = on ? 'block' : 'none';
    }
    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    // ========== fetch化: 共有テンプレートから直接API呼び出し（v2.0） ==========
    const _SHARED_TPL_KEY = 'mercari_api_shared_tpl';

    function _getSharedTpl() {
        try {
            const s = localStorage.getItem(_SHARED_TPL_KEY);
            return s ? JSON.parse(s) : null;
        } catch(e) { return null; }
    }

    async function fetchCheckerItems(mfrUrl) {
        const tpl = _getSharedTpl();
        if (!tpl) throw new Error('NO_TEMPLATE');

        const sp = new URLSearchParams(new URL(mfrUrl).search);
        const keyword = sp.get('keyword') || '';
        const statusMap = { sold_out: 'STATUS_SOLD_OUT', on_sale: 'STATUS_ON_SALE' };
        const apiStatus = statusMap[sp.get('status') || 'on_sale'] || 'STATUS_ON_SALE';

        const allItems = {};
        let pageToken = '';

        for (let page = 0; page < 20; page++) {
            const bodyObj = JSON.parse(tpl.body);
            const sc = bodyObj.searchCondition = bodyObj.searchCondition || {};
            sc.keyword = keyword;
            sc.status = [apiStatus];
            delete sc.categoryId;
            delete sc.priceMin;
            delete sc.priceMax;
            if (sp.get('item_condition_id')) sc.itemConditionId = sp.get('item_condition_id').split(',').map(Number);
            if (sp.get('shipping_payer_id')) sc.shippingPayerId = sp.get('shipping_payer_id').split(',').map(Number);
            bodyObj.pageToken = pageToken;
            bodyObj.pageSize = 120;

            const data = await new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: tpl.method,
                    url: tpl.url,
                    headers: { ...tpl.headers, 'Content-Type': 'application/json' },
                    data: JSON.stringify(bodyObj),
                    responseType: 'json',
                    timeout: 15000,
                    onload: function(res) {
                        try { resolve(typeof res.response === 'object' ? res.response : JSON.parse(res.responseText)); }
                        catch(e) { reject(new Error('parseError')); }
                    },
                    onerror: function() { reject(new Error('requestError')); },
                    ontimeout: function() { reject(new Error('timeout')); },
                });
            });

            (data.items || []).forEach(item => {
                const id = item.id || item.itemId;
                if (!id || !item.name || item.price == null) return;
                allItems[id] = {
                    name: item.name,
                    price: String(item.price),
                    url: `https://jp.mercari.com/item/${id}`,
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

    async function runBatchFetch(mfrs, selected) {
        const targets = selected.map(s => s.toUpperCase());
        const filtered = targets.includes('ALL') ? mfrs : mfrs.filter(m => targets.includes((m.group || '').toUpperCase()));
        if (filtered.length === 0) { updateStatus('対象なし'); return; }

        running = true;
        setRunningUI(true);
        let errors = 0;

        for (let i = 0; i < filtered.length; i++) {
            if (!running) break;
            const mfr = filtered[i];
            const name = mfr.name || mfr;
            const url = mfr.url || `https://jp.mercari.com/search?keyword=${encodeURIComponent(name)}&${BATCH_CONDITIONS}`;
            updateStatus(`[${i+1}/${filtered.length}] ${name} fetch中...`);

            try {
                items = await fetchCheckerItems(url);
                errors = 0;
                const itemList = Object.values(items);
                updateStatus(`[${i+1}/${filtered.length}] ${name} ${itemList.length}件 → 照合中`);
                await new Promise(resolve => sendToServer(itemList, resolve));
                await sleep(500);
            } catch(e) {
                errors++;
                updateStatus(`[${i+1}/${filtered.length}] ${name} エラー(${errors}): ${e.message}`);
                if (errors >= 3 || e.message === 'NO_TEMPLATE') {
                    if (e.message === 'NO_TEMPLATE') {
                        updateStatus('テンプレートなし → リアルタイムリサーチ起動後に再試行してください');
                    } else {
                        localStorage.removeItem(_SHARED_TPL_KEY);
                        updateStatus('テンプレート期限切れ → ページ再読み込み後に再試行してください');
                    }
                    running = false;
                    setRunningUI(false);
                    return;
                }
                await sleep(2000);
            }
        }

        running = false;
        setRunningUI(false);
        updateStatus(`クローラーリサーチ完了 全${filtered.length}件`);
    }

    // ========== 収集 ==========
    function collectItems() {
        document.querySelectorAll(ITEM_SEL).forEach(el => {
            const id = el.id;
            if (!id || items[id]) return;
            const name  = el.querySelector(NAME_SEL)?.textContent?.trim();
            const price = el.querySelector(PRICE_SEL)?.textContent?.trim().replace(/,/g, '');
            const url   = `https://jp.mercari.com/item/${id}`;
            const image = el.querySelector(IMAGE_SEL)?.src || '';
            if (name && price) items[id] = { name, price, url, image };
        });
    }
    function waitForItems() {
        return new Promise(resolve => {
            const t = setInterval(() => {
                if (document.querySelector(NAME_SEL)) { clearInterval(t); resolve(); }
            }, 300);
            setTimeout(() => { clearInterval(t); resolve(); }, 10000);
        });
    }
    function waitForUrlChange(oldUrl) {
        return new Promise(resolve => {
            const t = setInterval(() => {
                if (location.href !== oldUrl) { clearInterval(t); resolve(); }
            }, 300);
            setTimeout(() => { clearInterval(t); resolve(); }, 10000);
        });
    }
    async function scrollAndCollect() {
        window.scrollTo(0, 0);
        await sleep(400);
        const deadline = Date.now() + MAX_SCROLL;
        while (Date.now() < deadline) {
            if (!running) return;
            collectItems();
            const atBottom = Math.ceil(window.scrollY + window.innerHeight) >= document.body.scrollHeight - 80;
            if (atBottom) { await sleep(800); collectItems(); break; }
            window.scrollBy(0, SCROLL_STEP);
            await sleep(SCROLL_WAIT);
        }
    }

    // ========== 結果表示 ==========
    function showResults(matches) {
        const old = document.getElementById('asin-checker-panel');
        if (old) old.remove();

        if (matches.length === 0) {
            updateStatus('照合完了 — ヒットなし');
            setTimeout(() => { statusEl.style.display = 'none'; }, 5000);
            return;
        }

        const panel = document.createElement('div');
        panel.id = 'asin-checker-panel';
        panel.style.cssText = `
            position:fixed; top:20px; right:20px; z-index:99998;
            background:#fff; border:2px solid #2196F3; border-radius:10px;
            padding:16px; width:420px; max-height:80vh; overflow-y:auto;
            box-shadow:0 4px 20px rgba(0,0,0,0.25); font-size:13px; font-family:sans-serif;
        `;

        const header = document.createElement('div');
        header.style.cssText = 'font-weight:bold; font-size:16px; margin-bottom:12px; color:#2196F3;';
        header.textContent = `★ 仕入れ候補 ${matches.length}件`;
        panel.appendChild(header);

        matches.forEach(m => {
            const row = document.createElement('div');
            row.style.cssText = 'border-top:1px solid #eee; padding:10px 0;';
            row.innerHTML = `
                <div style="font-weight:bold; color:#222; margin-bottom:3px;">${m.model}</div>
                <div style="color:#888; font-size:11px; margin-bottom:4px;">${m.name.slice(0, 65)}</div>
                <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
                    <span style="color:#f44336; font-weight:bold; font-size:15px;">¥${m.mercari_price.toLocaleString()}</span>
                    <span style="color:#999;">→ Amazon ¥${m.amazon_price ? m.amazon_price.toLocaleString() : '?'}</span>
                    <span style="color:#4CAF50; font-weight:bold;">pmax ¥${m.pmax.toLocaleString()}</span>
                </div>
                <div style="color:#2196F3; font-size:12px; margin-top:3px;">
                    差益 ¥${m.diff.toLocaleString()} ／ ASIN: ${m.asin}
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

    // ========== サーバー送信 ==========
    function sendToServer(itemList, onDone) {
        GM_xmlhttpRequest({
            method:  'POST',
            url:     SERVER_URL,
            headers: { 'Content-Type': 'application/json' },
            data:    JSON.stringify({ items: itemList }),
            timeout: 60000,
            onload: function(res) {
                try {
                    const result = JSON.parse(res.responseText);
                    showResults(result.matches || []);
                } catch(e) {
                    updateStatus('サーバー応答エラー');
                }
                if (onDone) onDone();
            },
            ontimeout: function() {
                updateStatus('タイムアウト（60秒）— ヒットはシートに保存済み');
                if (onDone) onDone();
            },
            onerror: function() {
                updateStatus('サーバー未起動（0_サーバー起動.batを実行してください）');
                if (onDone) onDone();
            },
        });
    }

    function finish(message) {
        const itemList = Object.values(items);
        running = false;
        // バッチモード中は専用処理
        if (localStorage.getItem('batchMode') === 'true' && window.batchFinishOverride) {
            window.batchFinishOverride(message);
            return;
        }
        setRunningUI(false);
        updateStatus(`${message}（${itemList.length}件収集） サーバーに送信中...`);
        sendToServer(itemList);
    }

    // ========== メインループ ==========
    async function run() {
        let pageCount = 0;
        while (running) {
            pageCount++;
            updateStatus(`収集中... ${pageCount}ページ目`);
            await waitForItems();
            await scrollAndCollect();
            if (!running) { finish('中止'); return; }

            const nextBtn = document.querySelector(NEXT_SEL);
            if (!nextBtn) { finish(`${pageCount}ページ完了`); return; }

            updateStatus(`${pageCount}ページ完了（累計 ${Object.keys(items).length}件）→ 次ページ...`);
            const currentUrl = location.href;
            nextBtn.click();
            await waitForUrlChange(currentUrl);
            await sleep(500);
        }
        finish('中止');
    }

    // ========== クローラーリサーチ ==========
    function showGroupPicker(mfrs) {
        const groups = [...new Set(mfrs.map(m => m.group).filter(g => g))].sort((a, b) => a.localeCompare(b, 'ja', { numeric: true }));
        const groupCounts = {};
        mfrs.forEach(m => { if (m.group) groupCounts[m.group] = (groupCounts[m.group] || 0) + 1; });

        const overlay = document.createElement('div');
        overlay.id = 'group-picker-overlay';
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
        title.textContent = 'クローラーリサーチ - グループを選択';
        title.style.cssText = 'font-weight:bold; font-size:15px; margin-bottom:14px; color:#333;';
        box.appendChild(title);

        const list = document.createElement('div');
        list.style.cssText = 'display:flex; flex-direction:column; gap:8px; margin-bottom:16px;';

        function makeOption(value, label, checked) {
            const wrap = document.createElement('label');
            wrap.style.cssText = 'display:flex; align-items:center; gap:8px; font-size:14px; color:#333; cursor:pointer;';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'group-picker-check';
            checkbox.value = value;
            checkbox.checked = !!checked;
            wrap.appendChild(checkbox);
            const span = document.createElement('span');
            span.textContent = label;
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

        // ALLを選んだら個別グループは自動解除、個別グループを選んだらALLは自動解除
        const allCheckbox = allCheckEl.querySelector('input');
        const groupCheckboxes = groupEls.map(el => el.querySelector('input'));
        allCheckbox.addEventListener('change', () => {
            if (allCheckbox.checked) groupCheckboxes.forEach(c => { c.checked = false; });
        });
        groupCheckboxes.forEach(c => {
            c.addEventListener('change', () => {
                if (c.checked) allCheckbox.checked = false;
            });
        });

        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex; gap:8px;';

        const okBtn = document.createElement('button');
        okBtn.textContent = '開始';
        okBtn.style.cssText = `
            flex:1; padding:10px; background:#9C27B0; color:#fff; border:none;
            border-radius:6px; font-size:14px; cursor:pointer;
        `;
        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'キャンセル';
        cancelBtn.style.cssText = `
            flex:1; padding:10px; background:#f0f0f0; color:#333; border:none;
            border-radius:6px; font-size:14px; cursor:pointer;
        `;
        btnRow.appendChild(okBtn);
        btnRow.appendChild(cancelBtn);
        box.appendChild(btnRow);

        overlay.appendChild(box);
        document.body.appendChild(overlay);

        cancelBtn.onclick = () => overlay.remove();
        okBtn.onclick = () => {
            const checked = Array.from(list.querySelectorAll('.group-picker-check:checked')).map(c => c.value);
            const selected = checked.length > 0 ? checked : ['ALL'];
            overlay.remove();
            if (_getSharedTpl()) {
                runBatchFetch(mfrs, selected);
            } else {
                updateStatus('テンプレート未取得 → リアルタイムリサーチ起動後に再試行。従来モードで開始');
                runBatchWithGroups(mfrs, selected);
            }
        };
    }

    function runBatchWithGroups(mfrs, selected) {
        const targets = selected.map(s => s.toUpperCase());
        const filtered = targets.includes('ALL') ? mfrs : mfrs.filter(m => targets.includes((m.group || '').toUpperCase()));
        const label = targets.includes('ALL') ? 'ALL' : selected.join(',');

        if (filtered.length === 0) {
            updateStatus(`グループ「${label}」は見つかりません`);
            return;
        }

        localStorage.setItem('batchMode',  'true');
        localStorage.setItem('batchList',  JSON.stringify(filtered.map(m => ({name: m.name, url: m.url}))));
        localStorage.setItem('batchIndex', '0');
        updateStatus(`クローラーリサーチ開始 ${filtered.length}件（グループ:${label}）`);
        setTimeout(goNextBatch, 1000);
    }

    function startBatch() {
        GM_xmlhttpRequest({
            method: 'GET',
            url: MFR_URL,
            onload: function(res) {
                try {
                    const data = JSON.parse(res.responseText);
                    const mfrs = data.manufacturers || [];
                    if (mfrs.length === 0) {
                        updateStatus('メーカーリストが空です（スプレッドシートのmanufacturersシートを確認）');
                        return;
                    }
                    showGroupPicker(mfrs);
                } catch(e) {
                    updateStatus('メーカーリスト取得失敗: ' + e);
                }
            },
            onerror: () => updateStatus('サーバー未起動 or manufacturersシートなし'),
        });
    }

    function goNextBatch() {
        const list  = JSON.parse(localStorage.getItem('batchList') || '[]');
        const index = parseInt(localStorage.getItem('batchIndex') || '0');
        if (index >= list.length) {
            localStorage.removeItem('batchMode');
            localStorage.removeItem('batchList');
            localStorage.removeItem('batchIndex');
            updateStatus(`クローラーリサーチ完了！ 全${list.length}件`);
            setRunningUI(false);
            if (localStorage.getItem('autoResearch') === 'true') {
                localStorage.removeItem('autoResearch');
                setTimeout(() => window.close(), 5000);
            }
            return;
        }
        const item = list[index];
        const name = item.name || item;
        const url  = item.url  || `https://jp.mercari.com/search?keyword=${encodeURIComponent(name)}&${BATCH_CONDITIONS}`;
        updateStatus(`[${index+1}/${list.length}] ${name} へ移動中...`);
        location.href = url;
    }

    // バッチモード中のページロード時に自動リサーチ開始
    if (localStorage.getItem('batchMode') === 'true') {
        window.addEventListener('load', () => {
            setTimeout(() => {
                const list  = JSON.parse(localStorage.getItem('batchList') || '[]');
                const index = parseInt(localStorage.getItem('batchIndex') || '0');
                const mfr   = list[index] || '';
                updateStatus(`[${index+1}/${list.length}] ${mfr} リサーチ中...`);
                running = true;
                items   = {};
                setRunningUI(true);
                run();
                // run()完了後に次へ（finishをオーバーライド）
                const origFinish = finish;
                window.batchFinishOverride = function(msg) {
                    running = false;
                    const itemList = Object.values(items);
                    updateStatus(`${msg}（${itemList.length}件）→ サーバーに送信中...`);
                    sendToServer(itemList, () => {
                        localStorage.setItem('batchIndex', String(index + 1));
                        setTimeout(goNextBatch, 500);
                    });
                };
            }, 2000);
        });
    }

    // ========== 自動起動（タスクスケジューラ用） ==========
    // URLに ?auto_research=ALL をつけてChromeを起動するとクローラーリサーチが自動開始する
    if (localStorage.getItem('batchMode') !== 'true') {
        const autoGroup = new URLSearchParams(location.search).get('auto_research');
        if (autoGroup) {
            localStorage.setItem('autoResearch', 'true');
            window.addEventListener('load', () => {
                setTimeout(() => {
                    GM_xmlhttpRequest({
                        method: 'GET',
                        url: MFR_URL,
                        onload: function(res) {
                            try {
                                const mfrs = JSON.parse(res.responseText).manufacturers || [];
                                if (!mfrs.length) { updateStatus('メーカーリストが空です'); return; }
                                const groups = autoGroup.toUpperCase() === 'ALL' ? ['ALL'] : autoGroup.split(',');
                                runBatchWithGroups(mfrs, groups);
                            } catch(e) { updateStatus('自動起動失敗: ' + e); }
                        },
                        onerror: () => updateStatus('サーバー未起動（auto_research）'),
                    });
                }, 3000);
            });
        }
    }

    startBtn.addEventListener('click', () => { running = true; items = {}; setRunningUI(true); run(); });
    batchBtn.addEventListener('click', startBatch);
    stopBtn.addEventListener('click',  () => {
        running = false;
        localStorage.removeItem('batchMode');
        localStorage.removeItem('batchList');
        localStorage.removeItem('batchIndex');
    });

})();
