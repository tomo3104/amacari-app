// ==UserScript==
// @name         PayPayフリマ カテゴリAPI捕捉
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  PayPayフリマの検索ページはカテゴリ一覧が生HTMLに出てこず、読み込み後にJSが内部APIを叩いて取得する構造だったため（2026-10-24調査で確認）、fetch/XHRを横取りしてURLまたは本文に「categor」を含む通信を捕捉し、localhost:8766へ送信してファイルに保存する。
// @match        https://paypayfleamarket.yahoo.co.jp/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// ==/UserScript==
(function () {
    'use strict';
    const uw = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
    const SERVER_URL = 'http://localhost:8766/save-paypay-categories';

    const captured = new Map(); // url -> body（重複送信防止）

    function updateBadge() {
        const el = document.getElementById('_ppCategorySnifferBadge');
        if (el) el.textContent = `📦 カテゴリAPI捕捉: ${captured.size}件`;
    }

    function send() {
        GM_xmlhttpRequest({
            method: 'POST',
            url: SERVER_URL,
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify({
                captures: Array.from(captured.entries()).map(([url, body]) => ({ url, body })),
            }),
            onerror: () => {},
            ontimeout: () => {},
        });
    }

    function handle(url, text) {
        if (!text || text.length > 2_000_000) return; // 巨大なJS/CSSバンドル等はスキップ
        const lower = text.slice(0, 5000).toLowerCase();
        if (!url.toLowerCase().includes('categor') && !lower.includes('categor')) return;
        if (captured.has(url)) return;
        let body;
        try {
            body = JSON.parse(text);
        } catch (e) {
            return; // JSONとして読めない（HTML等）は対象外
        }
        captured.set(url, body);
        updateBadge();
        send();
        console.log('[カテゴリAPI捕捉]', url, body);
    }

    const origFetch = uw.fetch;
    uw.fetch = async function (...args) {
        const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
        const res = await origFetch.apply(this, args);
        try { res.clone().text().then(text => handle(url, text)).catch(() => {}); } catch (e) {}
        return res;
    };

    const OrigXHR = uw.XMLHttpRequest;
    function PatchedXHR() {
        const xhr = new OrigXHR();
        let _url = '';
        const origOpen = xhr.open;
        xhr.open = function (method, url, ...rest) {
            _url = url;
            return origOpen.call(xhr, method, url, ...rest);
        };
        xhr.addEventListener('loadend', function () {
            try { handle(_url, xhr.responseText); } catch (e) {}
        });
        return xhr;
    }
    uw.XMLHttpRequest = PatchedXHR;

    // 捕捉状況を見えるようにする小さいバッジ（右下固定）
    window.addEventListener('DOMContentLoaded', () => {
        const badge = document.createElement('div');
        badge.id = '_ppCategorySnifferBadge';
        badge.textContent = '📦 カテゴリAPI捕捉: 0件';
        badge.style.cssText = `
            position:fixed; bottom:10px; right:10px; z-index:999999;
            background:rgba(0,0,0,0.75); color:#fff; font-size:12px;
            padding:6px 10px; border-radius:6px; font-family:sans-serif;
        `;
        document.body.appendChild(badge);
    });

    // 2026-10-24追加：category選択UIがAPI通信ではなく静的データ/DOM直接操作で
    // 埋まっている可能性があったため、select[name="category"]のoption増加を直接監視する。
    function dumpSelectIfPopulated(select) {
        const key = 'dom:' + (select.name || select.id || 'category_select');
        if (select.options.length <= 1) return; // 「すべて」のみなら未入力
        if (captured.has(key) && captured.get(key).length === select.options.length) return;
        const options = Array.from(select.options).map(o => ({ value: o.value, text: o.textContent.trim() }));
        captured.set(key, options);
        updateBadge();
        send();
        console.log('[カテゴリSELECT捕捉]', key, options);
    }

    const observer = new MutationObserver(() => {
        document.querySelectorAll('select[name="category"], select[name*="categor" i]').forEach(dumpSelectIfPopulated);
    });
    window.addEventListener('DOMContentLoaded', () => {
        observer.observe(document.body, { childList: true, subtree: true });
        document.querySelectorAll('select[name="category"], select[name*="categor" i]').forEach(dumpSelectIfPopulated);
    });
})();
