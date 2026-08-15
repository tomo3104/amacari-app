// ==UserScript==
// @name         Mercari Description Model Finder
// @namespace    http://tampermonkey.net/
// @version      2.70
// @description  タイトルに型番がない商品の説明文から型番を抽出してlist.jsonと照合（同一オリジンiframe方式・ウォッチドッグ・説明文抜粋記録・実験ログモード・型番判定の正規表現改善(ダッシュ後数字のみ対応・全角ダッシュ対応)・診断ログのO(n²)化を修正(直近200件のみ保持)・50件ごとの処理速度計測を追加・markProcessedのメーカー横断O(n)蓄積バグを修正(Setキャッシュ化)）
// @match        https://jp.mercari.com/*
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      localhost
// @updateURL    https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/mercari_desc_model_finder.user.js
// @downloadURL  https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/mercari_desc_model_finder.user.js
// ==/UserScript==

(function () {
    'use strict';

    const SERVER_URL      = 'http://localhost:8766/check-mercari';
    const PROGRESS_URL    = 'http://localhost:8766/save-progress';
    const TIMING_URL      = 'http://localhost:8766/log-timing';
    const SAVE_INTERVAL   = 30; // 何件ごとにサーバー中間送信するか
    const _SHARED_TPL_KEY = 'mercari_api_shared_tpl';
    const QUEUE_KEY       = 'desc_model_queue';
    const RESULT_KEY      = 'desc_model_results';
    const PROCESSED_KEY     = 'desc_model_processed'; // 処理済み商品IDの蓄積（重複読み込み防止）
    const CRAWLER_KEY         = 'desc_crawler_state';   // 発掘クローラーの進行状態
    const DESC_HEARTBEAT      = 'desc_finder_hb';        // ウォッチドッグ用ハートビート
    const DESC_WD_TIMEOUT     = 300000;                  // ウォッチドッグ5分（フリーズ検知→自動リロード）
    const MAX_PAGES_CRAWLER   = 1;                       // クローラーモードの1メーカーあたり最大ページ数
    const _uw             = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

    let _pauseRequested  = false; // 一時停止フラグ
    let _crawlerPauseBtn = null;  // 一時停止ボタン参照（複数箇所から削除できるように）

    // タイトルに型番が含まれるか判定
    // ダッシュ後は数字のみでも型番として認める（PZ-860・TV-5100等）。英字必須にしていたのを緩和（2026-08-15）
    const HAS_MODEL_RE = /\b(?:[A-Z]{2,}-(?=[A-Z0-9]*[0-9])[A-Z0-9]{2,}|[A-Z]{1,3}[0-9]{3,}[A-Z0-9]*)\b/i;

    // 説明文から型番を抽出（ラベルあり・全件取得）
    const DESC_LABEL_RE = /(?:【)?(?:型番|品番|型式|型名|モデル(?:番号|名)?|製品番号|商品番号)(?:】)?[：:\s]+([A-Za-z][A-Za-z0-9\-\/\.]{3,24})/gi;
    // フォールバック: ダッシュ後に数字を含む（Wi-Fi等の英字のみは_NON_MODELで別途除外）
    const DESC_FALLBACK_RE = /\b([A-Za-z]{2,5}-(?=[A-Za-z0-9]*[0-9])[A-Za-z0-9]{3,20})\b/gi;

    // 型番候補の除外セット・パターン
    const _NON_MODEL = new Set(['WI-FI','USB-A','USB-B','USB-C','TYPE-A','TYPE-B','TYPE-C','HDMI','AC-DC','DC-AC']);
    // 各パターンに$を付けて短い汎用表記のみ除外（TV-5100等の実型番を巻き込まないよう2026-08-15修正）
    const _NON_MODEL_RE = /^(?:AC-\d{1,2}|DC-\d{1,2}|USB-\d{1,2}|WI-FI\d{1,2}|TV-\d{1,2}|LAN-\d{1,2}|PC-\d{1,2})$/i;
    function _isValidModel(s) {
        if (s.length < 4 || s.length > 25) return false;
        if (_NON_MODEL.has(s)) return false;
        if (_NON_MODEL_RE.test(s)) return false;
        // 5文字以上で数字ゼロは型番として不自然
        if (s.length >= 5 && !/\d/.test(s)) return false;
        return true;
    }

    // 説明文DOMセレクター（メルカリのPREタグ）
    const DESC_SEL = 'pre[class*="merText"]';

    const MAX_PAGES = 20;

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    // 処理済みIDのSetをページ読み込み時に一度だけlocalStorageから読み込みキャッシュする。
    // 以前は商品1件処理するたびに配列全体をJSON.parse/includes線形探索/JSON.stringifyしており、
    // このIDリストはメーカーをまたいで（ページ遷移をまたいで）最大1万件まで蓄積するため、
    // 巡回が進むほど1件あたりの処理が線形に重くなっていた（2026-08-15発見）。
    function _getProcessedSet() {
        if (!_processedSetCache) {
            _processedSetCache = new Set(JSON.parse(localStorage.getItem(PROCESSED_KEY) || '[]'));
        }
        return _processedSetCache;
    }

    function markProcessed(id) {
        const set = _getProcessedSet();
        if (!set.has(id)) {
            set.add(id);
            _processedDirty = true;
        }
    }

    // キャッシュ済みSetをlocalStorageへ書き戻す（ページ離脱前・一定間隔ごとに呼ぶ）
    function flushProcessed() {
        if (!_processedDirty || !_processedSetCache) return;
        let arr = Array.from(_processedSetCache);
        if (arr.length > 10000) arr = arr.slice(-10000);
        localStorage.setItem(PROCESSED_KEY, JSON.stringify(arr));
        _processedDirty = false;
    }

    function _getSharedTpl() {
        try {
            const s = _uw.localStorage.getItem(_SHARED_TPL_KEY);
            return s ? JSON.parse(s) : null;
        } catch(e) { return null; }
    }

    // 全角ダッシュ「ー」等をASCIIハイフンに正規化してからマッチさせる（NTNー64A等の対策・2026-08-15）
    function _normalizeDash(s) { return s.replace(/[ー－―‐]/g, '-'); }

    function hasModelInTitle(title) { return HAS_MODEL_RE.test(_normalizeDash(title)); }

    // 複数の型番候補を返す（ラベルあり：最大3件、フォールバック：最長1件）
    function extractModelsFromDesc(text) {
        text = _normalizeDash(text);
        const labeled = [];
        let m;
        const re = new RegExp(DESC_LABEL_RE.source, 'gi');
        while ((m = re.exec(text)) !== null) {
            const c = m[1].toUpperCase();
            if (_isValidModel(c) && !labeled.includes(c)) labeled.push(c);
            if (labeled.length >= 3) break;
        }
        if (labeled.length > 0) return labeled;

        // フォールバック（最長一致1件のみ）
        const fbRe = new RegExp(DESC_FALLBACK_RE.source, 'gi');
        const fallback = [];
        while ((m = fbRe.exec(text)) !== null) {
            const c = m[1].toUpperCase();
            if (_isValidModel(c) && !fallback.includes(c)) fallback.push(c);
        }
        if (fallback.length === 0) return [];
        return [fallback.reduce((a, b) => a.length >= b.length ? a : b)];
    }

    // ===== 実験ログモード（一時検証用。console で localStorage.setItem('desc_experiment_mode','1') で有効化） =====
    const EXPERIMENT_KEY = 'desc_experiment_mode';
    function isExperimentMode() { return localStorage.getItem(EXPERIMENT_KEY) === '1'; }
    let _experimentBuffer = [];
    function logExperiment(entry) {
        if (!isExperimentMode()) return;
        _experimentBuffer.push(entry);
        if (_experimentBuffer.length >= 20) flushExperimentLog();
    }
    function flushExperimentLog() {
        if (_experimentBuffer.length === 0) return;
        const batch = _experimentBuffer.splice(0, _experimentBuffer.length);
        fetch('http://localhost:8766/desc-experiment-log', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ items: batch }),
        }).catch(() => {});
    }

    // 検証用：型番が見つかった箇所の前後を抜粋（全文は保存しない＝データ量を抑える）
    function extractExcerpt(text, model) {
        const idx = text.toUpperCase().indexOf(model.toUpperCase());
        const clean = s => s.replace(/\s+/g, ' ').trim();
        if (idx === -1) return clean(text.slice(0, 150));
        const start = Math.max(0, idx - 60);
        const end   = Math.min(text.length, idx + model.length + 60);
        return (start > 0 ? '…' : '') + clean(text.slice(start, end)) + (end < text.length ? '…' : '');
    }

    // ===== ステータスUI（全ページ共通） =====
    const statusEl = document.createElement('div');
    statusEl.style.cssText = `
        position:fixed; bottom:20px; left:20px; z-index:99999;
        background:rgba(0,0,0,0.80); color:#fff; padding:8px 16px;
        border-radius:8px; font-size:13px; display:none;
        max-width:360px; font-family:sans-serif; line-height:1.5;
    `;
    document.body.appendChild(statusEl);

    function showStatus(msg, bg) {
        statusEl.style.display = 'block';
        statusEl.style.background = bg || 'rgba(0,0,0,0.80)';
        statusEl.textContent = msg;
    }
    function hideStatus() { statusEl.style.display = 'none'; }

    // ========================================================
    //  共有変数（return より前に初期化必須）
    // ========================================================
    var _abortFetch = false;
    var _diagLog    = [];
    var _processedSetCache = null; // markProcessed高速化用（ページ読み込み時に一度だけlocalStorageから読み込みSetでキャッシュ）
    var _processedDirty    = false;

    // ========================================================
    //  モード判定
    // ========================================================
    const itemMatch = location.pathname.match(/^\/item\/(m[A-Za-z0-9]+)/);

    if (itemMatch) {
        // ============ 商品ページモード ============
        runItemPageMode(itemMatch[1]);
    } else {
        if (window !== window.top) return; // iframeの中ではクローラー/起動モードを動かさない
        startWatchdog();
        // キュー実行中にエラーページへリダイレクトされた場合、自動スキップして再開
        const _qStr = localStorage.getItem(QUEUE_KEY);
        if (_qStr) {
            try {
                const _q = JSON.parse(_qStr);
                if (_q.running && _q.items && _q.pendingIdx != null) {
                    const skipTo = _q.pendingIdx + 1;
                    if (skipTo < _q.items.length) {
                        _q.pendingIdx = skipTo;
                        localStorage.setItem(QUEUE_KEY, JSON.stringify(_q));
                        showStatus(`削除済み商品をスキップ → [${skipTo + 1}/${_q.items.length}]`, 'rgba(160,80,0,0.88)');
                        setTimeout(() => { window.location.replace(_q.items[skipTo].url); }, 1000);
                    } else {
                        delete _q.pendingIdx;
                        localStorage.setItem(QUEUE_KEY, JSON.stringify(_q));
                        if (_q.crawlerMode) {
                            finishMakerAndContinue();
                        } else {
                            finishAndSend(null);
                        }
                    }
                    return;
                }
            } catch(e) {}
        }

        // 発掘クローラーモード：検索ページに来たら次のメーカーを収集（QUEUE_KEYに依存しない）
        const _crawlerStr = localStorage.getItem(CRAWLER_KEY);
        if (_crawlerStr) {
            try {
                const _cs = JSON.parse(_crawlerStr);
                if (_cs.running) {
                    runCrawlerSearchMode(_cs);
                    return;
                }
            } catch(e) {}
        }

        // ============ 起動ページモード ============
        runLaunchMode();
    }

    // ========================================================
    //  商品ページモード：DOMから説明文を読んで次へ進む
    // ========================================================
    function runItemPageMode(currentId) {
        const queueStr = localStorage.getItem(QUEUE_KEY);
        if (!queueStr) return; // スクリプト未起動なら何もしない

        let queue;
        try { queue = JSON.parse(queueStr); } catch(e) { return; }
        if (!queue.running) return;

        const items = queue.items;
        const idx   = items.findIndex(i => i.id === currentId);
        if (idx === -1) { localStorage.removeItem(QUEUE_KEY); return; }

        const total = items.length;

        // 正常到達：pendingIdx をクリアして currentIdx を更新
        delete queue.pendingIdx;
        queue.currentIdx = idx;
        localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));

        // この商品を処理済みとして記録（次回同じメーカーを調査する際にスキップ）
        markProcessed(currentId);

        // 照合して終了ボタン（収集停止＋即時照合）
        const stopBtn = document.createElement('button');
        stopBtn.textContent = '照合して終了';
        stopBtn.style.cssText = `
            position:fixed; bottom:110px; left:20px; z-index:99999;
            padding:8px 16px; background:#1976D2; color:#fff;
            border:none; border-radius:6px; font-size:13px; cursor:pointer;
            box-shadow:0 2px 6px rgba(0,0,0,0.3);
        `;
        stopBtn.onclick = () => {
            localStorage.removeItem(CRAWLER_KEY); // クローラーモードも停止
            localStorage.removeItem(QUEUE_KEY);
            stopBtn.remove();
            finishAndSend(null);
        };
        document.body.appendChild(stopBtn);

        showStatus(`[${idx + 1}/${total}] 説明文を読み込み中...`);

        // 次ページへ進む内部関数
        function goNext() {
            if (!localStorage.getItem(QUEUE_KEY)) return; // 中止済み
            const nextIdx = idx + 1;
            if (nextIdx < total) {
                // 遷移先をQUEUEに記録（リダイレクト時に自動スキップするため）
                queue.pendingIdx = nextIdx;
                localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
                window.location.replace(items[nextIdx].url);
            } else {
                if (queue.crawlerMode) {
                    finishMakerAndContinue();
                } else {
                    finishAndSend(stopBtn);
                }
            }
        }

        // DOMのレンダリングを待ちながら説明文を取得
        const waitForDesc = (retries) => {
            if (!localStorage.getItem(QUEUE_KEY)) { stopBtn.remove(); return; } // 中止済み

            const el = document.querySelector(DESC_SEL);
            if (el && (el.innerText || '').trim().length > 5) {
                const desc    = el.innerText || '';
                const models  = extractModelsFromDesc(desc);

                // タイトルor説明文にセット・まとめ系ワードがあれば名前にフラグを付けてヒットに含める
                const SET_WORDS = ['セット', 'まとめ', 'まとめ売', 'セット売', '個セット', '台セット', '点セット', '本セット'];
                const itemName  = items[idx].name;
                const isBundle  = SET_WORDS.some(w => itemName.includes(w) || desc.includes(w));

                if (models.length > 0) {
                    const results = JSON.parse(localStorage.getItem(RESULT_KEY) || '[]');
                    const item    = items[idx];
                    const tag     = isBundle ? '【セット】' : '';
                    models.forEach(model => {
                        // 【セット】タグはサーバー側(find_matches)が名前を見て一括付与するため、ここでは付けない（二重表示防止）
                        const label = `${item.name} ${model}`;
                        results.push({ name: label, model, price: item.price, url: item.url, image: item.image, desc_excerpt: extractExcerpt(desc, model) });
                    });
                    localStorage.setItem(RESULT_KEY, JSON.stringify(results));
                    showStatus(`[${idx + 1}/${total}] ${tag}型番取得: ${models.join(', ')}\n取得済: ${results.length}件`, 'rgba(20,110,0,0.88)');

                    // 30件ごとにサーバーへ中間保存（クラッシュ対策）
                    if (results.length % SAVE_INTERVAL === 0) {
                        sendProgress(results.slice(-SAVE_INTERVAL));
                    }
                } else {
                    const gotSoFar = JSON.parse(localStorage.getItem(RESULT_KEY) || '[]').length;
                    showStatus(`[${idx + 1}/${total}] 型番なし → スキップ（取得済: ${gotSoFar}件）`);
                }

                setTimeout(goNext, 500);

            } else if (retries > 0) {
                setTimeout(() => waitForDesc(retries - 1), 300);
            } else {
                // タイムアウト → スキップ
                const gotSoFar = JSON.parse(localStorage.getItem(RESULT_KEY) || '[]').length;
                showStatus(`[${idx + 1}/${total}] タイムアウト → スキップ（取得済: ${gotSoFar}件）`);
                setTimeout(goNext, 1000);
            }
        };

        // エラーページ（商品削除/売り切れ）を早期検出してスキップ
        function isErrorPage() {
            const bodyText = document.body.innerText || '';
            return bodyText.includes('このページは存在しません') ||
                   bodyText.includes('商品が見つかりません') ||
                   bodyText.includes('ページが見つかりません') ||
                   bodyText.includes('404');
        }

        // Reactのレンダリングが完了するまで待つ
        setTimeout(() => {
            if (isErrorPage()) {
                const gotSoFar = JSON.parse(localStorage.getItem(RESULT_KEY) || '[]').length;
                showStatus(`[${idx + 1}/${total}] 商品削除済み → スキップ（取得済: ${gotSoFar}件）`);
                setTimeout(goNext, 800);
            } else {
                window.scrollTo(0, 400); // 説明文が画面内に入るようスクロール（遅延読み込み対策）
                waitForDesc(40);
            }
        }, 1000);
    }

    // ========================================================
    //  中間保存（30件ごと）→ サーバーへ送信してシートに記録
    // ========================================================
    function sendProgress(items, makerName) {
        GM_xmlhttpRequest({
            method:  'POST',
            url:     PROGRESS_URL,
            headers: { 'Content-Type': 'application/json' },
            data:    JSON.stringify({ items, keyword: makerName || '' }),
            timeout: 30000,
            onload:  res => {
                try {
                    const r = JSON.parse(res.responseText);
                    if (r.ok) console.log(`[desc-finder] 中間保存: ${items.length}件`);
                } catch(e) {}
            },
            onerror: () => console.warn('[desc-finder] 中間保存失敗（サーバー未起動?）'),
        });
    }

    // ========================================================
    //  全件完了 → サーバーへ送信
    // ========================================================
    function finishAndSend(stopBtn) {
        const results = JSON.parse(localStorage.getItem(RESULT_KEY) || '[]');
        localStorage.removeItem(QUEUE_KEY);
        if (stopBtn) stopBtn.remove();

        if (results.length === 0) {
            localStorage.removeItem(RESULT_KEY);
            showStatus('説明文から型番を取得できた商品はありませんでした', 'rgba(100,80,0,0.88)');
            setTimeout(hideStatus, 6000);
            return;
        }

        showStatus(`説明文型番 ${results.length}件 → list.jsonと照合中...`, 'rgba(0,70,160,0.88)');

        GM_xmlhttpRequest({
            method:  'POST',
            url:     SERVER_URL,
            headers: { 'Content-Type': 'application/json' },
            data:    JSON.stringify({ items: results, source: 'desc' }),
            timeout: 120000,
            onload: res => {
                localStorage.removeItem(RESULT_KEY);
                try {
                    const result = JSON.parse(res.responseText);
                    showResults(result.matches || []);
                } catch(e) {
                    showStatus('サーバー応答エラー', 'rgba(160,0,0,0.88)');
                }
            },
            ontimeout: () => {
                localStorage.removeItem(RESULT_KEY);
                showStatus('タイムアウト — ヒットはシートに保存済み', 'rgba(100,80,0,0.88)');
            },
            onerror: () => showStatus(
                `サーバー未起動 — ${results.length}件のデータは保持中。サーバー起動後にメルカリ検索ページを開いて「照合して送信」を押してください`,
                'rgba(160,0,0,0.88)'
            ),
        });
    }

    // ========================================================
    //  発掘クローラー：メーカーリスト取得 → 巡回開始
    // ========================================================
    function startCrawler(group) {
        showStatus('メーカーリストを取得中...');
        GM_xmlhttpRequest({
            method:  'GET',
            url:     'http://localhost:8766/get-manufacturers?mode=desc',
            timeout: 30000,
            onload: res => {
                let makers;
                try {
                    const data = JSON.parse(res.responseText);
                    makers = (data.manufacturers || []).filter(m => {
                        if (!m.url) return false;
                        if (group === 'ALL') return true;
                        const gs = group.split(',').map(g => g.trim());
                        return gs.some(g => m.group === g);
                    });
                } catch(e) {
                    showStatus('メーカーリスト取得エラー', 'rgba(160,0,0,0.88)');
                    return;
                }
                if (makers.length === 0) {
                    showStatus(`グループ「${group}」のメーカーが見つかりません`, 'rgba(160,80,0,0.88)');
                    return;
                }
                const crawlerState = {
                    makers:     makers,
                    currentIdx: 0,
                    group:      group,
                    running:    true,
                    startedAt:  Date.now(),
                };
                localStorage.setItem(CRAWLER_KEY, JSON.stringify(crawlerState));
                localStorage.setItem(RESULT_KEY, JSON.stringify([]));
                localStorage.removeItem(QUEUE_KEY);
                localStorage.removeItem(_SHARED_TPL_KEY);
                localStorage.removeItem(PROCESSED_KEY);
                _processedSetCache = null; _processedDirty = false; // キャッシュも合わせてリセット
                // desc_last_run_* をリセット（前回実行カットオフを解除して全件収集）
                Object.keys(localStorage).filter(k => k.startsWith('desc_last_run_')).forEach(k => localStorage.removeItem(k));
                showStatus(`発掘クローラー開始 — ${makers.length}メーカー (グループ: ${group})`);
                dlog(`===== クローラー開始 ${makers.length}メーカー (グループ: ${group}) =====`);
                GM_xmlhttpRequest({ method: 'POST', url: TIMING_URL, headers: { 'Content-Type': 'application/json' },
                    data: JSON.stringify({ type: 'desc_start', group, total: makers.length }) });
                setTimeout(() => { window.location.href = makers[0].url; }, 1500);
            },
            onerror:    () => showStatus('サーバー未起動（localhost:8766）', 'rgba(160,0,0,0.88)'),
            ontimeout:  () => showStatus('タイムアウト', 'rgba(160,0,0,0.88)'),
        });
    }

    // 発掘クローラー：検索ページで商品を収集して説明文ページへ遷移
    async function runCrawlerSearchMode(crawlerState) {
        const makerIdx    = crawlerState.currentIdx;
        const maker       = crawlerState.makers[makerIdx];
        const makersTotal = crawlerState.makers.length;

        // 中止ボタン
        const abortBtn = document.createElement('button');
        abortBtn.textContent = 'クローラー中止';
        abortBtn.style.cssText = `
            position:fixed; bottom:80px; left:20px; z-index:99999;
            padding:8px 14px; background:#B71C1C; color:#fff;
            border:none; border-radius:6px; font-size:12px; cursor:pointer;
            box-shadow:0 2px 6px rgba(0,0,0,0.3);
        `;
        abortBtn.onclick = () => {
            localStorage.removeItem(CRAWLER_KEY);
            localStorage.removeItem(QUEUE_KEY);
            abortBtn.remove();
            if (_crawlerPauseBtn) { _crawlerPauseBtn.remove(); _crawlerPauseBtn = null; }
            finishAndSend(null);
        };
        document.body.appendChild(abortBtn);

        // 一時停止ボタン（現メーカー完了後に停止・CRAWLER_KEYは保持→再開可能）
        _pauseRequested  = false;
        _crawlerPauseBtn = document.createElement('button');
        _crawlerPauseBtn.textContent = '一時停止';
        _crawlerPauseBtn.style.cssText = `
            position:fixed; bottom:120px; left:20px; z-index:99999;
            padding:8px 14px; background:#E65100; color:#fff;
            border:none; border-radius:6px; font-size:12px; cursor:pointer;
            box-shadow:0 2px 6px rgba(0,0,0,0.3);
        `;
        _crawlerPauseBtn.onclick = () => {
            _pauseRequested = true;
            _crawlerPauseBtn.textContent = '停止待ち...';
            _crawlerPauseBtn.disabled = true;
            _crawlerPauseBtn.style.background = '#9E9E9E';
        };
        document.body.appendChild(_crawlerPauseBtn);

        showStatus(`[${makerIdx + 1}/${makersTotal}] ${maker.name} — テンプレート待機中...`);

        // collector scriptがテンプレートを更新するまで最大8秒待つ
        let tpl = null;
        for (let i = 0; i < 16; i++) {
            tpl = _getSharedTpl();
            if (tpl) break;
            await sleep(500);
        }

        if (!tpl) {
            showStatus(`テンプレート取得できず → スキップ: ${maker.name}`, 'rgba(160,80,0,0.88)');
            await sleep(2000);
            abortBtn.remove();
            if (_crawlerPauseBtn) { _crawlerPauseBtn.remove(); _crawlerPauseBtn = null; }
            finishMakerAndContinue();
            return;
        }

        showStatus(`[${makerIdx + 1}/${makersTotal}] ${maker.name} — ${MAX_PAGES_CRAWLER}ページ収集中...`);

        let allItems;
        try {
            allItems = await fetchItems(tpl, MAX_PAGES_CRAWLER);
        } catch(e) {
            showStatus(`収集エラー: ${e.message} → スキップ`, 'rgba(160,0,0,0.88)');
            await sleep(2000);
            abortBtn.remove();
            if (_crawlerPauseBtn) { _crawlerPauseBtn.remove(); _crawlerPauseBtn = null; }
            finishMakerAndContinue();
            return;
        }

        const itemList     = Object.values(allItems);
        const processedSet = _getProcessedSet();
        const noModelItems = itemList.filter(i => !hasModelInTitle(i.name) && !processedSet.has(i.id));

        if (isExperimentMode()) {
            itemList.forEach(i => {
                if (hasModelInTitle(i.name)) {
                    logExperiment({ maker: maker.name, title: i.name, url: i.url, has_model_in_title: true, desc_fetched: '', desc: '', extracted: '' });
                }
            });
        }

        showStatus(`[${makerIdx + 1}/${makersTotal}] ${maker.name} — ${itemList.length}件収集 / 未処理型番なし: ${noModelItems.length}件`);
        dlog(`[${makerIdx + 1}/${makersTotal}] ${maker.name}: ${itemList.length}件収集 / 型番なし未処理: ${noModelItems.length}件`);

        try {
            if (noModelItems.length === 0) {
                await sleep(1000);
                abortBtn.remove();
                if (_crawlerPauseBtn) { _crawlerPauseBtn.remove(); _crawlerPauseBtn = null; }
                finishMakerAndContinue();
                return;
            }
            abortBtn.remove();
            if (_crawlerPauseBtn) { _crawlerPauseBtn.remove(); _crawlerPauseBtn = null; }
            await processItemsWithFetch(noModelItems, true, maker.name);
        } catch(e) {
            console.error('[desc-finder] runCrawlerSearchMode ERROR:', e);
            showStatus(`[ERROR] ${e.message}`, 'rgba(200,0,0,0.95)');
        }
    }

    // 発掘クローラー：1メーカー完了 → 次のメーカーへ or 全完了
    function finishMakerAndContinue() {
        const crawlerStr = localStorage.getItem(CRAWLER_KEY);
        if (!crawlerStr) { finishAndSend(null); return; }

        let crawlerState;
        try { crawlerState = JSON.parse(crawlerStr); } catch(e) { finishAndSend(null); return; }

        localStorage.removeItem(QUEUE_KEY);

        crawlerState.currentIdx++;
        const done  = crawlerState.currentIdx;
        const total = crawlerState.makers.length;

        if (done >= total) {
            localStorage.removeItem(CRAWLER_KEY);
            const _elapsed = Math.round((Date.now() - (crawlerState.startedAt || Date.now())) / 1000);
            const _mins = Math.floor(_elapsed / 60);
            const _secs = _elapsed % 60;
            const _startStr = crawlerState.startedAt ? new Date(crawlerState.startedAt).toTimeString().slice(0, 8) : '?';
            const _summary = `全完了: ${total}メーカー / 開始${_startStr} / 所要時間${_mins}分${_secs}秒`;
            showStatus(`発掘クローラー全完了 (${total}メーカー) → list.jsonと照合中...`, 'rgba(0,70,160,0.88)');
            dlog(`===== ${_summary} =====`);
            const _hits = JSON.parse(localStorage.getItem(RESULT_KEY) || '[]').length;
            GM_xmlhttpRequest({ method: 'POST', url: TIMING_URL, headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify({ type: 'desc_end', group: crawlerState.group, total, elapsed_ms: _elapsed * 1000, hits: _hits }) });
            finishAndSend(null);
            return;
        }

        localStorage.setItem(CRAWLER_KEY, JSON.stringify(crawlerState));
        const next = crawlerState.makers[done];
        const _accum = JSON.parse(localStorage.getItem(RESULT_KEY) || '[]').length;
        showStatus(`[${done}/${total}完了] 次: ${next.name}`, 'rgba(0,70,120,0.88)');
        dlog(`[${done}/${total}完了] 累計ヒット: ${_accum}件 → 次: ${next.name}`);
        localStorage.removeItem(_SHARED_TPL_KEY);

        // メーカー完了ごとに中間保存（止めてもデータが消えないように）
        const _interim      = JSON.parse(localStorage.getItem(RESULT_KEY) || '[]');
        const _completedMaker = crawlerState.makers[done - 1].name;

        const _buildPayload = () => JSON.stringify({ items: _interim, source: 'desc', maker: _completedMaker });

        // 一時停止フラグが立っていた場合は中間保存後に停止（CRAWLER_KEYは保持→再開可能）
        if (_pauseRequested) {
            _pauseRequested = false;
            const _doPause = () => {
                showStatus(`[${done}/${total}完了] 一時停止中 — メルカリを開いたら「クローラー再開」で続きから再開できます`, 'rgba(80,50,0,0.90)');
                dlog(`===== 一時停止: ${done}/${total}完了 =====`);
            };
            if (_interim.length > 0) {
                GM_xmlhttpRequest({
                    method: 'POST', url: SERVER_URL,
                    headers: { 'Content-Type': 'application/json' },
                    data: _buildPayload(),
                    timeout: 30000,
                    onload: () => { localStorage.setItem(RESULT_KEY, JSON.stringify([])); dlog(`[中間保存完了] ${_interim.length}件`); _doPause(); },
                    onerror:   () => { dlog('[中間保存失敗] ローカルに保持'); _doPause(); },
                    ontimeout: () => { dlog('[中間保存タイムアウト] ローカルに保持'); _doPause(); },
                });
            } else {
                _doPause();
            }
            return;
        }

        const _doNavigate = () => { window.location.href = next.url; };
        if (_interim.length > 0) {
            GM_xmlhttpRequest({
                method: 'POST', url: SERVER_URL,
                headers: { 'Content-Type': 'application/json' },
                data: _buildPayload(),
                timeout: 30000,
                onload: () => {
                    localStorage.setItem(RESULT_KEY, JSON.stringify([]));
                    dlog(`[中間保存完了] ${_interim.length}件`);
                    _doNavigate();
                },
                onerror:   () => { dlog('[中間保存失敗] ローカルに保持'); _doNavigate(); },
                ontimeout: () => { dlog('[中間保存タイムアウト] ローカルに保持'); _doNavigate(); },
            });
        } else {
            setTimeout(_doNavigate, 1500);
        }
    }

    // ========================================================
    //  起動ページモード：ボタン表示 → 収集開始
    // ========================================================
    function runLaunchMode() {
        const btnContainer = document.createElement('div');
        btnContainer.style.cssText = `
            position:fixed; bottom:130px; left:20px; z-index:99999;
            display:flex; flex-direction:column; align-items:flex-start; gap:8px;
        `;

        const searchBtn = document.createElement('button');
        searchBtn.textContent = '説明文リサーチ（現在の検索）';
        searchBtn.style.cssText = `
            padding:12px 18px; background:#C49A00; color:#fff;
            border:none; border-radius:6px; font-size:14px;
            cursor:pointer; box-shadow:0 2px 6px rgba(0,0,0,0.3);
        `;

        // 前回の途中データが残っていれば「再開」ボタンを追加
        const existingQueueStr = localStorage.getItem(QUEUE_KEY);
        if (existingQueueStr) {
            try {
                const existingQueue = JSON.parse(existingQueueStr);
                if (existingQueue.running && existingQueue.items && existingQueue.items.length > 0) {
                    const resumeIdx   = existingQueue.currentIdx || 0;
                    const totalItems  = existingQueue.items.length;
                    const savedResults = JSON.parse(localStorage.getItem(RESULT_KEY) || '[]').length;

                    const resumeBtn = document.createElement('button');
                    resumeBtn.textContent = `途中から再開 (${resumeIdx + 1}/${totalItems}件目 取得済:${savedResults}件)`;
                    resumeBtn.style.cssText = `
                        padding:10px 16px; background:#1565C0; color:#fff;
                        border:none; border-radius:6px; font-size:13px;
                        cursor:pointer; box-shadow:0 2px 6px rgba(0,0,0,0.3);
                    `;
                    resumeBtn.onclick = () => {
                        existingQueue.pendingIdx = resumeIdx;
                        localStorage.setItem(QUEUE_KEY, JSON.stringify(existingQueue));
                        showStatus(`再開: ${resumeIdx + 1}件目から...`);
                        window.location.replace(existingQueue.items[resumeIdx].url);
                    };
                    btnContainer.appendChild(resumeBtn);
                }
            } catch(e) {}
        }

        // サーバー未起動で終了した場合に残った結果データを送信するボタン
        const savedResults = JSON.parse(localStorage.getItem(RESULT_KEY) || '[]');
        if (savedResults.length > 0 && !existingQueueStr) {
            const retryBtn = document.createElement('button');
            retryBtn.textContent = `照合して送信（保存済み${savedResults.length}件）`;
            retryBtn.style.cssText = `
                padding:10px 16px; background:#B71C1C; color:#fff;
                border:none; border-radius:6px; font-size:13px;
                cursor:pointer; box-shadow:0 2px 6px rgba(0,0,0,0.3);
            `;
            retryBtn.onclick = () => { retryBtn.remove(); finishAndSend(null); };
            btnContainer.appendChild(retryBtn);
        }

        const crawlerBtn = document.createElement('button');
        crawlerBtn.textContent = '発掘クローラー（全メーカー巡回）';
        crawlerBtn.style.cssText = `
            padding:12px 18px; background:#6A1B9A; color:#fff;
            border:none; border-radius:6px; font-size:14px;
            cursor:pointer; box-shadow:0 2px 6px rgba(0,0,0,0.3);
        `;
        crawlerBtn.addEventListener('click', () => {
            const group = prompt('グループを入力（例: A / A,B / ALL）', 'ALL');
            if (!group) return;
            crawlerBtn.disabled = true;
            startCrawler(group.trim().toUpperCase());
        });

        // クローラーが途中で停止した場合の再開ボタン
        const existingCrawlerStr = localStorage.getItem(CRAWLER_KEY);
        if (existingCrawlerStr) {
            try {
                const ec = JSON.parse(existingCrawlerStr);
                if (ec.running && ec.makers) {
                    const resumeCrawlerBtn = document.createElement('button');
                    resumeCrawlerBtn.textContent = `クローラー再開 (${ec.currentIdx + 1}/${ec.makers.length}件目: ${ec.makers[ec.currentIdx].name})`;
                    resumeCrawlerBtn.style.cssText = `
                        padding:10px 16px; background:#4A148C; color:#fff;
                        border:none; border-radius:6px; font-size:13px;
                        cursor:pointer; box-shadow:0 2px 6px rgba(0,0,0,0.3);
                    `;
                    resumeCrawlerBtn.onclick = () => {
                        localStorage.removeItem(_SHARED_TPL_KEY);
                        window.location.href = ec.makers[ec.currentIdx].url;
                    };
                    btnContainer.appendChild(resumeCrawlerBtn);
                }
            } catch(e) {}
        }

        btnContainer.appendChild(searchBtn);
        btnContainer.appendChild(crawlerBtn);
        document.body.appendChild(btnContainer);

        searchBtn.addEventListener('click', async () => {
            const tpl = _getSharedTpl();
            if (!tpl) {
                showStatus('テンプレート未取得 → 先にメルカリで1回検索してください', 'rgba(160,0,0,0.88)');
                return;
            }

            searchBtn.disabled = true;
            searchBtn.textContent = '収集中...';

            // 手動実行は常に全件スキャン（前回実行時刻フィルタをリセット）
            const _bm = window.location.href.match(/brand_id=(\d+)/);
            const _uh = window.location.href.split('').reduce((a, c) => (Math.imul(31, a) + c.charCodeAt(0)) | 0, 0);
            localStorage.removeItem('desc_last_run_' + (_bm ? _bm[1] : Math.abs(_uh).toString(36)));

            showStatus(`現在の検索条件で収集中...`);
            let allItems;
            try {
                allItems = await fetchItems(tpl);
            } catch(e) {
                showStatus(`収集エラー: ${e.message}`, 'rgba(160,0,0,0.88)');
                searchBtn.disabled = false;
                searchBtn.textContent = '説明文リサーチ（現在の検索）';
                return;
            }

            const itemList      = Object.values(allItems);
            const processedSet  = _getProcessedSet();
            const allNoModelItems = itemList.filter(item => !hasModelInTitle(item.name));
            const noModelItems  = allNoModelItems.filter(item => !processedSet.has(item.id));
            const skippedCount  = allNoModelItems.length - noModelItems.length;

            const skipMsg = skippedCount > 0 ? ` (${skippedCount}件スキップ済み)` : '';
            showStatus(`${itemList.length}件収集 → 型番なし: ${allNoModelItems.length}件${skipMsg} → 未処理: ${noModelItems.length}件`);

            if (noModelItems.length === 0) {
                let msg;
                if (itemList.length === 0) {
                    msg = '前回実行以降の新着なし（スキャン対象ゼロ）';
                } else if (allNoModelItems.length === 0) {
                    msg = `収集した${itemList.length}件 全商品のタイトルに型番あり → 説明文スキャン不要`;
                } else {
                    msg = `型番なし${allNoModelItems.length}件はすべてスキャン済み（スキップ${skippedCount}件）`;
                }
                showStatus(msg, 'rgba(100,80,0,0.88)');
                searchBtn.disabled = false;
                searchBtn.textContent = '説明文リサーチ（現在の検索）';
                return;
            }

            localStorage.setItem(RESULT_KEY, JSON.stringify([]));
            showStatus(`${noModelItems.length}件の説明文をバックグラウンドで取得します（ページ移動なし）...`);
            await sleep(500);
            await processItemsWithFetch(noModelItems, false);
        });
    }

    // ========================================================
    //  商品説明文フェッチ（__NEXT_DATA__ パース方式 — ページ遷移なし）
    // ========================================================
    const DIAG_LOG_MAX = 200; // _diagLogを無制限に貯めるとJSON.stringifyが件数に比例して重くなり続け、長時間実行でUIスレッドを圧迫するため直近N件のみ保持

    function dlog(msg) {
        const t = new Date().toTimeString().slice(0,8);
        const line = `[${t}] ${msg}`;
        _diagLog.push(line);
        if (_diagLog.length > DIAG_LOG_MAX) _diagLog = _diagLog.slice(-DIAG_LOG_MAX);
        console.log('[desc-finder]', line);
        try { localStorage.setItem('desc_diag_log', JSON.stringify(_diagLog)); } catch(e) { console.warn('[desc-finder] dlog storage err:', e); }
        try { localStorage.setItem(DESC_HEARTBEAT, String(Date.now())); } catch(e) {}
    }

    // クローラー実行中に一定時間ハートビートが更新されなければフリーズとみなし、
    // 現在のページをリロードして復帰させる（状態はlocalStorageにあるので再開可能）
    function startWatchdog() {
        setInterval(() => {
            const crawlerStr = localStorage.getItem(CRAWLER_KEY);
            if (!crawlerStr) return;
            try {
                if (!JSON.parse(crawlerStr).running) return;
            } catch (e) { return; }
            const lastHb = parseInt(localStorage.getItem(DESC_HEARTBEAT) || '0', 10);
            if (lastHb > 0 && Date.now() - lastHb > DESC_WD_TIMEOUT) {
                dlog('watchdog: フリーズ検知 → リロードして復帰');
                location.reload();
            }
        }, 30000);
    }

    // __NEXT_DATA__ JSON を再帰探索して description フィールドを探す
    function _findDesc(obj, itemId, depth) {
        if (depth > 10 || !obj || typeof obj !== 'object') return null;
        // ID一致 + description あり → 確実にヒット
        if ((obj.id === itemId || obj.itemId === itemId) &&
            typeof obj.description === 'string' && obj.description.length > 10) {
            return obj.description;
        }
        // ID不問: description が十分長くURLでも空でもない → 候補
        if (typeof obj.description === 'string' && obj.description.length > 50 &&
            !obj.description.startsWith('http') && !/^[\w\s-]{1,30}$/.test(obj.description)) {
            return obj.description;
        }
        for (const k of Object.keys(obj)) {
            const v = obj[k];
            if (Array.isArray(v)) {
                for (const el of v) {
                    const r = _findDesc(el, itemId, depth + 1);
                    if (r) return r;
                }
            } else if (v && typeof v === 'object') {
                const r = _findDesc(v, itemId, depth + 1);
                if (r) return r;
            }
        }
        return null;
    }

    // HTML デコード（SSRパース用）
    function _decodeHtml(s) {
        return s.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
                .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
                .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
    }

    var _fetchDiag = true;

    // 同一オリジンのiframeで商品ページを読み込み、DOMから説明文を取得
    // fetchでは取れない（サーバーがナビゲーションリクエストにのみRSCデータを返すため）
    function fetchItemDesc(url) {
        const itemId = (url.match(/\/item\/(m[A-Za-z0-9]+)/) || [])[1] || '';
        dlog(`fetchItemDesc(iframe): ${itemId}`);
        return new Promise(resolve => {
            const iframe = document.createElement('iframe');
            iframe.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:390px;height:844px;border:none;visibility:hidden;pointer-events:none;';
            document.body.appendChild(iframe);

            let done = false;
            const finish = result => {
                if (done) return;
                done = true;
                try { iframe.remove(); } catch(_) {}
                resolve(result);
            };

            // 最大8秒でタイムアウト
            const hardTimer = setTimeout(() => { dlog(`iframe timeout: ${itemId}`); finish(null); }, 8000);

            iframe.onload = () => {
                let tries = 0;
                const poll = setInterval(() => {
                    try {
                        const doc = iframe.contentDocument;
                        if (!doc || !doc.body) return;

                        // 説明文DOMが現れたら取得
                        const el = doc.querySelector(DESC_SEL);
                        if (el && el.innerText && el.innerText.trim().length > 5) {
                            clearInterval(poll);
                            clearTimeout(hardTimer);
                            const desc = el.innerText.trim();
                            dlog(`iframe desc: ${desc.slice(0, 50)}`);
                            finish(desc);
                            return;
                        }

                        // エラーページ（商品削除）
                        const bodyText = doc.body.innerText || '';
                        if (bodyText.includes('このページは存在しません') || bodyText.includes('商品が見つかりません')) {
                            clearInterval(poll);
                            clearTimeout(hardTimer);
                            dlog(`iframe: 削除済み商品`);
                            finish(null);
                            return;
                        }
                    } catch(e) {
                        clearInterval(poll);
                        clearTimeout(hardTimer);
                        dlog(`iframe crossorigin: ${e.message}`);
                        finish(null);
                        return;
                    }
                    if (++tries > 40) { // 40 × 200ms = 8秒
                        clearInterval(poll);
                        clearTimeout(hardTimer);
                        dlog(`iframe: desc待機タイムアウト`);
                        finish(null);
                    }
                }, 200);
            };

            iframe.onerror = () => { clearTimeout(hardTimer); dlog(`iframe onerror`); finish(null); };
            iframe.src = url;
        });
    }

    async function processItemsWithFetch(noModelItems, isCrawlerMode, makerName) {
        _abortFetch = false;
        _diagLog    = [];
        _fetchDiag  = true;
        const total  = noModelItems.length;
        const prefix = makerName ? `[${makerName}] ` : '';
        dlog(`processItemsWithFetch開始: total=${total} maker=${makerName||'(none)'}`);

        const stopBtn = document.createElement('button');
        stopBtn.textContent = '中止';
        stopBtn.style.cssText = `
            position:fixed; bottom:80px; left:20px; z-index:99999;
            padding:8px 14px; background:#B71C1C; color:#fff;
            border:none; border-radius:6px; font-size:12px; cursor:pointer;
            box-shadow:0 2px 6px rgba(0,0,0,0.3);
        `;
        stopBtn.onclick = () => { _abortFetch = true; stopBtn.remove(); logBtn.remove(); };
        document.body.appendChild(stopBtn);

        const logBtn = document.createElement('button');
        logBtn.textContent = 'ログコピー';
        logBtn.style.cssText = `
            position:fixed; bottom:120px; left:20px; z-index:99999;
            padding:6px 12px; background:#333; color:#fff;
            border:none; border-radius:6px; font-size:11px; cursor:pointer;
            box-shadow:0 2px 6px rgba(0,0,0,0.3);
        `;
        logBtn.onclick = () => {
            navigator.clipboard.writeText(_diagLog.join('\n')).then(() => { logBtn.textContent = 'コピー済!'; });
        };
        document.body.appendChild(logBtn);

        let nullCount = 0;
        let makerHits = 0;
        let _batchStart = Date.now(); // 処理が長時間にわたって重くなっていないかを確認するための簡易計測（dlog修正の効果検証用）

        for (let i = 0; i < total; i++) {
            if (_abortFetch) break;

            const item = noModelItems[i];
            showStatus(`${prefix}[${i + 1}/${total}] 説明文フェッチ中...`);
            markProcessed(item.id);

            const desc = await fetchItemDesc(item.url);

            if (desc && _fetchDiag) {
                showStatus(`[診断OK] iframe取得成功:「${desc.slice(0, 40)}…」`, 'rgba(0,100,0,0.9)');
                await sleep(2000);
                _fetchDiag = false;
            } else if (!desc && _fetchDiag) {
                showStatus(`[診断] iframeで取得失敗（CSPブロックの可能性）`, '#b71c1c');
                await sleep(2000);
                _fetchDiag = false;
            }

            if (desc) {
                nullCount = 0;
                const models    = extractModelsFromDesc(desc);
                dlog(`models: ${JSON.stringify(models)}`);
                logExperiment({ maker: makerName || '', title: item.name, url: item.url, has_model_in_title: false, desc_fetched: true, desc, extracted: models.join(',') });
                const SET_WORDS = ['セット', 'まとめ', 'まとめ売', 'セット売', '個セット', '台セット', '点セット', '本セット'];
                const isBundle  = SET_WORDS.some(w => item.name.includes(w) || desc.includes(w));

                if (models.length > 0) {
                    const results = JSON.parse(localStorage.getItem(RESULT_KEY) || '[]');
                    models.forEach(model => {
                        // 【セット】タグはサーバー側(find_matches)が名前を見て一括付与するため、ここでは付けない（二重表示防止）
                        const label = `${item.name} ${model}`;
                        results.push({ name: label, model, price: item.price, url: item.url, image: item.image, desc_excerpt: extractExcerpt(desc, model) });
                    });
                    localStorage.setItem(RESULT_KEY, JSON.stringify(results));
                    const tag = isBundle ? '【セット】' : '';
                    makerHits++;
                    showStatus(`${prefix}[${i + 1}/${total}] ${tag}型番: ${models.join(', ')}（累計: ${results.length}件）`, 'rgba(20,110,0,0.88)');
                    dlog(`▶ ヒット [${i + 1}/${total}] ${makerName || ''}${makerName ? ' | ' : ''}${models.join(', ')} — 累計: ${results.length}件`);
                    if (results.length % SAVE_INTERVAL === 0) sendProgress(results.slice(-SAVE_INTERVAL), makerName);
                    await sleep(isCrawlerMode ? 500 : 2000); // クローラー時は短縮
                } else {
                    const cnt = JSON.parse(localStorage.getItem(RESULT_KEY) || '[]').length;
                    showStatus(`${prefix}[${i + 1}/${total}] 型番なし（累計: ${cnt}件）`);
                }
            } else {
                nullCount++;
                const cnt = JSON.parse(localStorage.getItem(RESULT_KEY) || '[]').length;
                showStatus(`${prefix}[${i + 1}/${total}] 説明文取得失敗（累計: ${cnt}件）`);
                logExperiment({ maker: makerName || '', title: item.name, url: item.url, has_model_in_title: false, desc_fetched: false, desc: '', extracted: '' });
            }

            await sleep(300);

            // 50件ごとに直近バッチの平均処理時間を記録（件数が増えても重くなっていないかの確認用）
            if ((i + 1) % 50 === 0) {
                const batchMs = Date.now() - _batchStart;
                dlog(`[計測] ${i + 1}件目まで処理 / 直近50件の平均: ${(batchMs / 50).toFixed(0)}ms/件`);
                _batchStart = Date.now();
                flushProcessed(); // 途中リロード・強制終了に備えて定期的に書き戻す
            }
        }

        flushProcessed(); // ページ遷移前に必ず書き戻す
        flushExperimentLog();
        stopBtn.remove();
        // logBtnは残す（クリックしていつでもコピー可能）
        logBtn.textContent = 'ログコピー✓';

        const totalSoFar = JSON.parse(localStorage.getItem(RESULT_KEY) || '[]').length;
        dlog(`◀ ${makerName || '(検索)'}完了: ${total}件処理 / ${makerHits}件ヒット / 累計: ${totalSoFar}件`);

        if (isCrawlerMode) {
            if (_abortFetch) localStorage.removeItem(CRAWLER_KEY); // 中止時はクローラー全体も停止
            finishMakerAndContinue();
        } else {
            finishAndSend(null);
        }
    }

    // ========================================================
    //  商品収集（Search API）
    // ========================================================
    async function fetchItems(tpl, maxPages = MAX_PAGES) {
        const allItems = {};

        // 日次運用：前回実行時刻（メーカー単位で記録）
        // brand_idがあればそれを、なければURL全体の簡易ハッシュを使う
        const _brandMatch = window.location.href.match(/brand_id=(\d+)/);
        const _urlHash    = window.location.href.split('').reduce((a, c) => (Math.imul(31, a) + c.charCodeAt(0)) | 0, 0);
        const runKey      = 'desc_last_run_' + (_brandMatch ? _brandMatch[1] : Math.abs(_urlHash).toString(36));
        const lastRunTime = parseInt(localStorage.getItem(runKey) || '0', 10);
        const isFirstRun  = lastRunTime === 0;

        let pageToken = '';

        for (let page = 0; page < maxPages; page++) {
            const bodyObj = JSON.parse(tpl.body);
            bodyObj.pageToken = pageToken;
            bodyObj.pageSize  = 120;

            const ctrl  = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 15000);
            let data;
            try {
                const res = await fetch(tpl.url, {
                    method:      tpl.method,
                    headers:     tpl.headers,
                    credentials: 'include',
                    body:        JSON.stringify(bodyObj),
                    signal:      ctrl.signal,
                });
                clearTimeout(timer);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                data = await res.json();
            } catch(e) {
                clearTimeout(timer);
                throw e;
            }

            const pageItems = (data.items || []).filter(item => {
                const id = item.id || item.itemId;
                return id && item.name && item.price != null && !(item.auction && item.auction.bidDeadline);
            });

            let newCount = 0;
            pageItems.forEach(item => {
                const id        = item.id || item.itemId;
                const createdAt = parseInt(item.created || '0', 10);
                // 2回目以降：前回実行より古い出品はスキップ
                if (!isFirstRun && createdAt <= lastRunTime) return;
                newCount++;
                allItems[id] = {
                    id,
                    name:  item.name,
                    price: String(item.price),
                    url:   `https://jp.mercari.com/item/${id}`,
                    image: (item.thumbnails && item.thumbnails[0]) || '',
                };
            });

            // このページに前回以降の新着がゼロ → 以降のページも不要
            if (!isFirstRun && pageItems.length > 0 && newCount === 0) {
                showStatus(`前回実行以降の新着なし（${page + 1}ページで収集終了）`);
                break;
            }

            const nextToken = (data.meta && data.meta.nextPageToken) || data.nextPageToken || '';
            if (!nextToken || pageItems.length === 0) break;
            pageToken = nextToken;
            await sleep(300);
        }

        // 収集完了：1件以上収集できた場合のみ今回の実行時刻を保存（次回のカットオフになる）
        if (Object.keys(allItems).length > 0) {
            localStorage.setItem(runKey, Math.floor(Date.now() / 1000));
        }

        return allItems;
    }

    // ========================================================
    //  結果パネル表示
    // ========================================================
    function showResults(matches) {
        hideStatus();

        if (matches.length === 0) {
            showStatus('照合完了 — ヒットなし', 'rgba(100,80,0,0.88)');
            setTimeout(hideStatus, 6000);
            return;
        }

        const old = document.getElementById('desc-model-panel');
        if (old) old.remove();

        const panel = document.createElement('div');
        panel.id = 'desc-model-panel';
        panel.style.cssText = `
            position:fixed; top:20px; right:20px; z-index:99998;
            background:#fff; border:2px solid #C49A00; border-radius:10px;
            padding:16px; width:420px; max-height:80vh; overflow-y:auto;
            box-shadow:0 4px 20px rgba(0,0,0,0.25); font-size:13px; font-family:sans-serif;
        `;

        const header = document.createElement('div');
        header.style.cssText = 'font-weight:bold; font-size:16px; margin-bottom:12px; color:#C49A00;';
        header.textContent = `★ 仕入れ候補（説明文型番） ${matches.length}件`;
        panel.appendChild(header);

        matches.forEach(m => {
            const row = document.createElement('div');
            row.style.cssText = 'border-top:1px solid #eee; padding:10px 0;';
            row.innerHTML = `
                <div style="font-weight:bold;color:#222;margin-bottom:3px;">${m.model}</div>
                <div style="color:#888;font-size:11px;margin-bottom:4px;">${(m.name||'').slice(0,65)}</div>
                <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
                    <span style="color:#f44336;font-weight:bold;font-size:15px;">¥${Number(m.mercari_price).toLocaleString()}</span>
                    <span style="color:#999;">→ Amazon ¥${m.amazon_price?Number(m.amazon_price).toLocaleString():'?'}</span>
                    <span style="color:#4CAF50;font-weight:bold;">pmax ¥${Number(m.pmax).toLocaleString()}</span>
                </div>
                <div style="color:#C49A00;font-size:12px;margin-top:3px;">
                    差益 ¥${Number(m.diff).toLocaleString()} ／ ASIN: ${m.asin}
                </div>
                <a href="${m.mercari_url}" target="_blank" style="color:#FF6600;font-size:11px;">メルカリで見る →</a>
            `;
            panel.appendChild(row);
        });

        const closeBtn = document.createElement('button');
        closeBtn.textContent = '閉じる';
        closeBtn.style.cssText = `
            margin-top:12px; padding:8px; width:100%;
            background:#f0f0f0; border:none; border-radius:6px; cursor:pointer; font-size:13px;
        `;
        closeBtn.onclick = () => panel.remove();
        panel.appendChild(closeBtn);
        document.body.appendChild(panel);

        showStatus(`照合完了 — ${matches.length}件ヒット！`, 'rgba(0,100,0,0.88)');
    }

})();
