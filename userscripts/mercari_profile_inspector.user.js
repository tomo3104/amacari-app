// ==UserScript==
// @name         Mercari Profile Inspector (調査用)
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  プロフィールページ「評価」タブの実データ取得APIを特定するための一時ツール（せどらー追跡の自動化準備、2026-10-09新設）
// @match        https://jp.mercari.com/user/profile/*
// @match        https://jp.mercari.com/user/reviews/*
// @grant        GM_setClipboard
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // 2026-10-09：DOM側のレビュー一覧が仮想化等で空だったため、ページ自身が発行する
    // 実データ取得のfetch通信そのものを横取りする。ページの初期化より前に仕込む必要があるため
    // document-startで動かす（UIの構築はbody生成後に行う）。
    const captured = [];
    const origFetch = window.fetch;
    window.fetch = async function (...args) {
        const res = await origFetch.apply(this, args);
        try {
            const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
            if (/review|rating/i.test(url)) {
                const clone = res.clone();
                clone.text().then(body => {
                    captured.push({ url, status: res.status, body: body.slice(0, 20000) });
                }).catch(() => {});
            }
        } catch (e) {}
        return res;
    };

    function mountUI() {
        const btn = document.createElement('button');
        btn.textContent = '捕まえた通信をコピー(' + captured.length + ')';
        btn.style.cssText = 'position:fixed;top:20px;right:20px;z-index:99999;padding:12px 20px;background:#9C27B0;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,0.3);';
        document.body.appendChild(btn);

        const statusEl = document.createElement('div');
        statusEl.style.cssText = 'position:fixed;top:70px;right:20px;z-index:99999;background:rgba(0,0,0,0.78);color:#fff;padding:6px 14px;border-radius:6px;font-size:13px;display:none;max-width:400px;white-space:pre-wrap;';
        document.body.appendChild(statusEl);

        setInterval(() => {
            btn.textContent = '捕まえた通信をコピー(' + captured.length + ')';
        }, 1000);

        btn.onclick = () => {
            const text = captured.map((c, i) =>
                `=== [${i}] ${c.status} ${c.url} ===\n${c.body}`
            ).join('\n\n');
            GM_setClipboard(text || '（何も捕まえていません。ページをリロードしてから少し待って押してください）');
            statusEl.style.display = 'block';
            statusEl.textContent = (text.length) + '文字をコピーしました（' + captured.length + '件の通信）';
            console.log(text);
        };
    }

    if (document.body) {
        mountUI();
    } else {
        document.addEventListener('DOMContentLoaded', mountUI);
    }
})();
