// ==UserScript==
// @name         メルカリ リアルタイムリサーチ
// @namespace    http://tampermonkey.net/
// @version      1.4
// @description  リアルタイムリサーチ：page1高速ループで販売中商品をlist.jsonと照合してhitsシートに通知
// @match        https://jp.mercari.com/*
// @grant        none
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/mercari_page1_research.user.js
// @downloadURL  https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/mercari_page1_research.user.js
// ==/UserScript==

(function () {
    'use strict';

    const SERVER  = 'http://localhost:8766/check-mercari';
    const WAIT_MS = 60000;  // 1サイクル後の待機時間（ミリ秒）

    const P1_MODE      = 'p1r_mode';
    const P1_CURSOR    = 'p1r_cursor';
    const P1_FOUND     = 'p1r_found';
    const P1_LOG       = 'p1r_log';
    const P1_HEARTBEAT = 'p1r_hb';   // ウォッチドッグ用タイムスタンプ
    const WD_TIMEOUT   = 300000;     // 5分間更新なければ自動リスタート

    // 販売中（on_sale）・page1のみ・3カテゴリ
    const SEARCH_URLS = [
        {
            name: '生活家電・空調',
            url: 'https://jp.mercari.com/search?category_id=1244%2C1245%2C1246%2C1248%2C1250%2C1251%2C1252%2C1253%2C4142%2C4143%2C4150%2C4158%2C4184%2C4188%2C4193%2C4198%2C4231%2C4232%2C4246%2C4290%2C4293%2C865%2C866%2C867%2C869%2C870%2C871%2C873%2C874%2C875%2C878&price_min=1000&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari',
        },
        {
            name: 'テレビ・オーディオ・カメラ',
            url: 'https://jp.mercari.com/search?category_id=1255%2C4021%2C4074%2C4081%2C4096%2C4121%2C4122%2C4124%2C843%2C845%2C846%2C847%2C98%2C99&price_min=1000&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari',
        },
        {
            name: 'スマホ・タブレット・パソコン',
            url: 'https://jp.mercari.com/search?category_id=10792%2C10793%2C1106%2C1156%2C1209%2C1262%2C1689%2C3660%2C3662%2C3663%2C3666%2C3673%2C3674%2C3690%2C3691%2C3692%2C3693%2C3703%2C3705%2C3707%2C3709%2C3710%2C3716%2C3728%2C3733%2C3756%2C3770%2C3779%2C3811%2C3820%2C3829%2C3830%2C3831%2C3832%2C3834%2C3839%2C3844%2C3848%2C3875%2C983%2C984%2C986&price_min=1000&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari',
        },
    ];

    // ── XHR インターセプト ────────────────────────────────────────────────────

    let _resolve  = null;
    let _buffered = null;

    const _origOpen = XMLHttpRequest.prototype.open;
    const _origSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this._p1rUrl = url.includes('entities:search') ? url : null;
        return _origOpen.apply(this, [method, url, ...rest]);
    };

    XMLHttpRequest.prototype.send = function (...args) {
        if (this._p1rUrl) {
            this.addEventListener('load', () => {
                try {
                    const data = JSON.parse(this.responseText);
                    if (data && Array.isArray(data.items)) {
                        if (_resolve) { _resolve(data); _resolve = null; }
                        else if (!_buffered) { _buffered = data; }
                    }
                } catch (e) {}
            });
        }
        return _origSend.apply(this, args);
    };

    function waitForXhr(ms) {
        return new Promise((ok, fail) => {
            if (_buffered) { const d = _buffered; _buffered = null; ok(d); return; }
            _resolve = ok;
            setTimeout(() => { _resolve = null; fail(new Error('timeout')); }, ms || 18000);
        });
    }

    // ── localStorage ─────────────────────────────────────────────────────────

    const ls = {
        get: k => localStorage.getItem(k),
        set: (k, v) => localStorage.setItem(k, v),
        del: k => localStorage.removeItem(k),
    };

    function p1Log(msg) {
        try {
            const log = JSON.parse(ls.get(P1_LOG) || '[]');
            const t = new Date().toTimeString().slice(0, 8);
            log.push(`${t} ${msg}`);
            if (log.length > 60) log.shift();
            ls.set(P1_LOG, JSON.stringify(log));
            ls.set(P1_HEARTBEAT, String(Date.now()));  // 生存確認更新
        } catch (e) {}
    }

    function clearState() {
        [P1_MODE, P1_CURSOR, P1_FOUND].forEach(ls.del);
    }

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    // ── アイテム処理・サーバー送信 ────────────────────────────────────────────

    async function processItems(items) {
        const formatted = items
            .map(item => ({
                name:  '[R] ' + (item.name || ''),
                price: String(parseInt(item.price, 10) || 0),
                url:   `https://jp.mercari.com/item/${item.id}`,
                image: (item.thumbnails && item.thumbnails[0]) || '',
            }))
            .filter(i => i.name && parseInt(i.price) > 0);

        if (formatted.length === 0) return 0;

        try {
            const res  = await fetch(SERVER, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ items: formatted }),
            });
            const data    = await res.json();
            const matches = data.matches || [];
            if (matches.length > 0) {
                p1Log(`  ★ヒット${matches.length}件: ${matches.map(m => m.model).join(', ')}`);
            }
            return matches.length;
        } catch (e) {
            p1Log(`  送信エラー: ${e.message}`);
            return 0;
        }
    }

    // ── サイクル進行 ──────────────────────────────────────────────────────────

    function advanceCycle(processedIdx) {
        if (ls.get(P1_MODE) !== 'search') return;

        const n       = SEARCH_URLS.length;
        const nextIdx = (processedIdx + 1) % n;

        if (nextIdx === 0) {
            const total = ls.get(P1_FOUND) || '0';
            p1Log(`cycle完了 累計${total}件 ${WAIT_MS / 1000}秒待機`);
            showStatus(`1周完了 累計${total}件 | ${WAIT_MS / 1000}秒後に再スキャン`, '#0d47a1');
            setTimeout(() => {
                if (ls.get(P1_MODE) !== 'search') return;
                ls.set(P1_CURSOR, '0');
                window.location.href = SEARCH_URLS[0].url;
            }, WAIT_MS);
        } else {
            ls.set(P1_CURSOR, nextIdx);
            p1Log(`→ cat${nextIdx}`);
            window.location.href = SEARCH_URLS[nextIdx].url;
        }
    }

    // ── 検索ページ処理 ────────────────────────────────────────────────────────

    async function runOnSearchPage() {
        const cursor = parseInt(ls.get(P1_CURSOR) || '0', 10);
        const cat    = SEARCH_URLS[cursor];

        showStatus(`${cat.name}: 待機中…`, '#0d47a1');

        let data;
        try {
            data = await waitForXhr(60000);
        } catch (e) {
            p1Log(`cat${cursor} TIMEOUT`);
            showStatus(`タイムアウト → 次へ`, '#e65100');
            await sleep(1500);
            advanceCycle(cursor);
            return;
        }

        const items = data.items || [];
        p1Log(`cat${cursor} items=${items.length}`);
        showStatus(`${cat.name}: ${items.length}件照合中…`, '#0d47a1');

        let found = 0;
        try {
            found = await processItems(items);
        } catch (e) {
            p1Log(`processItems error: ${e.message}`);
        }

        if (ls.get(P1_MODE) !== 'search') return;

        p1Log(`cat${cursor} ヒット:${found}`);
        const total = parseInt(ls.get(P1_FOUND) || '0', 10) + found;
        ls.set(P1_FOUND, total);
        showStatus(
            `${cat.name}: ヒット:${found}（累計${total}）`,
            found > 0 ? '#1b5e20' : '#0d47a1'
        );

        await sleep(1500);
        advanceCycle(cursor);
    }

    // ── ウォッチドッグ（ページ内 setInterval + visibilitychange） ──────────────

    function startWatchdog() {
        setInterval(() => {
            if (ls.get(P1_MODE) !== 'search') return;
            const lastHb = parseInt(ls.get(P1_HEARTBEAT) || '0', 10);
            if (lastHb > 0 && Date.now() - lastHb > WD_TIMEOUT) {
                p1Log('watchdog(interval): 停止検知 → cat0リスタート');
                ls.set(P1_CURSOR, '0');
                window.location.href = SEARCH_URLS[0].url;
            }
        }, 30000);
    }

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        if (ls.get(P1_MODE) !== 'search') return;
        const lastHb = parseInt(ls.get(P1_HEARTBEAT) || '0', 10);
        if (lastHb > 0 && Date.now() - lastHb > 120000) {  // 2分以上止まっていたら
            p1Log('watchdog(visibility): タブ復帰検知 → cat0リスタート');
            ls.set(P1_CURSOR, '0');
            window.location.href = SEARCH_URLS[0].url;
        }
    });

    // ── UI ───────────────────────────────────────────────────────────────────

    let $status = null;

    function showStatus(msg, bg) {
        if (!$status) return;
        $status.textContent      = msg;
        $status.style.background = bg || '#424242';
    }

    function updateBtn(active) {
        const b = document.getElementById('p1r-btn');
        if (!b) return;
        b.textContent      = active ? '■ リアルタイムリサーチ停止' : '▶ リアルタイムリサーチ開始';
        b.style.background = active ? '#616161'          : '#0d47a1';
    }

    // ── エントリポイント ──────────────────────────────────────────────────────

    window.addEventListener('DOMContentLoaded', () => {
        startWatchdog();
        setTimeout(() => {
            if (document.getElementById('p1r-btn')) return;

            // ステータス表示（速売れの下 top:90px）
            $status = document.createElement('div');
            $status.style.cssText = [
                'position:fixed', 'top:90px', 'right:8px', 'z-index:99998',
                'padding:7px 12px', 'border-radius:6px', 'font-size:11px',
                'color:#fff', 'max-width:300px', 'word-break:break-all',
                'pointer-events:none', 'box-shadow:0 2px 6px rgba(0,0,0,.4)',
                'line-height:1.5', 'background:#424242',
            ].join(';');
            document.body.appendChild($status);

            // ボタン（速売れボタンの上 bottom:220px）
            const btn = document.createElement('button');
            btn.id            = 'p1r-btn';
            btn.style.cssText = [
                'position:fixed', 'bottom:220px', 'left:8px', 'z-index:99998',
                'padding:7px 12px', 'border:none', 'border-radius:6px',
                'cursor:pointer', 'font-size:12px', 'font-weight:bold',
                'color:#fff', 'box-shadow:0 2px 6px rgba(0,0,0,.4)',
            ].join(';');
            document.body.appendChild(btn);

            const active = ls.get(P1_MODE) === 'search';
            updateBtn(active);

            // ウォッチドッグ：5分以上動いていなければ自動リスタート
            if (active) {
                const lastHb = parseInt(ls.get(P1_HEARTBEAT) || '0', 10);
                if (lastHb > 0 && Date.now() - lastHb > WD_TIMEOUT) {
                    ls.set(P1_CURSOR, '0');
                    p1Log('watchdog: 停止検知 → cat0からリスタート');
                }
            }

            btn.onclick = () => {
                if (ls.get(P1_MODE) === 'search') {
                    clearState();
                    updateBtn(false);
                    showStatus('停止しました', '#616161');
                } else {
                    clearState();
                    ls.set(P1_MODE,   'search');
                    ls.set(P1_CURSOR, '0');
                    ls.set(P1_FOUND,  '0');
                    updateBtn(true);
                    window.location.href = SEARCH_URLS[0].url;
                }
            };

            if (active && window.location.href.includes('/search')) {
                runOnSearchPage();
            } else if (active) {
                const cursor = parseInt(ls.get(P1_CURSOR) || '0', 10);
                window.location.href = SEARCH_URLS[cursor].url;
            }
        }, 900);
    });

})();
