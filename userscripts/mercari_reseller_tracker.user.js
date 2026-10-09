// ==UserScript==
// @name         Mercari Reseller Tracker - Step1 評価履歴取得
// @namespace    http://tampermonkey.net/
// @version      2.1
// @description  せどらーと思われる購入者の評価履歴（/reviews/history API）から、売ってくれたセラー一覧を抽出する（2026-10-09新設）。
// @match        https://jp.mercari.com/user/reviews/*
// @match        https://jp.mercari.com/user/profile/*
// @grant        GM_setClipboard
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // 2026-10-09：/reviews/history を自前でfetchするとHTTP 400になった（おそらく
    // ページ自身が付与している認証ヘッダー類が再現できていない）。そのため自前で
    // 呼び直すのではなく、ページ自身が成功させた本物の通信を横取りして使う
    // （mercari_auto_collector.user.jsのテンプレート捕捉と同じ発想）。
    const _uw = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
    let captured = null;

    const origFetch = _uw.fetch;
    _uw.fetch = async function (...args) {
        const res = await origFetch.apply(this, args);
        try {
            const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
            if (url.includes('/reviews/history')) {
                res.clone().json().then(json => { captured = json; }).catch(() => {});
            }
        } catch (e) {}
        return res;
    };

    // 2026-10-09追加：前回の調査ではXHR経由で捕まっていた可能性があるため、fetchだけでなく
    // XMLHttpRequestも監視対象にする（どちらの経路で呼ばれても取り逃さないようにする）。
    const OrigXHR = _uw.XMLHttpRequest;
    function PatchedXHR() {
        const xhr = new OrigXHR();
        let _url = '';
        const origOpen = xhr.open;
        xhr.open = function (method, url, ...rest) {
            _url = url;
            return origOpen.call(xhr, method, url, ...rest);
        };
        xhr.addEventListener('loadend', function () {
            try {
                if (_url.includes('/reviews/history')) {
                    captured = JSON.parse(xhr.responseText);
                }
            } catch (e) {}
        });
        return xhr;
    }
    _uw.XMLHttpRequest = PatchedXHR;

    function formatDate(unixSec) {
        return new Date(unixSec * 1000).toISOString().slice(0, 10);
    }

    function buildReport(entries) {
        const asBuyer = entries.filter(e => e.subject === 'buyer');
        const bySeller = new Map();
        for (const e of asBuyer) {
            const sid = e.user.id;
            if (!bySeller.has(sid)) {
                bySeller.set(sid, { id: sid, name: e.user.name, count: 0, lastCreated: 0 });
            }
            const s = bySeller.get(sid);
            s.count++;
            if (e.created > s.lastCreated) s.lastCreated = e.created;
        }
        const sellers = [...bySeller.values()].sort((a, b) => b.lastCreated - a.lastCreated);

        const lines = [];
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
        for (const e of [...asBuyer].sort((a, b) => b.created - a.created)) {
            lines.push(`${formatDate(e.created)}\t${e.user.id}\t${e.user.name}\t${e.fame}\t${(e.message || '').replace(/\n/g, ' ')}`);
        }
        return lines.join('\n');
    }

    function mountUI() {
        const btn = document.createElement('button');
        btn.style.cssText = 'position:fixed;top:20px;right:20px;z-index:99999;padding:12px 20px;background:#9C27B0;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,0.3);';
        document.body.appendChild(btn);

        const statusEl = document.createElement('div');
        statusEl.style.cssText = 'position:fixed;top:70px;right:20px;z-index:99999;background:rgba(0,0,0,0.78);color:#fff;padding:6px 14px;border-radius:6px;font-size:13px;display:none;max-width:400px;white-space:pre-wrap;';
        document.body.appendChild(statusEl);

        function updateStatus(msg) {
            statusEl.style.display = 'block';
            statusEl.textContent = msg;
        }

        setInterval(() => {
            btn.textContent = captured ? 'セラー一覧を抽出してコピー' : '評価データ待機中...（ページを更新）';
        }, 500);

        btn.onclick = () => {
            if (!captured) { updateStatus('まだ評価データを捕まえていません。ページを更新してもう一度お試しください'); return; }
            const report = buildReport(captured.data || []);
            GM_setClipboard(report);
            updateStatus('完了！クリップボードにコピーしました（' + report.length + '文字）');
            console.log(report);
        };
    }

    if (document.body) {
        mountUI();
    } else {
        document.addEventListener('DOMContentLoaded', mountUI);
    }
})();
