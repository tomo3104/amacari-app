// ==UserScript==
// @name         メルカリ カテゴリAPI捕捉
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  本カテゴリのサブカテゴリ一覧調査用（中古本せどり企画・2026-10-27）。fetch/XHRを横取りしてURLまたは本文に「categor」を含む通信を捕捉し、localhost:8766へ送信してファイルに保存する。メルカリはReact Server Componentsでページ本体に埋め込まれている可能性もあるため、埋め込みscriptタグも合わせてスキャンする。
// @match        https://jp.mercari.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// ==/UserScript==
(function () {
    'use strict';
    const uw = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
    const SERVER_URL = 'http://localhost:8766/save-mercari-categories';

    const captured = new Map();

    function updateBadge() {
        const el = document.getElementById('_merCategorySnifferBadge');
        if (el) el.textContent = `📦 カテゴリ捕捉: ${captured.size}件`;
    }

    function send() {
        GM_xmlhttpRequest({
            method: 'POST',
            url: SERVER_URL,
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify({
                captures: Array.from(captured.entries()).map(([key, body]) => ({ key, body })),
            }),
            onerror: () => {},
            ontimeout: () => {},
        });
    }

    function handle(key, text) {
        if (!text || text.length > 3_000_000) return;
        const lower = text.slice(0, 8000).toLowerCase();
        if (!key.toLowerCase().includes('categor') && !lower.includes('categor')) return;
        if (captured.has(key)) return;
        let body;
        try {
            body = JSON.parse(text);
        } catch (e) {
            return;
        }
        captured.set(key, body);
        updateBadge();
        send();
        console.log('[カテゴリ捕捉]', key, body);
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

    // 2026-10-27追加：メルカリはReact Server Componentsでページ本体に初期データを
    // 埋め込んでいる場合があり、fetch/XHRでは捕捉できないことがある。
    // ページ内の<script>タグ本文もスキャンしてcategorを含むJSONらしき断片を探す。
    function scanEmbeddedScripts() {
        document.querySelectorAll('script').forEach((el, i) => {
            const text = el.textContent || '';
            if (text.length < 20 || text.length > 3_000_000) return;
            if (!text.toLowerCase().includes('categor')) return;
            const key = `embedded-script-${i}`;
            if (captured.has(key)) return;
            // JSON全体として読めなくても、categorを含む行だけでも保存する
            let body;
            try {
                body = JSON.parse(text);
            } catch (e) {
                body = { raw_snippet: text.slice(0, 50000) };
            }
            captured.set(key, body);
            updateBadge();
            send();
            console.log('[埋め込みscript捕捉]', key);
        });
    }

    window.addEventListener('DOMContentLoaded', () => {
        const badge = document.createElement('div');
        badge.id = '_merCategorySnifferBadge';
        badge.textContent = '📦 カテゴリ捕捉: 0件';
        badge.style.cssText = `
            position:fixed; bottom:10px; right:10px; z-index:999999;
            background:rgba(0,0,0,0.75); color:#fff; font-size:12px;
            padding:6px 10px; border-radius:6px; font-family:sans-serif;
        `;
        document.body.appendChild(badge);
        setTimeout(scanEmbeddedScripts, 1000);
        setTimeout(scanEmbeddedScripts, 4000);
    });
})();
