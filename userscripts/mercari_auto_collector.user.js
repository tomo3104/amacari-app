// ==UserScript==
// @name         Mercari Auto Collector
// @namespace    http://tampermonkey.net/
// @version      5.5
// @description  メルカリ検索結果を全ページ自動収集してクリップボードにコピー（クローラーコレクトfetch対応・全メーカー完了後に1回だけstep1送信）
// @match        https://jp.mercari.com/*
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      localhost
// @updateURL    https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/mercari_auto_collector.user.js
// @downloadURL  https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/mercari_auto_collector.user.js
// ==/UserScript==

(function () {
    'use strict';

    const ITEM_SEL    = 'div.merItemThumbnail[itemtype="ITEM_TYPE_MERCARI"]';
    const NAME_SEL    = '[data-testid="thumbnail-item-name"]';
    const PRICE_SEL   = '.merPrice span:last-child';
    const NEXT_SEL    = '[data-testid="pagination-next-button"] a';
    const SCROLL_STEP = Math.floor(window.innerHeight * 0.75);
    const SCROLL_WAIT = 600;
    const MAX_SCROLL  = 90000;

    // ========== UI ==========
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
    const startBtn = document.createElement('button');
    startBtn.textContent = 'コレクト';
    startBtn.style.cssText = `
        padding:12px 20px; background:#4CAF50; color:#fff;
        border:none; border-radius:6px; font-size:16px;
        cursor:pointer; box-shadow:0 2px 6px rgba(0,0,0,0.3);
    `;
    const crawlerBtn = document.createElement('button');
    crawlerBtn.textContent = 'クローラーコレクト';
    crawlerBtn.style.cssText = `
        padding:12px 20px; background:#FF6F00; color:#fff;
        border:none; border-radius:6px; font-size:14px;
        cursor:pointer; box-shadow:0 2px 6px rgba(0,0,0,0.3);
    `;
    const stopBtn = document.createElement('button');
    stopBtn.textContent = '中止';
    stopBtn.style.cssText = `
        padding:12px 20px; background:#f44336; color:#fff;
        border:none; border-radius:6px; font-size:16px;
        cursor:pointer; box-shadow:0 2px 6px rgba(0,0,0,0.3); display:none;
    `;
    container.appendChild(statusEl);
    container.appendChild(startBtn);
    container.appendChild(crawlerBtn);
    container.appendChild(stopBtn);
    document.body.appendChild(container);

    // ========== 状態 ==========
    let running = false;
    let items   = {};

    function updateStatus(msg) {
        statusEl.style.display = 'block';
        statusEl.textContent = msg;
    }
    function setRunningUI(on) {
        startBtn.style.display = on ? 'none' : 'block';
        stopBtn.style.display  = on ? 'block' : 'none';
    }
    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    // ========== fetch化: 共有テンプレートから直接API呼び出し（v5.2） ==========
    const _SHARED_TPL_KEY = 'mercari_api_shared_tpl';
    const _uw = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

    function _getSharedTpl() {
        try {
            const s = _uw.localStorage.getItem(_SHARED_TPL_KEY);
            return s ? JSON.parse(s) : null;
        } catch(e) { return null; }
    }

    async function fetchCollectorItems(mfrUrl) {
        const tpl = _getSharedTpl();
        if (!tpl) throw new Error('NO_TEMPLATE');

        const sp       = new URLSearchParams(new URL(mfrUrl).search);
        const keyword  = sp.get('keyword') || '';
        const brandIds = sp.get('brand_id') ? sp.get('brand_id').split(',').map(Number) : null;
        const statusMap = { sold_out: 'STATUS_SOLD_OUT', on_sale: 'STATUS_ON_SALE' };
        const apiStatus = statusMap[sp.get('status') || 'sold_out'] || 'STATUS_SOLD_OUT';
        const priceMin  = sp.get('price_min') ? Number(sp.get('price_min')) : null;
        const priceMax  = sp.get('price_max') ? Number(sp.get('price_max')) : null;

        const allItems = {};
        let pageToken = '';

        for (let page = 0; page < 20; page++) {
            const bodyObj = JSON.parse(tpl.body);
            const sc = bodyObj.searchCondition = bodyObj.searchCondition || {};
            sc.keyword = keyword;
            sc.status  = [apiStatus];
            if (brandIds) sc.brandId = brandIds; else delete sc.brandId;
            delete sc.categoryId;
            if (priceMin != null) sc.priceMin = priceMin; else delete sc.priceMin;
            if (priceMax != null) sc.priceMax = priceMax; else delete sc.priceMax;
            if (sp.get('item_condition_id')) sc.itemConditionId = sp.get('item_condition_id').split(',').map(Number);
            if (sp.get('shipping_payer_id')) sc.shippingPayerId = sp.get('shipping_payer_id').split(',').map(Number);
            bodyObj.pageToken = pageToken;
            bodyObj.pageSize  = 120;

            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 15000);
            let data;
            try {
                const res = await fetch(tpl.url, {
                    method: tpl.method,
                    headers: tpl.headers,
                    credentials: 'include',
                    body: JSON.stringify(bodyObj),
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
                if (id && item.name && item.price != null) allItems[id] = { name: item.name, price: String(item.price) };
            });

            const nextToken = (data.meta && data.meta.nextPageToken) || data.nextPageToken || '';
            if (!nextToken || (data.items || []).length === 0) break;
            pageToken = nextToken;
            await sleep(300);
        }
        return allItems;
    }

    async function runCrawlerFetch(mfrs, selected) {
        const targets = selected.map(s => s.toUpperCase());
        const filtered = targets.includes('ALL') ? mfrs : mfrs.filter(m => targets.includes((m.group || '').toUpperCase()));
        if (filtered.length === 0) { updateStatus('対象なし'); return; }

        running = true;
        setRunningUI(true);
        let errors = 0;
        const allItems = {};  // 全メーカー分を蓄積

        for (let i = 0; i < filtered.length; i++) {
            if (!running) break;
            const mfr = filtered[i];
            const url = mfr.crawl_url || `https://jp.mercari.com/search?keyword=${encodeURIComponent(mfr.name)}&${BATCH_CONDITIONS}`;
            updateStatus(`[${i+1}/${filtered.length}] ${mfr.name} fetch中...`);

            try {
                const fetched = await fetchCollectorItems(url);
                errors = 0;
                Object.assign(allItems, fetched);
                updateStatus(`[${i+1}/${filtered.length}] ${mfr.name} ${Object.keys(fetched).length}件（累計${Object.keys(allItems).length}件）`);
                await sleep(300);
            } catch(e) {
                errors++;
                updateStatus(`[${i+1}/${filtered.length}] ${mfr.name} エラー(${errors}): ${e.message}`);
                if (errors >= 3 || e.message === 'NO_TEMPLATE') {
                    if (e.message === 'NO_TEMPLATE') {
                        updateStatus('テンプレートなし → 検索1回後に再試行してください');
                    } else if (/HTTP 4/.test(e.message)) {
                        _uw.localStorage.removeItem(_SHARED_TPL_KEY);
                        updateStatus('セッション切れ → ページ再読み込み後に再試行してください');
                    } else {
                        updateStatus(`エラー連続${errors}回 → 再試行してください: ${e.message}`);
                    }
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
            return;
        }

        // 全メーカー完了後に1回だけstep1を呼ぶ
        items = allItems;
        const grandTotal = Object.keys(items).length;
        updateStatus(`全${filtered.length}件完了（${grandTotal}件）→ step1送信中...`);
        GM_setClipboard(formatOutput());
        await new Promise(resolve => {
            GM_xmlhttpRequest({ method: 'POST', url: 'http://localhost:8765/run-step1', onload: resolve, onerror: resolve });
        });

        running = false;
        setRunningUI(false);
        updateStatus(`クローラーコレクト完了 全${filtered.length}件（${grandTotal}件）`);
    }

    // ========== 商品収集 ==========
    function collectItems() {
        document.querySelectorAll(ITEM_SEL).forEach(el => {
            const id = el.id;
            if (!id || items[id]) return;
            const name  = el.querySelector(NAME_SEL)?.textContent?.trim();
            const price = el.querySelector(PRICE_SEL)?.textContent?.trim().replace(/,/g, '');
            if (name && price) items[id] = { name, price };
        });
    }

    // ========== 商品が出るまで待つ ==========
    function waitForItems() {
        return new Promise(resolve => {
            const timer = setInterval(() => {
                if (document.querySelector(NAME_SEL)) { clearInterval(timer); resolve(); }
            }, 300);
            setTimeout(() => { clearInterval(timer); resolve(); }, 10000);
        });
    }

    // ========== URLが変わるまで待つ（SPA対応） ==========
    function waitForUrlChange(oldUrl) {
        return new Promise(resolve => {
            const timer = setInterval(() => {
                if (location.href !== oldUrl) { clearInterval(timer); resolve(); }
            }, 300);
            setTimeout(() => { clearInterval(timer); resolve(); }, 10000);
        });
    }

    // ========== スクロールしながら収集 ==========
    async function scrollAndCollect() {
        window.scrollTo(0, 0);
        await sleep(400);
        const deadline = Date.now() + MAX_SCROLL;

        while (Date.now() < deadline) {
            if (!running) return;
            collectItems();

            const atBottom =
                Math.ceil(window.scrollY + window.innerHeight) >= document.body.scrollHeight - 80;
            if (atBottom) {
                await sleep(800);
                collectItems();
                break;
            }
            window.scrollBy(0, SCROLL_STEP);
            await sleep(SCROLL_WAIT);
        }
    }

    // ========== 出力 ==========
    function formatOutput() {
        return Object.values(items)
            .map(({ price, name }) => `¥\n${price}\n${name}`)
            .join('\n');
    }

    function triggerStep1() {
        const isAuto = localStorage.getItem('autoPipeline') === 'true';
        const url = isAuto ? 'http://localhost:8765/run-step1?auto=1' : 'http://localhost:8765/run-step1';
        if (isAuto) localStorage.removeItem('autoPipeline');
        GM_xmlhttpRequest({
            method: 'POST',
            url: url,
            onload: function() {
                updateStatus(isAuto ? '完了！Step1→Step2を自動実行中...' : '完了！Step1を自動実行しました。');
            },
            onerror: function() {
                updateStatus('完了！（Step1を手動で実行してください）');
            },
        });
    }

    function finish(message, autoRun = false) {
        const total = Object.keys(items).length;
        // クローラーモード中は専用処理
        if (localStorage.getItem('crawlerMode') === 'true' && window.crawlerFinishOverride) {
            window.crawlerFinishOverride(message);
            return;
        }
        GM_setClipboard(formatOutput());
        running = false;
        setRunningUI(false);
        updateStatus(`${message}（${total}件）`);
        if (autoRun) {
            triggerStep1();
        }
        setTimeout(() => { statusEl.style.display = 'none'; }, 6000);
    }

    // ========== メインループ（SPAなのでページ内で継続） ==========
    async function run() {
        let pageCount = 0;

        while (running) {
            pageCount++;
            updateStatus(`収集中... ${pageCount}ページ目`);

            await waitForItems();
            await scrollAndCollect();

            if (!running) { finish('中止しました'); return; }

            const total   = Object.keys(items).length;
            const nextBtn = document.querySelector(NEXT_SEL);

            if (!nextBtn) {
                finish(`完了！ ${pageCount}ページ`, true);  // 自動でStep1起動
                return;
            }

            updateStatus(`${pageCount}ページ完了（累計 ${total} 件）、次のページへ...`);
            const currentUrl = location.href;
            nextBtn.click();
            await waitForUrlChange(currentUrl);
            await sleep(500);
        }

        finish('中止しました');
    }

    // ========== クローラーコレクト ==========
    // 型番収集は「売り切れ（販売済み）」商品から行う方針のため、crawl_url（F列・status=sold_out）を使用する
    const MFR_URL      = 'http://localhost:8765/get-manufacturers';
    const BATCH_CONDITIONS = 'status=sold_out&item_condition_id=1&shipping_payer_id=2';

    function showCrawlerGroupPicker(mfrs) {
        const groups = [...new Set(mfrs.map(m => m.group).filter(g => g))].sort((a, b) => a.localeCompare(b, 'ja', { numeric: true }));
        const groupCounts = {};
        mfrs.forEach(m => { if (m.group) groupCounts[m.group] = (groupCounts[m.group] || 0) + 1; });

        const overlay = document.createElement('div');
        overlay.id = 'crawler-group-picker-overlay';
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
        title.textContent = 'クローラーコレクト - グループを選択';
        title.style.cssText = 'font-weight:bold; font-size:15px; margin-bottom:14px; color:#333;';
        box.appendChild(title);

        const list = document.createElement('div');
        list.style.cssText = 'display:flex; flex-direction:column; gap:8px; margin-bottom:16px;';

        function makeOption(value, label, checked) {
            const wrap = document.createElement('label');
            wrap.style.cssText = 'display:flex; align-items:center; gap:8px; font-size:14px; color:#333; cursor:pointer;';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'crawler-group-picker-check';
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
            flex:1; padding:10px; background:#FF6F00; color:#fff; border:none;
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
            const checked = Array.from(list.querySelectorAll('.crawler-group-picker-check:checked')).map(c => c.value);
            const selected = checked.length > 0 ? checked : ['ALL'];
            overlay.remove();
            if (_getSharedTpl()) {
                runCrawlerFetch(mfrs, selected);
            } else {
                updateStatus('テンプレート未取得 → リアルタイムリサーチ起動後に再試行。従来モードで開始');
                runCrawlerWithGroups(mfrs, selected);
            }
        };
    }

    function runCrawlerWithGroups(mfrs, selected) {
        const targets = selected.map(s => s.toUpperCase());
        const filtered = targets.includes('ALL') ? mfrs : mfrs.filter(m => targets.includes((m.group || '').toUpperCase()));
        const label = targets.includes('ALL') ? 'ALL' : selected.join(',');

        if (filtered.length === 0) {
            updateStatus(`グループ「${label}」は見つかりません`);
            return;
        }
        localStorage.setItem('crawlerMode',  'true');
        localStorage.setItem('crawlerList',  JSON.stringify(filtered.map(m => ({name: m.name, url: m.crawl_url || ''}))));
        localStorage.setItem('crawlerIndex', '0');
        updateStatus(`クローラーコレクト開始 ${filtered.length}件（グループ:${label}・売り切れ条件）`);
        setTimeout(goNextCrawler, 1000);
    }

    function startCrawler() {
        GM_xmlhttpRequest({
            method: 'GET',
            url: MFR_URL,
            onload: function(res) {
                try {
                    const data = JSON.parse(res.responseText);
                    const mfrs = data.manufacturers || [];
                    if (mfrs.length === 0) {
                        updateStatus('メーカーリストが空です');
                        return;
                    }
                    showCrawlerGroupPicker(mfrs);
                } catch(e) {
                    updateStatus('取得失敗: ' + e);
                }
            },
            onerror: () => updateStatus('サーバー未起動'),
        });
    }

    function goNextCrawler() {
        const list  = JSON.parse(localStorage.getItem('crawlerList') || '[]');
        const index = parseInt(localStorage.getItem('crawlerIndex') || '0');
        if (index >= list.length) {
            localStorage.removeItem('crawlerMode');
            localStorage.removeItem('crawlerList');
            localStorage.removeItem('crawlerIndex');
            updateStatus(`クローラーコレクト完了！ 全${list.length}件`);
            setRunningUI(false);
            if (localStorage.getItem('autoPipeline') === 'true') {
                localStorage.removeItem('autoPipeline');
                setTimeout(() => window.close(), 5000);
            }
            return;
        }
        const item = list[index];
        const url  = item.url || `https://jp.mercari.com/search?keyword=${encodeURIComponent(item.name)}&${BATCH_CONDITIONS}`;
        updateStatus(`[${index+1}/${list.length}] ${item.name} へ移動中...`);
        location.href = url;
    }

    // クローラーモード中のページロード時に自動収集開始
    if (localStorage.getItem('crawlerMode') === 'true') {
        window.addEventListener('load', () => {
            setTimeout(() => {
                const list  = JSON.parse(localStorage.getItem('crawlerList') || '[]');
                const index = parseInt(localStorage.getItem('crawlerIndex') || '0');
                updateStatus(`[${index+1}/${list.length}] ${list[index]?.name} 収集中...`);
                running = true;
                items   = {};
                setRunningUI(true);
                window.crawlerFinishOverride = function(msg) {
                    running = false;
                    const itemList = Object.values(items);
                    GM_setClipboard(formatOutput());
                    triggerStep1();
                    localStorage.setItem('crawlerIndex', String(index + 1));
                    setTimeout(goNextCrawler, 4000);
                };
                run();
            }, 2000);
        });
    }

    // ========== 自動起動（タスクスケジューラ用） ==========
    // URLに ?auto_crawl=ALL をつけてChromeを起動するとクローラーコレクトが自動開始する
    if (localStorage.getItem('crawlerMode') !== 'true') {
        const autoGroup = new URLSearchParams(location.search).get('auto_crawl');
        if (autoGroup) {
            localStorage.setItem('autoPipeline', 'true');
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
                                if (_getSharedTpl()) {
                                    runCrawlerFetch(mfrs, groups);
                                } else {
                                    runCrawlerWithGroups(mfrs, groups);
                                }
                            } catch(e) { updateStatus('自動起動失敗: ' + e); }
                        },
                        onerror: () => updateStatus('サーバー未起動（auto_crawl）'),
                    });
                }, 3000);
            });
        }
    }

    // ========== ボタンイベント ==========
    startBtn.addEventListener('click', () => {
        running = true;
        items   = {};
        setRunningUI(true);
        run();
    });

    crawlerBtn.addEventListener('click', startCrawler);

    stopBtn.addEventListener('click', () => {
        running = false;
        localStorage.removeItem('crawlerMode');
        localStorage.removeItem('crawlerList');
        localStorage.removeItem('crawlerIndex');
    });

})();
