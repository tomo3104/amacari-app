// ==UserScript==
// @name         Mercari Category Fetcher
// @namespace    http://tampermonkey.net/
// @version      1.6
// @description  メルカリのカテゴリIDをURL変化から自動収集してローカルサーバーに送信
// @match        https://jp.mercari.com/*
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @updateURL    https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/mercari_category_fetcher.user.js
// @downloadURL  https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/mercari_category_fetcher.user.js
// ==/UserScript==

(function () {
    'use strict';

    const SERVER = 'http://localhost:8766/save-categories';

    // URL から category_id を抽出（クエリ文字列のみ対象・brand_id があっても可）
    function extractCatId(url) {
        const m = url.match(/[?&]category_id=(\d+)/);
        return m ? m[1] : null;
    }

    // カテゴリ名を複数ソースから取得（ポーリングで更新を待つ）
    function resolveNameAsync(id, callback) {
        const MAX_TRIES = 12; // 最大3秒 (250ms × 12)
        let tries = 0;
        const timer = setInterval(() => {
            tries++;
            // h1 → breadcrumb → document.title の優先順位で探す
            const h1 = document.querySelector('h1');
            const h1text = h1 ? h1.textContent.trim() : '';
            const breadEl = document.querySelector('[aria-label="breadcrumb"] li:last-child, nav[aria-label*="crumb"] li:last-child');
            const breadText = breadEl ? breadEl.textContent.trim() : '';
            const titleText = (document.title || '').replace(/\s*[-|｜].*$/, '').trim();

            const name = (h1text && h1text !== 'カテゴリー' && h1text !== 'メルカリ') ? h1text
                       : (breadText && breadText !== 'カテゴリー') ? breadText
                       : (titleText && titleText !== 'カテゴリー' && titleText !== 'メルカリ') ? titleText
                       : '';

            if (name || tries >= MAX_TRIES) {
                clearInterval(timer);
                callback(name || `カテゴリ_${id}`);
            }
        }, 250);
    }

    // ── 収集ストア ────────────────────────────────────────────────────────────
    const collected = {}; // { id: name }

    function tryCollect(url) {
        const id = extractCatId(url);
        if (!id || collected[id]) return;
        collected[id] = `カテゴリ_${id}`; // 仮置き
        updateBtn();
        resolveNameAsync(id, name => {
            collected[id] = name;
            updateBtn();
        });
    }

    // ── URLの変化を監視（SPA対応）────────────────────────────────────────────
    let _lastUrl = location.href;
    tryCollect(_lastUrl); // 初期URL

    const _origPush    = history.pushState.bind(history);
    const _origReplace = history.replaceState.bind(history);
    history.pushState = function (...args) {
        _origPush(...args);
        const url = location.href;
        if (url !== _lastUrl) { _lastUrl = url; tryCollect(url); }
    };
    history.replaceState = function (...args) {
        _origReplace(...args);
        const url = location.href;
        if (url !== _lastUrl) { _lastUrl = url; tryCollect(url); }
    };
    window.addEventListener('popstate', () => {
        const url = location.href;
        if (url !== _lastUrl) { _lastUrl = url; tryCollect(url); }
    });

    function sendToServer(payload) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method:  'POST',
                url:     SERVER,
                headers: { 'Content-Type': 'application/json' },
                data:    JSON.stringify(payload),
                timeout: 10000,
                onload:  res => res.status === 200 ? resolve() : reject(new Error(`status ${res.status}`)),
                onerror: () => reject(new Error('network error')),
                ontimeout: () => reject(new Error('timeout')),
            });
        });
    }

    // ── UI ───────────────────────────────────────────────────────────────────
    let btn = null;

    function updateBtn() {
        if (!btn) return;
        const n = Object.keys(collected).length;
        btn.textContent = n > 0 ? `📦 送信（${n}件）` : '📦 カテゴリ収集中…';
        btn.disabled = n === 0;
        btn.style.background = n > 0 ? '#6A1B9A' : '#616161';
    }

    setTimeout(() => {
        btn = document.createElement('button');
        btn.style.cssText = [
            'position:fixed', 'bottom:280px', 'left:8px', 'z-index:99999',
            'padding:7px 12px', 'border:none', 'border-radius:6px',
            'cursor:pointer', 'font-size:12px', 'font-weight:bold',
            'color:#fff', 'box-shadow:0 2px 6px rgba(0,0,0,.4)',
        ].join(';');
        updateBtn();

        btn.onclick = async () => {
            const cats = Object.entries(collected).map(([id, name]) => ({ id, name }));
            if (cats.length === 0) return;
            btn.textContent = '送信中…';
            btn.disabled = true;
            try {
                await sendToServer({ categories: cats, source: 'url-nav' });
                btn.textContent = `✅ ${cats.length}件送信完了`;
                btn.style.background = '#1b5e20';
            } catch (e) {
                btn.textContent = `❌ ${e.message}`;
                btn.style.background = '#c62828';
                btn.disabled = false;
            }
        };

        document.body.appendChild(btn);
    }, 1500);
})();
