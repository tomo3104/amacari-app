// ==UserScript==
// @name         Mercari Category Fetcher
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  メルカリの大カテゴリ一覧をローカルサーバーに送信（fetch intercept方式）
// @match        https://jp.mercari.com/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      localhost
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/mercari_category_fetcher.user.js
// @downloadURL  https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/mercari_category_fetcher.user.js
// ==/UserScript==

(function () {
    'use strict';

    const SERVER  = 'http://localhost:8766/save-categories';
    const _uw     = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
    let _captured = null;

    // ── fetch インターセプト ──────────────────────────────────────────────────
    const _origFetch = _uw.fetch;
    _uw.fetch = async function (...args) {
        const res = await _origFetch.apply(this, args);
        const url = (typeof args[0] === 'string') ? args[0] : (args[0] && args[0].url) || '';
        if (!_captured && url.includes('categor')) {
            try {
                const clone = res.clone();
                const data  = await clone.json();
                const cats  = findCatList(data);
                if (cats && cats.length > 0) {
                    const top = filterTopLevel(cats).map(normalize).filter(c => c.id && c.name);
                    if (top.length > 0) {
                        _captured = { endpoint: url, categories: top };
                        updateBtn();
                    }
                }
            } catch (e) {}
        }
        return res;
    };

    // ── XHR インターセプト ───────────────────────────────────────────────────
    const _origOpen = XMLHttpRequest.prototype.open;
    const _origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, url, ...rest) {
        this._mcfUrl = url;
        return _origOpen.apply(this, [m, url, ...rest]);
    };
    XMLHttpRequest.prototype.send = function (...args) {
        if (!_captured && this._mcfUrl && String(this._mcfUrl).includes('categor')) {
            this.addEventListener('load', () => {
                try {
                    const data = JSON.parse(this.responseText);
                    const cats = findCatList(data);
                    if (cats && cats.length > 0) {
                        const top = filterTopLevel(cats).map(normalize).filter(c => c.id && c.name);
                        if (top.length > 0) {
                            _captured = { endpoint: this._mcfUrl, categories: top };
                            updateBtn();
                        }
                    }
                } catch (e) {}
            });
        }
        return _origSend.apply(this, args);
    };

    // ── ユーティリティ ────────────────────────────────────────────────────────
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

    // ── UI ───────────────────────────────────────────────────────────────────
    let $btn = null;

    function updateBtn() {
        if (!$btn) return;
        if (_captured) {
            $btn.textContent = `📦 カテゴリ送信（${_captured.categories.length}件）`;
            $btn.style.background = '#1565c0';
            $btn.disabled = false;
        }
    }

    setTimeout(() => {
        $btn = document.createElement('button');
        $btn.textContent = '📦 待機中…';
        $btn.style.cssText = [
            'position:fixed', 'bottom:280px', 'left:8px', 'z-index:99999',
            'padding:7px 12px', 'border:none', 'border-radius:6px',
            'cursor:pointer', 'font-size:12px', 'font-weight:bold',
            'color:#fff', 'background:#616161', 'box-shadow:0 2px 6px rgba(0,0,0,.4)',
        ].join(';');
        $btn.disabled = true;

        $btn.onclick = async () => {
            if (!_captured) return;
            $btn.textContent = '送信中…';
            $btn.disabled = true;
            try {
                await sendToServer(_captured);
                $btn.textContent = `✅ ${_captured.categories.length}件完了`;
                $btn.style.background = '#1b5e20';
            } catch (e) {
                $btn.textContent = `❌ ${e.message}`;
                $btn.style.background = '#c62828';
                $btn.disabled = false;
            }
        };

        document.body.appendChild($btn);
        if (_captured) updateBtn();
    }, 1500);
})();
