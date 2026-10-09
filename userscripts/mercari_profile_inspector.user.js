// ==UserScript==
// @name         Mercari Profile Inspector (調査用)
// @namespace    http://tampermonkey.net/
// @version      2.2
// @description  プロフィールページ「評価」タブの実データ取得APIを特定するための一時ツール（せどらー追跡の自動化準備、2026-10-09新設）
// @match        https://jp.mercari.com/user/profile/*
// @match        https://jp.mercari.com/user/reviews/*
// @grant        GM_setClipboard
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // 2026-10-09：fetchだけだと0件だったため、XHRも横取りする。また「review/rating」という
    // 文字列に限定せず、静的ファイル（js/css/画像/フォント）と既知の外部トラッカーを除外した
    // 全通信を対象にする（URLに"review"を含まないAPI設計の可能性があるため）。
    const captured = [];
    const EXCLUDE_EXT = /\.(js|css|png|jpe?g|svg|woff2?|ico|webmanifest)(\?|$)/i;
    const EXCLUDE_HOST = /(google|doubleclick|sentry|segment|facebook|gtm|newrelic|datadog)/i;

    function shouldLog(url) {
        if (!url || typeof url !== 'string') return false;
        if (EXCLUDE_EXT.test(url)) return false;
        if (EXCLUDE_HOST.test(url)) return false;
        return true;
    }

    function record(method, url, status, bodyPromiseOrText) {
        if (!shouldLog(url)) return;
        const entry = { method, url, status, body: '' };
        captured.push(entry);
        if (bodyPromiseOrText && typeof bodyPromiseOrText.then === 'function') {
            bodyPromiseOrText.then(t => { entry.body = (t || '').slice(0, 3000); }).catch(() => {});
        } else if (typeof bodyPromiseOrText === 'string') {
            entry.body = bodyPromiseOrText.slice(0, 3000);
        }
    }

    const _uw = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
    const origFetch = _uw.fetch;
    _uw.fetch = async function (...args) {
        const res = await origFetch.apply(this, args);
        try {
            const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
            const method = (args[1] && args[1].method) || 'GET';
            record(method, url, res.status, res.clone().text());
        } catch (e) {}
        return res;
    };

    const OrigXHR = _uw.XMLHttpRequest;
    function PatchedXHR() {
        const xhr = new OrigXHR();
        let _method = 'GET', _url = '';
        const origOpen = xhr.open;
        xhr.open = function (method, url, ...rest) {
            _method = method; _url = url;
            return origOpen.call(xhr, method, url, ...rest);
        };
        xhr.addEventListener('loadend', function () {
            try {
                record(_method, _url, xhr.status, xhr.responseText);
            } catch (e) {}
        });
        return xhr;
    }
    _uw.XMLHttpRequest = PatchedXHR;

    function mountUI() {
        const btn = document.createElement('button');
        btn.style.cssText = 'position:fixed;top:20px;right:20px;z-index:99999;padding:12px 20px;background:#9C27B0;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,0.3);';
        document.body.appendChild(btn);

        const statusEl = document.createElement('div');
        statusEl.style.cssText = 'position:fixed;top:70px;right:20px;z-index:99999;background:rgba(0,0,0,0.78);color:#fff;padding:6px 14px;border-radius:6px;font-size:13px;display:none;max-width:400px;white-space:pre-wrap;';
        document.body.appendChild(statusEl);

        setInterval(() => {
            btn.textContent = '捕まえた通信をコピー(' + captured.length + ')';
        }, 500);

        btn.onclick = () => {
            // まずURL一覧だけ（本文無し）を見やすく出す。本文は長いので別枠にまとめる
            const urlList = captured.map((c, i) => `[${i}] ${c.method} ${c.status} ${c.url}`).join('\n');
            const bodies = captured.map((c, i) => `=== [${i}] ${c.url} ===\n${c.body}`).join('\n\n');
            const text = '◆URL一覧\n' + urlList + '\n\n◆本文\n' + bodies;
            GM_setClipboard(text || '（何も捕まえていません）');
            statusEl.style.display = 'block';
            statusEl.textContent = text.length + '文字をコピーしました（' + captured.length + '件）';
            console.log(text);
        };
    }

    if (document.body) {
        mountUI();
    } else {
        document.addEventListener('DOMContentLoaded', mountUI);
    }
})();
