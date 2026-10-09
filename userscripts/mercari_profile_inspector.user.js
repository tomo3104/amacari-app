// ==UserScript==
// @name         Mercari Profile Inspector (調査用)
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  プロフィールページの「評価」タブのDOM構造を調査するための一時ツール（せどらー追跡の自動化準備、2026-10-09新設）
// @match        https://jp.mercari.com/user/profile/*
// @match        https://jp.mercari.com/user/reviews/*
// @grant        GM_setClipboard
// ==/UserScript==

(function () {
    'use strict';

    const btn = document.createElement('button');
    btn.textContent = '評価欄を調査';
    btn.style.cssText = 'position:fixed;bottom:20px;left:20px;z-index:99999;padding:12px 20px;background:#9C27B0;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,0.3);';
    document.body.appendChild(btn);

    const statusEl = document.createElement('div');
    statusEl.style.cssText = 'position:fixed;bottom:70px;left:20px;z-index:99999;background:rgba(0,0,0,0.78);color:#fff;padding:6px 14px;border-radius:6px;font-size:13px;display:none;max-width:400px;white-space:pre-wrap;';
    document.body.appendChild(statusEl);

    function updateStatus(msg) {
        statusEl.style.display = 'block';
        statusEl.textContent = msg;
    }

    function dumpCandidates() {
        const report = [];

        // 「評価」という文字を含む要素を手がかりに、周辺のdata-testid属性を探す
        const allEls = document.querySelectorAll('[data-testid]');
        const testids = new Set();
        allEls.forEach(el => testids.add(el.getAttribute('data-testid')));
        report.push('=== ページ内の全data-testid一覧 ===');
        report.push([...testids].sort().join('\n'));

        // 評価件数らしきテキストを含む要素
        report.push('\n=== 「評価」を含むテキスト要素（上位20件） ===');
        const texted = [...document.querySelectorAll('body *')]
            .filter(el => el.children.length === 0 && el.textContent && el.textContent.includes('評価'))
            .slice(0, 20);
        texted.forEach(el => {
            report.push(`[${el.tagName}.${el.className}] "${el.textContent.trim()}"`);
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
