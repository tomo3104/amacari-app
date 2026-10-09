// ==UserScript==
// @name         Mercari Profile Inspector (調査用)
// @namespace    http://tampermonkey.net/
// @version      1.4
// @description  プロフィールページの「評価」タブのDOM構造を調査するための一時ツール（せどらー追跡の自動化準備、2026-10-09新設）
// @match        https://jp.mercari.com/user/profile/*
// @match        https://jp.mercari.com/user/reviews/*
// @grant        GM_setClipboard
// ==/UserScript==

(function () {
    'use strict';

    const btn = document.createElement('button');
    btn.textContent = '評価欄を調査';
    btn.style.cssText = 'position:fixed;top:20px;right:20px;z-index:99999;padding:12px 20px;background:#9C27B0;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,0.3);';
    document.body.appendChild(btn);

    const statusEl = document.createElement('div');
    statusEl.style.cssText = 'position:fixed;top:70px;right:20px;z-index:99999;background:rgba(0,0,0,0.78);color:#fff;padding:6px 14px;border-radius:6px;font-size:13px;display:none;max-width:400px;white-space:pre-wrap;';
    document.body.appendChild(statusEl);

    function updateStatus(msg) {
        statusEl.style.display = 'block';
        statusEl.textContent = msg;
    }

    function dumpCandidates() {
        const report = [];

        // mer-rating要素（レビュー1件ずつの入れ物と判明）を直接調査する
        const ratings = document.querySelectorAll('[data-testid="mer-rating"]');
        report.push('=== mer-rating要素の件数: ' + ratings.length + ' ===');
        [...ratings].slice(0, 5).forEach((el, i) => {
            report.push(`\n--- mer-rating[${i}] ---`);
            report.push('属性: ' + [...el.attributes].map(a => `${a.name}="${a.value}"`).join(' '));
            report.push('shadowRoot: ' + (el.shadowRoot ? 'あり(open)' : 'なし(closedまたは未使用)'));
            if (el.shadowRoot) {
                report.push('shadowRoot内HTML(先頭1500文字): ' + el.shadowRoot.innerHTML.slice(0, 1500));
            }
            report.push('lightDOM innerHTML(先頭1500文字): ' + el.innerHTML.slice(0, 1500));
            report.push('textContent: ' + el.textContent.trim().slice(0, 300));
        });

        return report.join('\n');
    }

    btn.onclick = () => {
        const text = dumpCandidates();
        GM_setClipboard(text);
        updateStatus('調査結果をクリップボードにコピーしました（' + text.length + '文字）。貼り付けて共有してください。');
        console.log(text);
    };
})();
