// ==UserScript==
// @name         Mercari Category Fetcher
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  メルカリの大カテゴリ一覧をローカルサーバーに送信（1回実行用）
// @match        https://jp.mercari.com/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      localhost
// @updateURL    https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/mercari_category_fetcher.user.js
// @downloadURL  https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/mercari_category_fetcher.user.js
// ==/UserScript==

(function () {
    'use strict';

    const SERVER = 'http://localhost:8766/save-categories';
    const DONE_KEY = 'mcf_done';

    // 大カテゴリのみ（parentId が空 or "0" のもの）に絞る
    function filterTopLevel(cats) {
        return cats.filter(c => {
            const parent = String(c.parentId || c.parent_id || c.parentCategoryId || '');
            return parent === '' || parent === '0' || parent === 'null';
        });
    }

    function normalize(cat) {
        return {
            id:   String(cat.id || cat.categoryId || cat.category_id || ''),
            name: String(cat.name || cat.displayName || cat.label || ''),
        };
    }

    async function fetchCategories() {
        const endpoints = [
            'https://api.mercari.jp/master/v1/categories',
            'https://api.mercari.jp/v2/master:getCategories',
        ];
        for (const ep of endpoints) {
            try {
                const res = await fetch(ep, {
                    credentials: 'include',
                    headers: { 'x-platform': 'web', 'Accept': 'application/json' },
                });
                if (!res.ok) continue;
                const data = await res.json();
                // カテゴリリストを再帰的に探す
                const cats = findCatList(data);
                if (cats && cats.length > 0) {
                    const top = filterTopLevel(cats).map(normalize).filter(c => c.id && c.name);
                    if (top.length > 0) return { endpoint: ep, categories: top, all_count: cats.length };
                }
            } catch (e) {}
        }
        return null;
    }

    function findCatList(obj, depth) {
        depth = depth || 0;
        if (depth > 8) return null;
        if (Array.isArray(obj) && obj.length >= 3) {
            const sample = obj.slice(0, 5).filter(x => x && typeof x === 'object');
            if (sample.length >= 2) {
                const hasId   = sample.filter(x => 'id' in x || 'categoryId' in x || 'category_id' in x).length;
                const hasName = sample.filter(x => 'name' in x || 'displayName' in x || 'label' in x).length;
                if (hasId >= 2 && hasName >= 2) return obj;
            }
        }
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
            for (const v of Object.values(obj)) {
                const r = findCatList(v, depth + 1);
                if (r) return r;
            }
        }
        return null;
    }

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

    setTimeout(async () => {

        const btn = document.createElement('button');
        btn.textContent = '📦 カテゴリ取得';
        btn.style.cssText = [
            'position:fixed', 'bottom:280px', 'left:8px', 'z-index:99999',
            'padding:7px 12px', 'border:none', 'border-radius:6px',
            'cursor:pointer', 'font-size:12px', 'font-weight:bold',
            'color:#fff', 'background:#6A1B9A', 'box-shadow:0 2px 6px rgba(0,0,0,.4)',
        ].join(';');

        btn.onclick = async () => {
            btn.textContent = '取得中…';
            btn.disabled = true;
            try {
                const result = await fetchCategories();
                if (!result) {
                    btn.textContent = '❌ 取得失敗';
                    btn.style.background = '#c62828';
                    return;
                }
                await sendToServer(result);
                btn.textContent = `✅ ${result.categories.length}件送信完了`;
                btn.style.background = '#1b5e20';
            } catch (e) {
                btn.textContent = `❌ ${e.message}`;
                btn.style.background = '#c62828';
                btn.disabled = false;
            }
        };

        document.body.appendChild(btn);
    });
})();
