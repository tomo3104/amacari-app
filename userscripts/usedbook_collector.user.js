// ==UserScript==
// @name         中古本 出品中収集（全カテゴリ巡回）
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  中古本せどり企画：出品中(status=on_sale)の商品を全カテゴリ巡回収集する。2026-10-27：category_targets.json(サーバーの/get-usedbook-categoriesから配信)の有効カテゴリを順番に自動巡回する方式に汎用化（単一カテゴリ固定のv1系から、usedbook_sold_collector.user.jsと同じ設計に統一）。item_condition_id=1,2,3のみ対象。カテゴリ完了ごとに中間送信するので途中で止めても収集済み分は失われない。テンプレート失効時の再取得リトライも搭載。
// @match        https://jp.mercari.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @grant        unsafeWindow
// @connect      localhost
// @connect      jp.mercari.com
// ==/UserScript==
(function () {
    'use strict';

    const SERVER_URL      = 'http://localhost:8766/save-usedbook-items';
    const CATEGORIES_URL  = 'http://localhost:8766/get-usedbook-categories';
    const MAX_PAGES        = 100;  // 出品中は売り切れ累積よりずっと少ないはずなので売り切れ収集(300)より小さい上限で十分
    const _SHARED_TPL_KEY  = 'mercari_api_shared_tpl';
    const _uw = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    function _getSharedTpl() {
        try {
            const s = _uw.localStorage.getItem(_SHARED_TPL_KEY);
            return s ? JSON.parse(s) : null;
        } catch (e) { return null; }
    }

    async function ensureTemplate() {
        if (_getSharedTpl()) return true;
        updateStatus('テンプレート未取得 → 裏タブで取得中...');
        GM_openInTab('https://jp.mercari.com/search?keyword=sony&status=sold_out', { active: false });
        return await waitForTemplate(20000);
    }

    async function waitForTemplate(maxMs) {
        const deadline = Date.now() + maxMs;
        while (Date.now() < deadline) {
            if (_getSharedTpl()) return true;
            await sleep(1000);
        }
        return !!_getSharedTpl();
    }

    function fetchCategories() {
        return new Promise(resolve => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: CATEGORIES_URL,
                timeout: 15000,
                onload: res => {
                    try {
                        const data = JSON.parse(res.responseText);
                        resolve((data.categories || []).filter(c => c.enabled !== false));
                    } catch (e) { resolve([]); }
                },
                onerror: () => resolve([]),
                ontimeout: () => resolve([]),
            });
        });
    }

    async function fetchAllItemsForCategory(categoryId) {
        if (!_getSharedTpl()) throw new Error('NO_TEMPLATE');

        const allItems = {};
        let pageToken = '';

        for (let page = 0; page < MAX_PAGES; page++) {
            // usedbook_sold_collector.user.js v2.1と同じテンプレート失効検知→再取得→リトライ
            let data = null;
            for (let attempt = 0; attempt < 2; attempt++) {
                const tpl = _getSharedTpl();
                if (!tpl) throw new Error('NO_TEMPLATE');

                const bodyObj = JSON.parse(tpl.body);
                const sc = bodyObj.searchCondition = bodyObj.searchCondition || {};
                sc.keyword = '';
                sc.excludeKeyword = '';
                sc.status = ['STATUS_ON_SALE'];
                delete sc.brandId;
                sc.categoryId = [Number(categoryId)];
                delete sc.priceMin;
                delete sc.priceMax;
                sc.itemConditionId = [1, 2, 3];
                delete sc.shippingPayerId;
                bodyObj.pageToken = pageToken;
                bodyObj.pageSize = 120;

                const ctrl = new AbortController();
                const timer = setTimeout(() => ctrl.abort(), 15000);
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
                    break;
                } catch (e) {
                    clearTimeout(timer);
                    if (attempt === 0 && /HTTP 4/.test(e.message)) {
                        updateStatus(`p${page + 1}: テンプレート失効 → 再取得中...`);
                        _uw.localStorage.removeItem(_SHARED_TPL_KEY);
                        GM_openInTab('https://jp.mercari.com/search?keyword=sony&status=sold_out', { active: false });
                        if (await waitForTemplate(20000)) continue;
                    }
                    updateStatus(`p${page + 1}でエラー: ${e.message} → このカテゴリは打ち切り`);
                    // 2026-10-27追加：ここで打ち切った場合は「このカテゴリの全件」ではなく
                    // 途中までの不完全な結果なので、complete:falseを返す。サーバー側が
                    // これをそのカテゴリの全件と誤認して、まだ売ってる後半ページの商品を
                    // 「今回出てこなかった＝消えた」と判断し間違って削除する事故を防ぐため。
                    return { items: Object.values(allItems), complete: false };
                }
            }
            if (!data) break;

            (data.items || []).forEach(item => {
                const id = item.id || item.itemId;
                if (id && item.name && item.price != null) {
                    allItems[id] = {
                        id,
                        name: item.name,
                        price: String(item.price),
                        itemConditionId: item.itemConditionId != null ? String(item.itemConditionId) : '',
                        categoryId: String(categoryId),
                        thumbnail: (item.thumbnails && item.thumbnails[0]) || '',
                        url: `https://jp.mercari.com/item/${id}`,
                    };
                }
            });

            const nextToken = (data.meta && data.meta.nextPageToken) || data.nextPageToken || '';
            if (!nextToken || (data.items || []).length === 0) break;
            pageToken = nextToken;
            await sleep(300);
        }
        return { items: Object.values(allItems), complete: true };
    }

    function sendToServer(items, categoryId, complete) {
        return new Promise(resolve => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: SERVER_URL,
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify({ items, categoryId: String(categoryId), complete }),
                timeout: 30000,
                onload: res => resolve(res.responseText),
                onerror: () => resolve(null),
                ontimeout: () => resolve(null),
            });
        });
    }

    let statusEl;
    function updateStatus(msg) {
        if (statusEl) statusEl.textContent = '📚 ' + msg;
        console.log('[中古本出品中収集]', msg);
    }

    async function run() {
        btn.disabled = true;
        const ok = await ensureTemplate();
        if (!ok) { updateStatus('テンプレート取得失敗'); btn.disabled = false; return; }

        const categories = await fetchCategories();
        if (categories.length === 0) { updateStatus('カテゴリ一覧取得失敗（サーバー未起動？）'); btn.disabled = false; return; }

        let totalSent = 0;
        for (let i = 0; i < categories.length; i++) {
            const cat = categories[i];
            updateStatus(`[${i + 1}/${categories.length}] ${cat.name} 収集中...`);
            try {
                const { items, complete } = await fetchAllItemsForCategory(cat.category_id);
                updateStatus(`[${i + 1}/${categories.length}] ${cat.name}: ${items.length}件${complete ? '' : '(不完全)'} → 送信中...`);
                const res = await sendToServer(items, cat.category_id, complete);
                totalSent += items.length;
                updateStatus(`[${i + 1}/${categories.length}] ${cat.name}: 完了(${res || '送信失敗'})`);
            } catch (e) {
                updateStatus(`[${i + 1}/${categories.length}] ${cat.name}: エラー(${e.message}) → 次へ`);
            }
            await sleep(500);
        }
        updateStatus(`全カテゴリ完了: 累計送信${totalSent}件`);
        btn.disabled = false;
    }

    // 中古本企画専用スタック（電化製品側の既存スクリプトとは別、左上）
    function _amacariGetStack() {
        let el = document.getElementById('usedbook-fixed-stack-tl');
        if (!el) {
            el = document.createElement('div');
            el.id = 'usedbook-fixed-stack-tl';
            el.style.cssText = `
                position:fixed; top:20px; left:20px; z-index:99999;
                display:flex; flex-direction:column; align-items:flex-start; gap:8px;
            `;
            document.body.appendChild(el);
        }
        return el;
    }

    let btn;
    function initUI() {
        btn = document.createElement('button');
        btn.textContent = '📚 中古本 出品中収集（全カテゴリ）';
        btn.style.cssText = `
            padding:10px 14px; background:#6A1B9A; color:#fff; border:none;
            border-radius:8px; font-size:13px; font-weight:600; cursor:pointer;
            box-shadow:0 2px 6px rgba(0,0,0,0.3); order:20;
        `;
        btn.onclick = run;

        statusEl = document.createElement('div');
        statusEl.style.cssText = 'background:rgba(0,0,0,0.80); color:#fff; font-size:12px; padding:6px 10px; border-radius:6px; max-width:300px; order:20;';
        statusEl.textContent = '📚 待機中';

        _amacariGetStack().appendChild(btn);
        _amacariGetStack().appendChild(statusEl);
    }

    if (document.body) {
        initUI();
    } else {
        window.addEventListener('DOMContentLoaded', initUI);
    }
})();
