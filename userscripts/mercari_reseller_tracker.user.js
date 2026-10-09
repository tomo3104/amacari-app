// ==UserScript==
// @name         Mercari Reseller Tracker - Step1 評価履歴取得
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  せどらーと思われる購入者の評価履歴（/reviews/history API）から、売ってくれたセラー一覧を抽出する（2026-10-09新設）。
// @match        https://jp.mercari.com/user/reviews/*
// @match        https://jp.mercari.com/user/profile/*
// @grant        GM_setClipboard
// ==/UserScript==

(function () {
    'use strict';

    function getUserIdFromUrl() {
        const m = location.pathname.match(/\/user\/(?:reviews|profile)\/(\d+)/);
        return m ? m[1] : null;
    }

    async function fetchReviewHistory(userId) {
        const url = `https://api.mercari.jp/reviews/history?user_id=${userId}&subject=seller,buyer&fame=good,normal,bad&limit=100`;
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const json = await res.json();
        return json.data || [];
    }

    function formatDate(unixSec) {
        const d = new Date(unixSec * 1000);
        return d.toISOString().slice(0, 10);
    }

    function buildReport(userId, entries) {
        // subject==="buyer" ＝ このユーザーが買い手として受け取った評価＝相手(user)はその取引の売り手
        const asBuyer = entries.filter(e => e.subject === 'buyer');

        const bySeller = new Map();
        for (const e of asBuyer) {
            const sid = e.user.id;
            if (!bySeller.has(sid)) {
                bySeller.set(sid, { id: sid, name: e.user.name, count: 0, lastCreated: 0, dates: [] });
            }
            const s = bySeller.get(sid);
            s.count++;
            s.dates.push(e.created);
            if (e.created > s.lastCreated) s.lastCreated = e.created;
        }

        const sellers = [...bySeller.values()].sort((a, b) => b.lastCreated - a.lastCreated);

        const lines = [];
        lines.push(`対象ユーザーID: ${userId}`);
        lines.push(`取得件数: ${entries.length}件（うち買い手として受けた評価: ${asBuyer.length}件）`);
        lines.push(`ユニークなセラー数: ${sellers.length}`);
        lines.push('');
        lines.push('=== セラー一覧（直近の取引日が新しい順） ===');
        lines.push('sellerId\tsellerName\t取引回数\t直近取引日\tストアURL');
        for (const s of sellers) {
            lines.push(`${s.id}\t${s.name}\t${s.count}\t${formatDate(s.lastCreated)}\thttps://jp.mercari.com/user/profile/${s.id}`);
        }
        lines.push('');
        lines.push('=== 評価の生データ（日付が新しい順） ===');
        lines.push('日付\tsellerId\tsellerName\t評価\tコメント');
        for (const e of asBuyer.sort((a, b) => b.created - a.created)) {
            lines.push(`${formatDate(e.created)}\t${e.user.id}\t${e.user.name}\t${e.fame}\t${(e.message || '').replace(/\n/g, ' ')}`);
        }
        return lines.join('\n');
    }

    function mountUI() {
        const btn = document.createElement('button');
        btn.textContent = '評価履歴→セラー一覧を抽出';
        btn.style.cssText = 'position:fixed;top:20px;right:20px;z-index:99999;padding:12px 20px;background:#9C27B0;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,0.3);';
        document.body.appendChild(btn);

        const statusEl = document.createElement('div');
        statusEl.style.cssText = 'position:fixed;top:70px;right:20px;z-index:99999;background:rgba(0,0,0,0.78);color:#fff;padding:6px 14px;border-radius:6px;font-size:13px;display:none;max-width:400px;white-space:pre-wrap;';
        document.body.appendChild(statusEl);

        function updateStatus(msg) {
            statusEl.style.display = 'block';
            statusEl.textContent = msg;
        }

        btn.onclick = async () => {
            const userId = getUserIdFromUrl();
            if (!userId) { updateStatus('ユーザーIDがURLから取得できません'); return; }
            btn.disabled = true;
            updateStatus('取得中...');
            try {
                const entries = await fetchReviewHistory(userId);
                const report = buildReport(userId, entries);
                GM_setClipboard(report);
                updateStatus('完了！クリップボードにコピーしました（' + report.length + '文字）');
                console.log(report);
            } catch (e) {
                updateStatus('失敗: ' + e.message);
            }
            btn.disabled = false;
        };
    }

    if (document.body) {
        mountUI();
    } else {
        document.addEventListener('DOMContentLoaded', mountUI);
    }
})();
