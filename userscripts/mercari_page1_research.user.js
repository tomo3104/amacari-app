// ==UserScript==
// @name         メルカリ リアルタイムリサーチ
// @namespace    http://tampermonkey.net/
// @version      3.7
// @description  リアルタイムリサーチ：メーカー動的ロード・fetch+XHRインターセプト
// @match        https://jp.mercari.com/*
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/mercari_page1_research.user.js
// @downloadURL  https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/mercari_page1_research.user.js
// ==/UserScript==

(function () {
    'use strict';

    const SERVER      = 'http://localhost:8766/check-mercari';
    const WAIT_MS     = 60000;  // サイクル間の待機
    const FETCH_DELAY = 3000;   // カテゴリ間のfetch間隔

    const P1_MODE      = 'p1r_mode';
    const P1_CURSOR    = 'p1r_cursor';
    const P1_FOUND     = 'p1r_found';
    const P1_LOG       = 'p1r_log';
    const P1_HEARTBEAT = 'p1r_hb';
    const P1_PHASE     = 'p1r_phase';    // 'capture' | 'loop'
    const P1_CAPTURES  = 'p1r_captures'; // localStorage に保存するキャプチャデータ
    const WD_TIMEOUT   = 300000;         // ウォッチドッグ5分

    const MAKERS_URL   = 'http://localhost:8766/get-manufacturers';
    const MAKERS_KEY   = 'p1r_makers';
    const MAKERS_TS    = 'p1r_makers_ts';
    const MAKERS_TTL   = 24 * 60 * 60 * 1000;
    const MAKERS_LIMIT = 101;

    // サーバー未起動時のフォールバック（3カテゴリ）
    const FALLBACK_URLS = [
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

    let _searchUrls = [];  // loadMakers() で動的ロード
    let _fetchInternal = false; // 自前のfetchCategory呼び出しを区別するフラグ

    function normalizeRtUrl(url) {
        try {
            const u = new URL(url);
            u.searchParams.set('price_min', '1000');
            u.searchParams.set('price_max', '20000');
            u.searchParams.set('sort', 'created_time');
            u.searchParams.set('order', 'desc');
            if (!u.searchParams.has('item_types')) u.searchParams.set('item_types', 'mercari');
            return u.toString();
        } catch (e) {
            return url;
        }
    }

    async function loadMakers() {
        const cached = ls.get(MAKERS_KEY);
        const ts = parseInt(ls.get(MAKERS_TS) || '0', 10);
        if (cached && Date.now() - ts < MAKERS_TTL) {
            try {
                const parsed = JSON.parse(cached);
                if (Array.isArray(parsed) && parsed.length > 0) {
                    _searchUrls = parsed;
                    p1Log(`makers cache: ${_searchUrls.length}件`);
                    return;
                }
            } catch (e) {}
        }
        try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 10000);
            const res = await fetch(MAKERS_URL, { signal: ctrl.signal });
            clearTimeout(timer);
            const data = await res.json();
            const makers = (data.manufacturers || []).filter(m => m.url);
            _searchUrls = makers.slice(0, MAKERS_LIMIT).map(m => ({ name: m.name, url: normalizeRtUrl(m.url) }));
            if (_searchUrls.length > 0) {
                ls.set(MAKERS_KEY, JSON.stringify(_searchUrls));
                ls.set(MAKERS_TS, String(Date.now()));
                p1Log(`makers取得: ${_searchUrls.length}件`);
            } else {
                throw new Error('0件');
            }
        } catch (e) {
            p1Log(`makers取得失敗: ${e.message} → フォールバック`);
            _searchUrls = FALLBACK_URLS.map(u => ({ name: u.name, url: u.url }));
        }
    }

    // ── キャプチャデータ（ページ遷移を超えてlocalStorageで保持） ──────────────

    const _captures = {};

    function saveCaptures() {
        try { ls.set(P1_CAPTURES, JSON.stringify(_captures)); } catch (e) {}
    }

    function restoreCaptures() {
        try {
            const stored = JSON.parse(ls.get(P1_CAPTURES) || '{}');
            Object.entries(stored).forEach(([i, cap]) => { _captures[parseInt(i)] = cap; });
        } catch (e) {}
    }

    function allCaptured() {
        return _searchUrls.length > 0 && _searchUrls.every((_, i) => _captures[i]);
    }

    function clearCaptures() {
        ls.del(P1_CAPTURES);
        ls.del('mercari_api_shared_tpl');
        Object.keys(_captures).forEach(k => delete _captures[k]);
    }

    // ── fetch インターセプト（Mercari が fetch を使う場合の対応） ───────────────

    const _origFetch = window.fetch;
    window.fetch = async function (...args) {
        const url = typeof args[0] === 'string' ? args[0]
                  : (args[0] instanceof Request ? args[0].url : '');
        // 自前の fetchCategory 呼び出し、または対象外のURLはスルー
        if (_fetchInternal || !url.includes('entities:search')) {
            return _origFetch.apply(this, args);
        }
        const res = await _origFetch.apply(this, args);
        try {
            const clone = res.clone();
            const data = await clone.json();
            if (data && Array.isArray(data.items)) {
                const cursor = parseInt(ls.get(P1_CURSOR) || '0', 10);
                const init = args[1] || {};
                const method = (init.method) || (args[0] instanceof Request ? args[0].method : 'POST');
                const headers = {};
                const rawHeaders = init.headers || (args[0] instanceof Request ? args[0].headers : null);
                if (rawHeaders) {
                    if (rawHeaders instanceof Headers) rawHeaders.forEach((v, k) => { headers[k] = v; });
                    else Object.assign(headers, rawHeaders);
                }
                const body = typeof init.body === 'string' ? init.body
                           : (args[0] instanceof Request ? null : null);
                if (!_captures[cursor] && body !== null) {
                    _captures[cursor] = { url, method, headers, body };
                    saveCaptures();
                }
                if (body !== null) {
                    ls.set('mercari_api_shared_tpl', JSON.stringify({ url, method, headers, body }));
                }
                if (_resolve) { _resolve(data); _resolve = null; }
                else if (!_buffered) { _buffered = data; }
            }
        } catch (e) {}
        return res;
    };

    // ── XHR インターセプト（リクエスト内容も記録） ───────────────────────────

    let _resolve  = null;
    let _buffered = null;

    const _origOpen             = XMLHttpRequest.prototype.open;
    const _origSend             = XMLHttpRequest.prototype.send;
    const _origSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this._p1rUrl    = url.includes('entities:search') ? url : null;
        this._p1rMethod = method;
        return _origOpen.apply(this, [method, url, ...rest]);
    };

    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
        if (this._p1rUrl) {
            if (!this._p1rHeaders) this._p1rHeaders = {};
            this._p1rHeaders[name] = value;
        }
        return _origSetRequestHeader.apply(this, [name, value]);
    };

    XMLHttpRequest.prototype.send = function (...args) {
        if (this._p1rUrl) {
            const capUrl     = this._p1rUrl;
            const capMethod  = this._p1rMethod || 'POST';
            const capHeaders = { ...(this._p1rHeaders || {}) };
            const capBody    = (typeof args[0] === 'string') ? args[0] : null;

            this.addEventListener('load', () => {
                try {
                    const data = JSON.parse(this.responseText);
                    if (data && Array.isArray(data.items)) {
                        const cursor = parseInt(ls.get(P1_CURSOR) || '0', 10);
                        if (!_captures[cursor] && capBody !== null) {
                            _captures[cursor] = { url: capUrl, method: capMethod, headers: capHeaders, body: capBody };
                            saveCaptures();
                        }
                        if (capBody !== null) {
                            ls.set('mercari_api_shared_tpl', JSON.stringify({ url: capUrl, method: capMethod, headers: capHeaders, body: capBody }));
                        }
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
            ls.set(P1_HEARTBEAT, String(Date.now()));
        } catch (e) {}
    }

    function clearState() {
        [P1_MODE, P1_CURSOR, P1_FOUND, P1_PHASE].forEach(ls.del);
        clearCaptures();
    }

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    function setTitle(msg) {
        try { document.title = msg; } catch (e) {}
    }

    function reportStatus(msg, phase, cursor, total) {
        try {
            GM_xmlhttpRequest({
                method:  'POST',
                url:     'http://localhost:8766/rt-status',
                headers: { 'Content-Type': 'application/json' },
                data:    JSON.stringify({ msg, phase: phase || '', cursor: cursor || '', total: total || '' }),
                timeout: 3000,
                onerror: () => {},
                ontimeout: () => {},
            });
        } catch (e) {}
    }

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
                body:    JSON.stringify({ items: formatted, source: 'realtime' }),
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

    // ── fetch 直接呼び出し（ページ遷移なし） ─────────────────────────────────

    async function fetchCategory(cap) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        _fetchInternal = true;
        try {
            const res = await _origFetch.call(window, cap.url, {
                method:      cap.method,
                headers:     cap.headers,
                credentials: 'include',
                body:        cap.body,
                signal:      controller.signal,
            });
            clearTimeout(timer);
            _fetchInternal = false;
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (!Array.isArray(data.items)) throw new Error('no items');
            return data;
        } catch (e) {
            clearTimeout(timer);
            _fetchInternal = false;
            throw e;
        }
    }

    // ── キャプチャフェーズ（初回のみ3カテゴリを1回ずつ遷移して記録） ─────────

    async function runCapturePhase() {
        const cursor = parseInt(ls.get(P1_CURSOR) || '0', 10);

        if (_captures[cursor]) {
            advanceCapture(cursor);
            return;
        }

        setTitle(`📡 準備中 ${cursor + 1}/${_searchUrls.length} ${_searchUrls[cursor].name}`);
        showStatus(`[準備 ${cursor + 1}/${_searchUrls.length}] ${_searchUrls[cursor].name} 待機…`, '#5d4037');
        p1Log(`capture cat${cursor} 待機`);

        let data;
        try {
            data = await waitForXhr(20000);
        } catch (e) {
            p1Log(`capture cat${cursor} タイムアウト → リトライ`);
            window.location.href = _searchUrls[cursor].url;
            return;
        }

        p1Log(`capture cat${cursor} OK items=${data.items.length}`);
        reportStatus(`${_searchUrls[cursor].name} キャプチャ完了`, 'capture', cursor + 1, _searchUrls.length);
        advanceCapture(cursor);
    }

    function advanceCapture(cursor) {
        const next = cursor + 1;
        if (next >= _searchUrls.length) {
            p1Log(`全${_searchUrls.length}件準備完了 → ループ開始`);
            ls.set(P1_PHASE, 'loop');
            ls.set(P1_CURSOR, '0');
            startLoopPhase();
        } else {
            ls.set(P1_CURSOR, String(next));
            showStatus(`[準備 ${next + 1}/${_searchUrls.length}] 次: ${_searchUrls[next].name}（停止はEscキー）`, '#5d4037');
            setTimeout(() => {
                if (ls.get(P1_MODE) === 'search') {
                    window.location.href = _searchUrls[next].url;
                }
            }, 2500);
        }
    }

    // ── ループフェーズ（ページ遷移なし・fetch直接） ───────────────────────────

    async function startLoopPhase() {
        if (!allCaptured()) {
            p1Log('キャプチャデータなし → 再準備');
            ls.set(P1_PHASE, 'capture');
            ls.set(P1_CURSOR, '0');
            window.location.href = _searchUrls[0].url;
            return;
        }

        p1Log('=== ループ開始（ナビなし）===');
        let _fetchErrors = 0;  // 連続エラーカウンター

        while (ls.get(P1_MODE) === 'search') {
            for (let i = 0; i < _searchUrls.length; i++) {
                if (ls.get(P1_MODE) !== 'search') return;

                setTitle(`🔄 RT ${i + 1}/${_searchUrls.length} ${_searchUrls[i].name}`);
                showStatus(`[R] ${_searchUrls[i].name} 照合中…`, '#0d47a1');
                p1Log(`fetch cat${i}`);

                let items = [];
                try {
                    const data = await fetchCategory(_captures[i]);
                    items = data.items || [];
                    _fetchErrors = 0;  // 成功したらリセット
                } catch (e) {
                    _fetchErrors++;
                    p1Log(`fetch cat${i} エラー(${_fetchErrors}回): ${e.message}`);
                    if (_fetchErrors >= 3 || /HTTP 4|no items/.test(e.message)) {
                        p1Log('エラー → キャプチャ破棄・再準備');
                        clearCaptures();
                        ls.set(P1_PHASE, 'capture');
                        ls.set(P1_CURSOR, '0');
                        window.location.href = _searchUrls[0].url;
                        return;
                    }
                    await sleep(FETCH_DELAY);
                    continue;
                }

                p1Log(`cat${i} items=${items.length}`);
                reportStatus(`${_searchUrls[i].name} ${items.length}件照合中`, 'loop');
                let found = 0;
                try { found = await processItems(items); } catch (e) { p1Log(`processItems error: ${e.message}`); }

                const total = parseInt(ls.get(P1_FOUND) || '0', 10) + found;
                ls.set(P1_FOUND, String(total));
                showStatus(
                    `[R] ${_searchUrls[i].name}: ヒット${found}（累計${total}）`,
                    found > 0 ? '#1b5e20' : '#0d47a1'
                );

                if (i < _searchUrls.length - 1) await sleep(FETCH_DELAY);
            }

            const total = ls.get(P1_FOUND) || '0';
            p1Log(`cycle完了 累計${total}件 ${WAIT_MS / 1000}秒待機`);
            setTitle(`✅ RT完了 累計${total}件 | ${WAIT_MS / 1000}秒待機中`);
            showStatus(`1周完了 累計${total}件 | ${WAIT_MS / 1000}秒後に再スキャン`, '#0d47a1');
            await sleep(WAIT_MS);
        }
    }

    // ── ウォッチドッグ ────────────────────────────────────────────────────────

    function startWatchdog() {
        setInterval(() => {
            if (ls.get(P1_MODE) !== 'search') return;
            if (ls.get(P1_PHASE) !== 'loop') return;
            const lastHb = parseInt(ls.get(P1_HEARTBEAT) || '0', 10);
            if (lastHb > 0 && Date.now() - lastHb > WD_TIMEOUT) {
                p1Log('watchdog: 停止検知 → 再準備');
                clearCaptures();
                ls.set(P1_PHASE, 'capture');
                ls.set(P1_CURSOR, '0');
                if (_searchUrls.length > 0) window.location.href = _searchUrls[0].url;
            }
        }, 30000);
    }

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
        b.style.background = active ? '#616161' : '#0d47a1';
    }

    // ── エントリポイント ──────────────────────────────────────────────────────

    restoreCaptures();  // ページロード時にキャプチャを復元

    // Escapeキーで即停止（ページ遷移中でも有効）
    window.addEventListener('keydown', e => {
        if (e.key === 'Escape' && ls.get(P1_MODE) === 'search') {
            clearState();
            console.log('[RT] Escapeキーで停止しました');
            reportStatus('Escapeキーで停止', 'stop');
        }
    });

    window.addEventListener('DOMContentLoaded', () => {
        // makers を非同期ロード（キャッシュがあればほぼ即完了）
        loadMakers().catch(e => p1Log(`makers load err: ${e.message}`));

        startWatchdog();
        setTimeout(async () => {
            if (document.getElementById('p1r-btn')) return;

            $status = document.createElement('div');
            $status.style.cssText = [
                'position:fixed', 'top:90px', 'right:8px', 'z-index:99998',
                'padding:7px 12px', 'border-radius:6px', 'font-size:11px',
                'color:#fff', 'max-width:300px', 'word-break:break-all',
                'pointer-events:none', 'box-shadow:0 2px 6px rgba(0,0,0,.4)',
                'line-height:1.5', 'background:#424242',
            ].join(';');
            document.body.appendChild($status);

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

            btn.onclick = async () => {
                if (ls.get(P1_MODE) === 'search') {
                    clearState();
                    updateBtn(false);
                    showStatus('停止しました', '#616161');
                } else {
                    clearState();
                    ls.set(P1_MODE,   'search');
                    ls.set(P1_CURSOR, '0');
                    ls.set(P1_FOUND,  '0');
                    ls.set(P1_PHASE,  'capture');
                    updateBtn(true);
                    if (_searchUrls.length === 0) {
                        showStatus('メーカーリスト読み込み中…', '#424242');
                        await loadMakers();
                    }
                    window.location.href = _searchUrls[0].url;
                }
            };

            if (active) {
                if (_searchUrls.length === 0) await loadMakers();
                const phase = ls.get(P1_PHASE);
                if (phase === 'loop') {
                    startLoopPhase();
                } else {
                    if (window.location.href.includes('/search')) {
                        runCapturePhase();
                    } else {
                        const cursor = parseInt(ls.get(P1_CURSOR) || '0', 10);
                        const url = (_searchUrls[cursor] || _searchUrls[0] || FALLBACK_URLS[0]).url;
                        window.location.href = url;
                    }
                }
            } else if (new URLSearchParams(location.search).get('auto_realtime') === '1') {
                clearState();
                ls.set(P1_MODE,   'search');
                ls.set(P1_CURSOR, '0');
                ls.set(P1_FOUND,  '0');
                ls.set(P1_PHASE,  'capture');
                updateBtn(true);
                if (_searchUrls.length === 0) await loadMakers();
                window.location.href = _searchUrls[0].url;
            }
        }, 100);
    });

})();
