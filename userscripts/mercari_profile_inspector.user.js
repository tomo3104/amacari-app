// ==UserScript==
// @name         Mercari Profile Inspector (調査用)
// @namespace    http://tampermonkey.net/
// @version      1.6
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

        // DOM側が仮想化等で空のため、Next.jsのRSCストリーミングペイロード（scriptタグ内の
        // self.__next_f.push(...)）に埋め込まれた生データからキーワード周辺を直接探す
        const scripts = [...document.querySelectorAll('script')]
            .map(s => s.textContent)
            .filter(t => t && t.includes('self.__next_f.push'));
        report.push('=== 対象スクリプト数: ' + scripts.length + ' / 合計文字数: ' + scripts.reduce((a, t) => a + t.length, 0) + ' ===');

        const keywords = ['comment', 'Comment', 'rating', 'Rating', '良い', '残念', 'reviewee', 'reviewer', 'review'];
        const seen = new Set();
        let hits = 0;
        for (const text of scripts) {
            for (const kw of keywords) {
                let idx = 0;
                while (hits < 15) {
                    const pos = text.indexOf(kw, idx);
                    if (pos === -1) break;
                    const snippet = text.slice(Math.max(0, pos - 80), pos + 150);
                    if (!seen.has(snippet)) {
                        seen.add(snippet);
                        report.push(`\n--- "${kw}" 周辺 ---\n${snippet}`);
                        hits++;
                    }
                    idx = pos + kw.length;
                }
            }
        }

        return report.join('\n');
    }

    btn.onclick = () => {
        const text = dumpCandidates();
        GM_setClipboard(text);
        updateStatus('調査結果をクリップボードにコピーしました（' + text.length + '文字）。貼り付けて共有してください。');
        console.log(text);
    };
})();
