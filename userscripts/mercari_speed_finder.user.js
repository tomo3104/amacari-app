// ==UserScript==
// @name         メルカリ 速売れ商品リサーチ
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  売り切れ商品のバッジ（N分/時間で売れた商品）を読み取り S/A/B ランクで記録する
// @match        https://jp.mercari.com/*
// @grant        none
// @updateURL    https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/mercari_speed_finder.user.js
// @downloadURL  https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/mercari_speed_finder.user.js
// ==/UserScript==

(function () {
    'use strict';

    const SERVER   = 'http://localhost:8769/speed-hit';
    const NEXT_SEL = '[data-testid="pagination-next-button"] a';

    // localStorage keys (sf_ prefix)
    const SF_MODE     = 'sf_mode';      // 'search' | 'processing'
    const SF_URL_IDX  = 'sf_urlIdx';
    const SF_ITEMS    = 'sf_items';     // item URLs for current page
    const SF_ITEM_IDX = 'sf_itemIdx';
    const SF_CATEGORY = 'sf_category';
    const SF_NEXT_URL = 'sf_nextUrl';   // next page URL (empty = last page)

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

    const BADGE_PATTERNS = [
        { re: /(\d+)分で売れた商品/, mul: 1 },
        { re: /(\d+)時間で売れた商品/, mul: 60 },
        // 日以内は除外
    ];

    // ── パーサ ────────────────────────────────────────────────────────────────

    function parseDuration(text) {
        for (const { re, mul } of BADGE_PATTERNS) {
            const m = text.match(re);
            if (m) return { min: parseInt(m[1], 10) * mul, raw: m[0] };
        }
        return null;
    }

    function parseModelNumber(title) {
        const hits = title.match(/\b[A-Z]{2,}[A-Z0-9\-\/\.]{3,}\b/g);
        if (!hits || !hits.length) return '';
        return hits.reduce((a, b) => (b.length > a.length ? b : a));
    }

    function parsePrice(text) {
        const d = text.replace(/,/g, '').match(/\d+/);
        return d ? parseInt(d[0], 10) : null;
    }

    // ── localStorage ─────────────────────────────────────────────────────────

    const ls = {
        get:  k        => localStorage.getItem(k),
        set:  (k, v)   => localStorage.setItem(k, v),
        del:  k        => localStorage.removeItem(k),
        json: (k, def) => { try { return JSON.parse(localStorage.getItem(k) || def); } catch { return JSON.parse(def); } },
    };

    function clearState() {
        [SF_MODE, SF_URL_IDX, SF_ITEMS, SF_ITEM_IDX, SF_CATEGORY, SF_NEXT_URL].forEach(ls.del);
    }

    // ── UI ───────────────────────────────────────────────────────────────────

    let $status = null;

    function showStatus(msg, bg) {
        if (!$status) {
            $status = document.createElement('div');
            $status.style.cssText = [
                'position:fixed', 'top:56px', 'right:8px', 'z-index:99999',
                'padding:7px 12px', 'border-radius:6px', 'font-size:11px',
                'color:#fff', 'max-width:280px', 'word-break:break-all',
                'pointer-events:none', 'box-shadow:0 2px 6px rgba(0,0,0,.4)',
                'line-height:1.5',
            ].join(';');
            document.body.appendChild($status);
        }
        $status.style.background = bg || '#424242';
        $status.textContent = msg;
    }

    function addButton() {
        if (document.getElementById('sf-btn')) return;
        const btn = document.createElement('button');
        btn.id = 'sf-btn';
        const active = !!ls.get(SF_MODE);
        btn.textContent = active ? '■ 速売れ停止' : '▶ 速売れ開始';
        btn.style.cssText = [
            'position:fixed', 'bottom:170px', 'left:8px', 'z-index:99999',
            'padding:7px 12px', 'border:none', 'border-radius:6px',
            'cursor:pointer', 'font-size:12px', 'font-weight:bold', 'line-height:1',
            'background:' + (active ? '#616161' : '#c62828'),
            'color:#fff', 'box-shadow:0 2px 6px rgba(0,0,0,.4)',
        ].join(';');
        btn.onclick = () => {
            if (ls.get(SF_MODE)) {
                clearState();
                btn.textContent = '▶ 速売れ開始';
                btn.style.background = '#c62828';
                showStatus('停止しました', '#616161');
            } else {
                btn.textContent = '■ 速売れ停止';
                btn.style.background = '#616161';
                startSearch(0);
            }
        };
        document.body.appendChild(btn);
    }

    // ── 検索ページ処理 ────────────────────────────────────────────────────────

    function startSearch(urlIdx) {
        ls.set(SF_MODE,     'search');
        ls.set(SF_URL_IDX,  urlIdx);
        ls.set(SF_CATEGORY, SEARCH_URLS[urlIdx].name);
        ls.del(SF_NEXT_URL);
        window.location.href = SEARCH_URLS[urlIdx].url;
    }

    async function runSearch() {
        const urlIdx   = parseInt(ls.get(SF_URL_IDX) || '0', 10);
        const category = ls.get(SF_CATEGORY) || SEARCH_URLS[urlIdx].name;

        await sleep(2000);
        if (ls.get(SF_MODE) !== 'search') return;

        // 上から下へじわじわスクロールしながら商品URLを収集
        window.scrollTo(0, 0);
        await sleep(500);

        const items = [];
        const seen  = new Set();

        function collectVisible() {
            document.querySelectorAll('a[data-testid="thumbnail-link"]').forEach(a => {
                const href = a.getAttribute('href') || '';
                if (!href.includes('/item/')) return;
                const full = href.startsWith('http') ? href : 'https://jp.mercari.com' + href;
                if (!seen.has(full)) { seen.add(full); items.push(full); }
            });
        }

        const deadline = Date.now() + 60000;
        while (Date.now() < deadline) {
            if (ls.get(SF_MODE) !== 'search') return;
            collectVisible();
            showStatus(`${category}: ${items.length}件収集中…`, '#1565c0');
            const atBottom = Math.ceil(window.scrollY + window.innerHeight) >= document.body.scrollHeight - 100;
            if (atBottom) break;
            window.scrollBy(0, 600);
            await sleep(500);
        }
        await sleep(800);
        collectVisible();  // 最下部到達後の最終収集

        // 次ページボタン
        const nextBtn = document.querySelector(NEXT_SEL);
        ls.set(SF_NEXT_URL, nextBtn ? nextBtn.href : '');

        ls.set(SF_ITEMS,    JSON.stringify(items));
        ls.set(SF_ITEM_IDX, '0');
        ls.set(SF_MODE,     'processing');

        showStatus(`${category}: ${items.length}件 → 処理開始`, '#2e7d32');
        await sleep(1000);

        if (items.length > 0) {
            window.location.href = items[0];
        } else {
            advancePage(urlIdx);
        }
    }

    // ── 商品ページ処理 ────────────────────────────────────────────────────────

    async function runProcess() {
        const items    = ls.json(SF_ITEMS, '[]');
        const idx      = parseInt(ls.get(SF_ITEM_IDX) || '0', 10);
        const category = ls.get(SF_CATEGORY) || '';
        const urlIdx   = parseInt(ls.get(SF_URL_IDX) || '0', 10);

        if (idx >= items.length) {
            advancePage(urlIdx);
            return;
        }

        showStatus(`[${idx + 1}/${items.length}] ${category}`, '#e65100');

        await sleep(1600);
        if (ls.get(SF_MODE) !== 'processing') return;

        const dur = parseDuration(document.body.innerText);

        if (dur && dur.min <= 60) {
            const nameEl      = document.querySelector('[data-testid="name"]');
            const priceEl     = document.querySelector('[data-testid="price"]');
            const title       = nameEl  ? nameEl.innerText.trim()       : document.title;
            const modelNumber = parseModelNumber(title);

            if (modelNumber) {
                const price  = priceEl ? parsePrice(priceEl.innerText) : null;
                const itemId = window.location.pathname.split('/').pop();
                await fetch(SERVER, {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        itemId, category,
                        name: title, modelNumber, price,
                        durationMin: dur.min,
                        durationRaw: dur.raw,
                        url: window.location.href,
                    }),
                }).catch(() => {});
            }
        }

        const nextIdx = idx + 1;
        ls.set(SF_ITEM_IDX, nextIdx);

        await sleep(900 + Math.random() * 900);
        if (ls.get(SF_MODE) !== 'processing') return;

        if (nextIdx < items.length) {
            window.location.href = items[nextIdx];
        } else {
            advancePage(urlIdx);
        }
    }

    // ── ページ・カテゴリ遷移 ──────────────────────────────────────────────────

    function advancePage(urlIdx) {
        const nextUrl = ls.get(SF_NEXT_URL) || '';
        if (nextUrl) {
            ls.set(SF_MODE,     'search');
            ls.set(SF_ITEMS,    '[]');
            ls.set(SF_ITEM_IDX, '0');
            window.location.href = nextUrl;
        } else {
            goNextCategory(urlIdx);
        }
    }

    function goNextCategory(urlIdx) {
        const next = urlIdx + 1;
        if (next < SEARCH_URLS.length) {
            showStatus(`次へ: ${SEARCH_URLS[next].name}`, '#1565c0');
            setTimeout(() => startSearch(next), 1500);
        } else {
            clearState();
            showStatus('速売れリサーチ完了！', '#1b5e20');
            const btn = document.getElementById('sf-btn');
            if (btn) { btn.textContent = '▶ 速売れ開始'; btn.style.background = '#c62828'; }
        }
    }

    // ── ユーティリティ ────────────────────────────────────────────────────────

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    // ── エントリポイント ──────────────────────────────────────────────────────

    window.addEventListener('load', () => {
        setTimeout(() => {
            addButton();
            const mode = ls.get(SF_MODE);
            const href = window.location.href;

            if (!mode) return;

            if (mode === 'search' && href.includes('/search')) {
                runSearch();
            } else if (mode === 'processing' && href.includes('/item/')) {
                runProcess();
            } else {
                showStatus('ページ待機中…', '#795548');
                setTimeout(() => window.location.reload(), 3000);
            }
        }, 1500);
    });

})();
