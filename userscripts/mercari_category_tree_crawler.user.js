// ==UserScript==
// @name         Mercari Category Tree Crawler
// @namespace    http://tampermonkey.net/
// @version      1.8
// @description  メルカリの全カテゴリを自動巡回し、階層構造（id/name/parent）を収集する（型番収集のカテゴリ拡張検討用・2026-09-06新設・loadイベント消失バグ修正・固定待機を安定化ポーリングに変更して0件誤判定を解消・2026-09-07：同一タブでの長時間連続遷移によるChromeメモリ蓄積とみられる子数の誤検出を受け、100件ごとにタブ再起動を促すチェックポイントを追加・安定判定を件数のみからID一覧の中身比較に強化しポーリング開始前に最低600ms待つよう修正・0件で安定した場合のみ確認時間を3倍に伸ばして描画未開始との誤判定を防止・さらに下層を持たない末端の子カテゴリが/search?category_id=形式でリンクされているため取りこぼされていたバグを修正（「すべて」リンクとはテキストで判別して除外）・巡回中も常に停止・リセットボタンを表示するよう改善・2600件規模だと再開ボタンを26回押す手間になるとの指摘を受け、専用URL(?resume_catcrawl=1)を開いた時だけ5秒後に自動継続するよう変更・無関係なメルカリ閲覧タブで巡回対象ページと誤認して処理してしまう事故を防ぐため対象ページのURL一致確認を追加）
// @match        https://jp.mercari.com/*
// @grant        none
// @updateURL    https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/mercari_category_tree_crawler.user.js
// @downloadURL  https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/mercari_category_tree_crawler.user.js
// ==/UserScript==

(function () {
    'use strict';

    // カテゴリページはNext.jsのクライアントサイド描画のため、素のfetchでは
    // 子カテゴリのリンクが取得できない（確認済み）。実際にページを開いて
    // DOMが描画されるのを待ってからリンクを読む必要がある。

    const QUEUE_KEY    = 'catcrawl_queue';    // 未訪問キュー: [{id, name, parent}]
    const VISITED_KEY  = 'catcrawl_visited';  // 訪問済みID配列
    const RESULT_KEY   = 'catcrawl_result';   // 収集結果: [{id, name, parent, children_count}]
    const RUNNING_KEY  = 'catcrawl_running';
    const CURRENT_KEY  = 'catcrawl_current';
    const PAUSED_KEY   = 'catcrawl_checkpoint_paused'; // チェックポイントで一時停止中フラグ
    const NAV_DELAY_MS = 800;   // 次のページへ遷移する前の待機（サーバー負荷軽減）
    // 2026-09-07追加：同じタブで何百ページも連続でフル遷移し続けると、Chrome側の
    // キャッシュ・コンパイル済みJS等が閉じるまで積み上がり、後半になるほど描画が
    // 遅くなって waitForStableChildren() の安定判定が誤動作しやすくなる事故が発生
    // （「子の数が取れたり取れなかったり」「動作が鈍くなってきた」とユーザーが発見）。
    // 一定件数ごとに一旦自動停止し、タブを閉じて開き直してから再開してもらう
    // チェックポイントを設ける（発掘リサーチの「100件ごとの予防的リロード」と同じ考え方）。
    const CHECKPOINT_INTERVAL = 100;
    // 2026-09-06修正：固定2.2秒待ってから読み取る方式だと、描画が遅いページで
    // 子カテゴリが表示される前に読み取ってしまい「子0件」と誤判定する事故が発生した
    // （画面には複数の子カテゴリが見えているのに収集結果は0件、とユーザーが発見）。
    // 固定時間ではなく「リンクの件数が数回連続で変化しなくなるまで」ポーリングする方式に変更。
    const POLL_INTERVAL_MS      = 300;
    const STABLE_TICKS_REQUIRED = 4;    // 1200ms間、変化しなければ安定とみなす
    const MAX_WAIT_MS           = 8000; // 安定しなくてもこれ以上は待たない安全策
    // 2026-09-07追加：「件数」だけを見て安定判定していたため、Next.jsが一時的な
    // スケルトン表示等で偶然同じ件数（中身は違う）を挟んだ場合に誤って安定と判定
    // していた可能性がある（ユーザーが「遷移が早すぎる気がする」と気づいて発覚）。
    // ページ読み込み直後は最低限このミリ秒だけ待ってからポーリングを始める。
    const INITIAL_DELAY_MS      = 600;

    // 2026-09-06：手動でトップページを開いて確認済みの22件（全カテゴリの最上位）
    const ROOT_CATEGORIES = [
        { id: '3088', name: 'ファッション' },
        { id: '3',    name: 'ベビー・キッズ' },
        { id: '1328', name: 'ゲーム・おもちゃ・グッズ' },
        { id: '6386', name: 'ホビー・楽器・アート' },
        { id: '1027', name: 'チケット' },
        { id: '5',    name: '本・雑誌・漫画' },
        { id: '9879', name: 'CD・DVD・ブルーレイ' },
        { id: '7',    name: 'スマホ・タブレット・パソコン' },
        { id: '3888', name: 'テレビ・オーディオ・カメラ' },
        { id: '4136', name: '生活家電・空調' },
        { id: '8',    name: 'スポーツ' },
        { id: '2634', name: 'アウトドア・釣り・旅行用品' },
        { id: '6',    name: 'コスメ・美容' },
        { id: '3134', name: 'ダイエット・健康' },
        { id: '1844', name: '食品・飲料・酒' },
        { id: '113',  name: 'キッチン・日用品・その他' },
        { id: '4',    name: '家具・インテリア' },
        { id: '69',   name: 'ペット用品' },
        { id: '5597', name: 'DIY・工具' },
        { id: '1206', name: 'フラワー・ガーデニング' },
        { id: '9',    name: 'ハンドメイド・手芸' },
        { id: '1318', name: '車・バイク・自転車' },
    ];

    function getQueue()    { try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch (e) { return []; } }
    function setQueue(q)   { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); }
    function getVisited()  { try { return new Set(JSON.parse(localStorage.getItem(VISITED_KEY) || '[]')); } catch (e) { return new Set(); } }
    function setVisited(s) { localStorage.setItem(VISITED_KEY, JSON.stringify([...s])); }
    function getResult()   { try { return JSON.parse(localStorage.getItem(RESULT_KEY) || '[]'); } catch (e) { return []; } }
    function setResult(r)  { localStorage.setItem(RESULT_KEY, JSON.stringify(r)); }

    function extractCatId(href) {
        const m = (href || '').match(/category_id=(\d+)/);
        return m ? m[1] : null;
    }

    // 2026-09-07修正：さらに下の階層を持つ子カテゴリは/categories?category_id=に
    // リンクするが、末端（それ以上下が無い）の子カテゴリは/search?category_id=に
    // 直接リンクしていると判明（画面には子が見えるのに末端側だけ取りこぼす事故で発覚）。
    // 「すべて」という各階層共通の全件表示リンクも同じ/search?category_id=形式のため、
    // これはテキストで判別して除外する。
    function extractChildren() {
        const links = [...document.querySelectorAll('a[href*="category_id="]')];
        const seen = new Set();
        const out = [];
        for (const a of links) {
            const href = a.getAttribute('href') || '';
            if (!href.includes('/categories?category_id=') && !href.includes('/search?category_id=')) continue;
            const id = extractCatId(href);
            const text = a.textContent.trim();
            if (!id || !text || text === 'すべて' || seen.has(id)) continue;
            seen.add(id);
            out.push({ id, name: text });
        }
        return out;
    }

    function showStatus(msg, showCopyButton) {
        let el = document.getElementById('catcrawl-status');
        if (!el) {
            el = document.createElement('div');
            el.id = 'catcrawl-status';
            // 2026-09-06：右下(クローラーコレクト)・左下(共有スタック)は他スクリプトが
            // 使用中で位置がかぶるため、空いている右上に配置する
            el.style.cssText = [
                'position:fixed', 'top:20px', 'right:20px', 'z-index:2147483647',
                'background:#1b2733', 'color:#fff', 'padding:12px 16px', 'border-radius:10px',
                'font-size:13px', 'box-shadow:0 4px 16px rgba(0,0,0,.5)', 'max-width:280px',
                'line-height:1.5',
            ].join(';');
            document.body.appendChild(el);
        }
        el.textContent = msg;
        if (showCopyButton) {
            const btn = document.createElement('button');
            btn.textContent = '📋 結果をコピー';
            btn.style.cssText = [
                'display:block', 'margin-top:8px', 'padding:7px 14px', 'width:100%',
                'background:#2e7d32', 'color:#fff', 'border:none', 'border-radius:6px',
                'cursor:pointer', 'font-weight:bold', 'font-size:12px',
            ].join(';');
            btn.onclick = () => {
                navigator.clipboard.writeText(JSON.stringify(getResult(), null, 2))
                    .then(() => { btn.textContent = '✅ コピーしました'; })
                    .catch(() => { btn.textContent = '⚠ コピー失敗'; });
            };
            el.appendChild(btn);
        }
        // 2026-09-07追加：以前は巡回中の通常メッセージには停止ボタンが一切無く、
        // 今すぐ止めたい時にコンソールでlocalStorageを手動削除する必要があった
        // （ユーザーから「リセットボタンとかないの」との指摘を受け改善）。
        // 巡回中・完了時を問わず常にこのボタンを出しておく。
        appendStopButton(el);
    }

    function appendStopButton(el) {
        const stopBtn = document.createElement('button');
        stopBtn.textContent = '停止・リセット';
        stopBtn.style.cssText = [
            'display:block', 'margin-top:6px', 'padding:6px 14px', 'width:100%',
            'background:#616161', 'color:#fff', 'border:none', 'border-radius:6px',
            'cursor:pointer', 'font-size:11px',
        ].join(';');
        stopBtn.onclick = resetAll;
        el.appendChild(stopBtn);
    }

    function resetAll() {
        localStorage.removeItem(QUEUE_KEY);
        localStorage.removeItem(VISITED_KEY);
        localStorage.removeItem(RESULT_KEY);
        localStorage.removeItem(RUNNING_KEY);
        localStorage.removeItem(CURRENT_KEY);
        localStorage.removeItem(PAUSED_KEY);
        const el = document.getElementById('catcrawl-status');
        if (el) el.remove();
        addStartButton();
    }

    // CHECKPOINT_INTERVAL件処理するごとに自動停止し、タブを閉じて開き直す
    // （＝Chromeのレンダラーごとメモリを解放する）ことを促す。
    // 2026-09-07追加：2,600件規模だと26回も手動でボタンを押す必要があり手間との
    // 指摘を受け、autoResume=trueの場合（＝タブを開き直した直後の検知）は5秒後に
    // 自動で再開するようにした。止めたい場合はその5秒の間に「停止・リセット」を
    // 押せばよい。初回にこのチェックポイントへ到達した瞬間（＝まだ古いタブのまま）
    // だけはautoResume=falseにし、実際にタブを閉じて開き直す猶予を必ず与える。
    function showCheckpointPrompt(resultCount, queueCount, autoResume) {
        showStatus(`⏸ チェックポイント：${resultCount}件処理\n残りキュー${queueCount}件\n\nメモリ解放のため、一度タブを閉じて開き直してください。`);
        const el = document.getElementById('catcrawl-status');

        const resumeBtn = document.createElement('button');
        resumeBtn.style.cssText = [
            'display:block', 'margin-top:8px', 'padding:7px 14px', 'width:100%',
            'background:#1565c0', 'color:#fff', 'border:none', 'border-radius:6px',
            'cursor:pointer', 'font-weight:bold', 'font-size:12px',
        ].join(';');
        const doResume = () => {
            localStorage.removeItem(PAUSED_KEY);
            goNext();
        };
        resumeBtn.onclick = doResume;
        // showStatus()が既に末尾に「停止・リセット」ボタンを追加済みなので、
        // その手前に再開ボタンを挿入する
        el.insertBefore(resumeBtn, el.querySelector('button'));

        if (!autoResume) {
            resumeBtn.textContent = '続きから再開';
            return;
        }

        let secondsLeft = 5;
        resumeBtn.textContent = `続きから再開（自動継続まであと${secondsLeft}秒）`;
        const timer = setInterval(() => {
            secondsLeft--;
            if (localStorage.getItem(PAUSED_KEY) !== 'true') { clearInterval(timer); return; } // 既に停止・リセット等で状態が変わっていたら中止
            if (secondsLeft <= 0) {
                clearInterval(timer);
                doResume();
                return;
            }
            resumeBtn.textContent = `続きから再開（自動継続まであと${secondsLeft}秒）`;
        }, 1000);
    }

    function startCrawl() {
        setQueue(ROOT_CATEGORIES.map(c => ({ id: c.id, name: c.name, parent: '' })));
        setVisited(new Set());
        setResult([]);
        localStorage.setItem(RUNNING_KEY, 'true');
        const btn = document.getElementById('catcrawl-start-btn');
        if (btn) btn.remove();
        goNext();
    }

    function goNext() {
        const queue = getQueue();
        const visited = getVisited();

        // 訪問済み・重複はスキップ
        while (queue.length > 0 && visited.has(queue[0].id)) {
            queue.shift();
        }
        if (queue.length === 0) {
            finish();
            return;
        }
        const next = queue.shift();
        setQueue(queue);
        visited.add(next.id);
        setVisited(visited);
        localStorage.setItem(CURRENT_KEY, JSON.stringify(next));
        location.href = `https://jp.mercari.com/categories?category_id=${next.id}`;
    }

    // 子リンクの「中身」がSTABLE_TICKS_REQUIRED回連続で変化しなくなるまでポーリング
    // してからcallbackに渡す（描画完了前に0件と誤判定するのを防ぐ）。
    // 2026-09-07修正：以前は「件数」だけを比較していたため、Next.jsの一時的な
    // スケルトン表示等で中身が入れ替わる過渡期に、たまたま件数が同じ回が連続すると
    // 誤って安定と判定してしまう恐れがあった。ID一覧（ソート済み）を比較するように
    // 変更し、中身そのものが変わっていないことを確認するようにした。
    function waitForStableChildren(callback) {
        setTimeout(() => {
            let lastSignature = null;
            let stableTicks = 0;
            let elapsed = INITIAL_DELAY_MS;
            const timer = setInterval(() => {
                const children = extractChildren();
                const signature = children.map(c => c.id).sort().join(',');
                elapsed += POLL_INTERVAL_MS;
                if (signature === lastSignature) {
                    stableTicks++;
                } else {
                    stableTicks = 0;
                    lastSignature = signature;
                }
                // 2026-09-07追加：0件のまま安定した場合、「本当に子が無い」のか
                // 「まだ描画が始まっていないだけ」なのかを件数だけでは区別できない。
                // ページ読み込みが遅い時にこれを誤って0件確定してしまう事故が実際に
                // 起きたため、0件のときだけ通常の3倍の安定確認時間を要求する。
                const requiredTicks = children.length === 0 ? STABLE_TICKS_REQUIRED * 3 : STABLE_TICKS_REQUIRED;
                if (stableTicks >= requiredTicks || elapsed >= MAX_WAIT_MS) {
                    clearInterval(timer);
                    callback(children);
                }
            }, POLL_INTERVAL_MS);
        }, INITIAL_DELAY_MS);
    }

    function processCurrentPage() {
        const currentStr = localStorage.getItem(CURRENT_KEY);
        if (!currentStr) return;
        const current = JSON.parse(currentStr);
        // 2026-09-07追加：巡回中の別タブでメルカリの無関係なページ（検索・トップページ等）
        // を開いた場合、そちらのタブでも@matchによりこのスクリプトが実行され、
        // current_keyが残っていると誤って「今見ているページ」を巡回対象として処理して
        // しまう事故があり得た。このページ自体が本当にcurrent.idのカテゴリページかを
        // URLで確認し、一致しない場合は何もしない（current_keyは消さず、本来の巡回タブ
        // 側で正しく処理されるのを妨げないようにする）。
        if (new URLSearchParams(location.search).get('category_id') !== current.id) return;
        localStorage.removeItem(CURRENT_KEY);

        waitForStableChildren((rawChildren) => {
            const children = rawChildren.filter(c => c.id !== current.id);
            const result = getResult();
            result.push({ id: current.id, name: current.name, parent: current.parent, children_count: children.length });
            setResult(result);

            const queue = getQueue();
            const visited = getVisited();
            const queuedIds = new Set(queue.map(q => q.id));
            for (const child of children) {
                if (!visited.has(child.id) && !queuedIds.has(child.id)) {
                    queue.push({ id: child.id, name: child.name, parent: current.id });
                    queuedIds.add(child.id);
                }
            }
            setQueue(queue);

            if (result.length % CHECKPOINT_INTERVAL === 0) {
                localStorage.setItem(PAUSED_KEY, 'true');
                showCheckpointPrompt(result.length, queue.length);
                return;
            }

            showStatus(`巡回中... 収集済${result.length}件 / 残りキュー${queue.length}件\n直前: ${current.name}（子${children.length}件）`);
            setTimeout(goNext, NAV_DELAY_MS);
        });
    }

    function finish() {
        localStorage.setItem(RUNNING_KEY, 'false');
        const result = getResult();
        showStatus(`✅ 完了！ 全${result.length}カテゴリを収集しました`, true);
    }

    function addStartButton() {
        if (document.getElementById('catcrawl-start-btn')) return;
        const btn = document.createElement('button');
        btn.id = 'catcrawl-start-btn';
        btn.textContent = '🗂️ カテゴリ全収集 開始';
        btn.style.cssText = [
            'position:fixed', 'top:20px', 'right:20px', 'z-index:2147483647',
            'padding:10px 16px', 'background:#1565c0', 'color:#fff', 'border:none',
            'border-radius:10px', 'cursor:pointer', 'font-weight:bold', 'font-size:13px',
            'box-shadow:0 4px 16px rgba(0,0,0,.5)',
        ].join(';');
        btn.onclick = startCrawl;
        document.body.appendChild(btn);
    }

    function onPageReady() {
        // 2026-09-07修正：以前は「一時停止中に何らかのjp.mercari.comページを開いた
        // だけ」で自動継続や自動遷移が発火してしまい、巡回と無関係にメルカリを見て
        // いるだけで勝手にページが切り替わる恐れがあった（ユーザー指摘で発覚）。
        // 明示的に ?resume_catcrawl=1 を付けて開いた時だけ自動継続し、それ以外は
        // 必ずボタンを押すまで何もしないようにする。
        const explicitResume = new URLSearchParams(location.search).get('resume_catcrawl') === '1';

        // processCurrentPage()内でwaitForStableChildren()が描画完了を確認してから
        // 読み取るので、ここで固定時間待つ必要はない
        if (localStorage.getItem(RUNNING_KEY) === 'true' && localStorage.getItem(PAUSED_KEY) === 'true') {
            showCheckpointPrompt(getResult().length, getQueue().length, explicitResume);
        } else if (localStorage.getItem(RUNNING_KEY) === 'true' && localStorage.getItem(CURRENT_KEY)) {
            // このページ自体が、巡回が次に進もうとしていたまさにそのカテゴリページ
            // （current_key）と一致する場合のみ処理を続ける。無関係な閲覧では発火しない。
            processCurrentPage();
        } else if (localStorage.getItem(RUNNING_KEY) === 'true') {
            // current_keyが無い状態で再開（途中でタブを閉じた等）。
            // 明示的な再開URLでなければボタン待ちにする（無関係な閲覧で勝手に進まないように）。
            localStorage.setItem(PAUSED_KEY, 'true');
            showCheckpointPrompt(getResult().length, getQueue().length, explicitResume);
        } else {
            addStartButton();
        }
    }

    // 2026-09-06修正：window.addEventListener('load', ...)だけだと、Tampermonkeyの
    // スクリプト注入がページのload完了より遅れた場合（loadイベントが既に発火済み）に
    // 二度と呼ばれず、次のページへ進めなくなって止まって見えるバグがあった
    // （実際にresultLen=67・queueLen=305・current残留のまま停止する事故で発覚）。
    // document.readyStateを確認し、既に読み込み済みなら即座に処理する。
    if (document.readyState === 'complete') {
        onPageReady();
    } else {
        window.addEventListener('load', onPageReady);
    }
})();
