// ==UserScript==
// @name         メルカリ 速売れ商品リサーチ
// @namespace    http://tampermonkey.net/
// @version      2.13
// @description  XHRインターセプト＋ラウンドロビンで全カテゴリ均等処理
// @match        https://jp.mercari.com/*
// @grant        none
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/mercari_speed_finder.user.js
// @downloadURL  https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/mercari_speed_finder.user.js
// ==/UserScript==

(function () {
    'use strict';

    const SERVER     = 'http://localhost:8769/speed-hit';
    const MAX_MIN    = 60;
    const STALE_DAYS = 7;

    const SF_MODE   = 'sf2_mode';
    const SF_CURSOR = 'sf2_cursor';
    const SF_TOKENS = 'sf2_tokens';
    const SF_FOUND  = 'sf2_found';

    const SEARCH_URLS = [
        {
            name: '生活家電・空調',
            url: 'https://jp.mercari.com/search?category_id=1244%2C1245%2C1246%2C1248%2C1250%2C1251%2C1252%2C1253%2C4142%2C4143%2C4150%2C4158%2C4184%2C4188%2C4193%2C4198%2C4231%2C4232%2C4246%2C4290%2C4293%2C865%2C866%2C867%2C869%2C870%2C871%2C873%2C874%2C875%2C878&price_min=1000&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=sold_out%7Ctrading&sort=created_time&order=desc&item_types=mercari',
        },
        {
            name: 'テレビ・オーディオ・カメラ',
            url: 'https://jp.mercari.com/search?category_id=1255%2C4021%2C4074%2C4081%2C4096%2C4121%2C4122%2C4124%2C843%2C845%2C846%2C847%2C98%2C99&price_min=1000&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=sold_out%7Ctrading&sort=created_time&order=desc&item_types=mercari',
        },
        {
            name: 'スマホ・タブレット・パソコン',
            url: 'https://jp.mercari.com/search?category_id=10792%2C10793%2C1106%2C1156%2C1209%2C1262%2C1689%2C3660%2C3662%2C3663%2C3666%2C3673%2C3674%2C3690%2C3691%2C3692%2C3693%2C3703%2C3705%2C3707%2C3709%2C3710%2C3716%2C3728%2C3733%2C3756%2C3770%2C3779%2C3811%2C3820%2C3829%2C3830%2C3831%2C3832%2C3834%2C3839%2C3844%2C3848%2C3875%2C983%2C984%2C986&price_min=1000&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=sold_out%7Ctrading&sort=created_time&order=desc&item_types=mercari',
        },
    ];

    // ── XHR インターセプト ─────────────────────────────────────────────────────

    let _resolve  = null;
    let _buffered = null;

    const _origOpen = XMLHttpRequest.prototype.open;
    const _origSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this._sfUrl     = url.includes('entities:search') ? url : null;
        this._sfOwnCall = !!this._sfOwnCall;
        return _origOpen.apply(this, [method, url, ...rest]);
    };

    XMLHttpRequest.prototype.send = function (...args) {
        if (this._sfUrl && !this._sfOwnCall) {
            this.addEventListener('load', () => {
                try {
                    const data = JSON.parse(this.responseText);
                    if (data && Array.isArray(data.items)) {
                        if (_resolve)        { _resolve(data); _resolve = null; }
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

    const SF_LOG = 'sf2_log';

    function sfLog(msg) {
        try {
            const log = JSON.parse(ls.get(SF_LOG) || '[]');
            const t = new Date().toTimeString().slice(0, 8);
            log.push(`${t} ${msg}`);
            if (log.length > 20) log.shift();
            ls.set(SF_LOG, JSON.stringify(log));
        } catch (e) {}
    }

    function clearState() {
        [SF_MODE, SF_CURSOR, SF_TOKENS, SF_FOUND].forEach(ls.del);
    }

    function getTokens() {
        try { return JSON.parse(ls.get(SF_TOKENS)) || SEARCH_URLS.map(() => ''); }
        catch (e) { return SEARCH_URLS.map(() => ''); }
    }

    // ── モデル番号抽出 ────────────────────────────────────────────────────────

    function parseModel(title) {
        const m = title.match(/\b[A-Z]{2,}[A-Z0-9\-\/\.]{3,}\b/g);
        if (!m) return '';
        return m.reduce((a, b) => (b.length > a.length ? b : a));
    }

    // ── アイテム処理 ──────────────────────────────────────────────────────────

    async function processItems(items, category) {
        if (items.length > 0) ls.set('sf2_item0', JSON.stringify(items[0]));
        const now = Math.floor(Date.now() / 1000);
        let found = 0;
        let nTimeOver = 0, nNoModel = 0, nTrading = 0, nSoldOut = 0;
        for (const item of items) {
            const st = (item.status || '').toLowerCase();
            if (st.includes('trading'))  nTrading++;
            else if (st.includes('sold')) nSoldOut++;

            const cr = parseInt(item.created, 10);
            if (isNaN(cr)) { nTimeOver++; continue; }

            // now - created = 出品からの経過時間。trading/sold_out 問わず60分以内なら速売れ
            const min = Math.round((now - cr) / 60);
            if (min < 0 || min > MAX_MIN) { nTimeOver++; continue; }

            const model = parseModel(item.name || '');
            if (!model) { nNoModel++; continue; }

            try {
                await fetch(SERVER, {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        itemId:      item.id,
                        category,
                        name:        item.name,
                        modelNumber: model,
                        price:       parseInt(item.price, 10) || 0,
                        durationMin: min,
                        durationRaw: `${min}分以内で売れた商品`,
                        url:         `https://jp.mercari.com/item/${item.id}`,
                    }),
                });
                found++;
            } catch (e) {}
        }
        sfLog(`  trading:${nTrading} sold:${nSoldOut} 時間超:${nTimeOver} 型番NG:${nNoModel}`);
        return { found, nTimeOver, nStale: 0, nNoModel };
    }

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    // ── ラウンドロビン進行 ─────────────────────────────────────────────────────

    function advanceRoundRobin(processedIdx, nextToken) {
        if (ls.get(SF_MODE) !== 'search') return;

        const tokens = getTokens();
        tokens[processedIdx] = (nextToken && nextToken !== '') ? nextToken : null;
        ls.set(SF_TOKENS, JSON.stringify(tokens));
        sfLog(`cat${processedIdx} done=${tokens[processedIdx]===null} next=${nextToken||'none'}`);

        const n = SEARCH_URLS.length;
        for (let i = 1; i <= n; i++) {
            const idx = (processedIdx + i) % n;
            if (tokens[idx] !== null) {
                ls.set(SF_CURSOR, idx);
                const token = tokens[idx];
                const url = SEARCH_URLS[idx].url + (token ? '&page_token=' + encodeURIComponent(token) : '');
                sfLog(`→ cat${idx} token=${token||'p1'}`);
                window.location.href = url;
                return;
            }
        }

        // 全カテゴリ完了
        const total = ls.get(SF_FOUND) || '0';
        sfLog(`COMPLETE total=${total}`);
        clearState();
        showStatus(`完了！ 合計 ${total} 件検出`, '#1b5e20');
        updateBtn(false);
    }

    // ── 検索ページ処理 ────────────────────────────────────────────────────────

    async function runOnSearchPage() {
        const cursor = parseInt(ls.get(SF_CURSOR) || '0', 10);
        const cat    = SEARCH_URLS[cursor];

        let elapsed = 0;
        const waitTick = setInterval(() => {
            elapsed += 5;
            showStatus(`${cat.name}: 待機中… ${elapsed}s`, '#1565c0');
        }, 5000);
        showStatus(`${cat.name}: 待機中… 0s`, '#1565c0');

        let data;
        try {
            data = await waitForXhr(60000);
            clearInterval(waitTick);
        } catch (e) {
            clearInterval(waitTick);
            sfLog(`cat${cursor} TIMEOUT`);
            showStatus(`タイムアウト → 次へ`, '#f57c00');
            await sleep(1500);
            advanceRoundRobin(cursor, null);
            return;
        }

        const items     = data.items || [];
        const nextToken = data.meta && data.meta.nextPageToken;
        sfLog(`cat${cursor} items=${items.length} next=${nextToken||'none'}`);
        showStatus(`${cat.name}: ${items.length}件処理中…`, '#1565c0');

        let found = 0, nTimeOver = 0, nStale = 0, nNoModel = 0;
        try {
            const r = await processItems(items, cat.name);
            found = r.found; nTimeOver = r.nTimeOver; nStale = r.nStale; nNoModel = r.nNoModel;
        } catch(e) { sfLog(`processItems error: ${e.message}`); }
        if (ls.get(SF_MODE) !== 'search') return;

        sfLog(`cat${cursor} 時間超:${nTimeOver} 古:${nStale} 型番NG:${nNoModel} ヒット:${found}`);
        const total = parseInt(ls.get(SF_FOUND) || '0', 10) + found;
        ls.set(SF_FOUND, total);
        showStatus(`${cat.name}: 時間超:${nTimeOver} 型番NG:${nNoModel} ヒット:${found}（累計${total}）`, found > 0 ? '#1b5e20' : '#2e7d32');

        await sleep(1500);
        advanceRoundRobin(cursor, nextToken);
    }

    // ── UI ───────────────────────────────────────────────────────────────────

    let $status = null;

    function showStatus(msg, bg) {
        if (!$status) return;
        $status.textContent      = msg;
        $status.style.background = bg || '#424242';
    }

    function updateBtn(active) {
        const b = document.getElementById('sf-btn2');
        if (!b) return;
        b.textContent      = active ? '■ 速売れ停止' : '▶ 速売れ開始';
        b.style.background = active ? '#616161'     : '#c62828';
    }

    // ── エントリポイント ──────────────────────────────────────────────────────

    window.addEventListener('DOMContentLoaded', () => {
        setTimeout(() => {
            if (document.getElementById('sf-btn2')) return;

            $status = document.createElement('div');
            $status.style.cssText = [
                'position:fixed', 'top:56px', 'right:8px', 'z-index:99999',
                'padding:7px 12px', 'border-radius:6px', 'font-size:11px',
                'color:#fff', 'max-width:300px', 'word-break:break-all',
                'pointer-events:none', 'box-shadow:0 2px 6px rgba(0,0,0,.4)',
                'line-height:1.5',
            ].join(';');
            document.body.appendChild($status);

            const btn = document.createElement('button');
            btn.id            = 'sf-btn2';
            btn.style.cssText = [
                'position:fixed', 'bottom:170px', 'left:8px', 'z-index:99999',
                'padding:7px 12px', 'border:none', 'border-radius:6px',
                'cursor:pointer', 'font-size:12px', 'font-weight:bold',
                'color:#fff', 'box-shadow:0 2px 6px rgba(0,0,0,.4)',
            ].join(';');
            document.body.appendChild(btn);

            const active = ls.get(SF_MODE) === 'search';
            updateBtn(active);

            btn.onclick = () => {
                if (ls.get(SF_MODE) === 'search') {
                    clearState();
                    updateBtn(false);
                    showStatus('停止しました', '#616161');
                } else {
                    clearState();
                    ls.set(SF_MODE,   'search');
                    ls.set(SF_CURSOR, '0');
                    ls.set(SF_TOKENS, JSON.stringify(SEARCH_URLS.map(() => '')));
                    ls.set(SF_FOUND,  '0');
                    updateBtn(true);
                    window.location.href = SEARCH_URLS[0].url;
                }
            };

            if (active && window.location.href.includes('/search')) {
                runOnSearchPage();
            } else if (active) {
                const cursor = parseInt(ls.get(SF_CURSOR) || '0', 10);
                const tokens = getTokens();
                const token  = tokens[cursor] || '';
                const url    = SEARCH_URLS[cursor].url + (token ? '&page_token=' + encodeURIComponent(token) : '');
                window.location.href = url;
            }
        }, 900);
    });

})();
