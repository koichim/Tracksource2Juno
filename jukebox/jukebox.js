/* --- 設定エリア --- */
const CLIENT_ID = '584975721862-ce0db6ved3d295vbeb88k3titfcq5h6n.apps.googleusercontent.com';
const SCOPES = 'https://www.googleapis.com/auth/drive.readonly';


let tokenClient, gapiInited = false, gisInited = false;
let currentPlaylist = [], currentTrackIndex = -1, currentYearName = "";
let currentBlobUrl = null, isLoadingTrack = false;
let nextTrackIndex = -1;
let nextBlobUrl = null;
let nextCoverUrl = null;
let isPrefetching = false;
let isShuffleOn = false;
let isRepeatOn = false;
let playGeneration = 0; // 世代管理：古い再生予約をキャンセルするため
const APP_VERSION = "v44.0"; // プロダクション用バージョン
let currentPlaylistDate = ""; // v23: 現在のリストの日付
let currentIsIncomplete = false; // v25: 現在のリストが未完成か
const REFLECTION_TIME_DAYS = 15; // v35: 15日間
const REFLECTION_TIME_MS = REFLECTION_TIME_DAYS * 24 * 60 * 60 * 1000;
let currentIsNewPlaylist = false; // v42: 現在のプレイリストが「新着」か
let currentNewMp3s = new Set();    // v42: 🆙プレイリスト内で新しく追加された曲のセット

/**
 * プレイリストの表示用ラベルを生成する（アイコン付与）
 */
function formatPlaylistLabel(baseLabel, isNew, isUpdated, isIncomplete) {
    // 既存のアイコン（先頭の🆕, 🆙や末尾の🚧）を徹底的に除去
    let label = baseLabel.replace(/^[🆕🆙\s]+/, "").replace(/[\s🚧]+$/, "");
    if (isNew) {
        label = "🆕 " + label;
    }
    if (isUpdated) {
        label = "🆙 " + label;
    }
    if (isIncomplete) {
        label += " 🚧";
    }
    return label;
}

// v19: IndexedDB によるキャッシュ管理
const JukeboxDB = {
    dbName: 'jukebox_cache_db',
    dbVersion: 1,
    db: null,
    async open() {
        if (this.db) return this.db;
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('playlists')) {
                    db.createObjectStore('playlists', { keyPath: 'fileId' });
                }
            };
            // v19: 既存DBがある場合のマイグレーション（objectStoreがない場合）
            request.onerror = () => reject("IndexedDB open error");
            request.onsuccess = (e) => {
                this.db = e.target.result;
                // 万が一Upgradeが走らなかった場合のために手動チェック
                if (!this.db.objectStoreNames.contains('playlists')) {
                    this.db.close();
                    const req2 = indexedDB.open(this.dbName, ++this.dbVersion);
                    req2.onupgradeneeded = (ev) => ev.target.result.createObjectStore('playlists', { keyPath: 'fileId' });
                    req2.onsuccess = (ev) => { this.db = ev.target.result; resolve(this.db); };
                } else {
                    resolve(this.db);
                }
            };
        });
    },
    async get(fileId) {
        const db = await this.open();
        return new Promise((resolve) => {
            const transaction = db.transaction(['playlists'], 'readonly');
            const request = transaction.objectStore('playlists').get(fileId);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => resolve(null);
        });
    },
    async set(fileId, data) {
        const db = await this.open();
        const existing = await this.get(fileId);
        const createdAt = (existing && existing.createdAt) ? existing.createdAt : Date.now();
        return new Promise((resolve) => {
            const transaction = db.transaction(['playlists'], 'readwrite');
            const request = transaction.objectStore('playlists').put({
                fileId,
                ...data,
                createdAt,
                updatedAt: (data.updatedAt || Date.now())
            });
            request.onerror = () => resolve();
        });
    },
    async clearAll() {
        const db = await this.open();
        return new Promise((resolve) => {
            const transaction = db.transaction(['playlists'], 'readwrite');
            const request = transaction.objectStore('playlists').clear();
            request.onsuccess = () => resolve();
            request.onerror = () => resolve();
        });
    }
};

// v18: 物理的に鳴っているオーディオ要素を確実に特定するヘルパー
const getRealAudio = () => {
    let audio = document.getElementById('jukebox-audio');
    if (typeof Amplitude !== 'undefined' && Amplitude.getAudio) {
        const ampAudio = Amplitude.getAudio();
        if (ampAudio && ampAudio.src) audio = ampAudio;
    }
    // それでもソースがない場合は、ページ内の audio を全検索
    if (!audio || !audio.src) {
        const allAudios = document.querySelectorAll('audio');
        for (let a of allAudios) {
            if (a.src && a.src.length > 10) {
                audio = a;
                break;
            }
        }
    }
    return audio;
};

// --- グローバル同期 (v12.0: どんなエラーがあっても止まらないように最上部で定義) ---
const syncUI = () => {
    try {
        const audio = getRealAudio();

        const debugEl = document.getElementById('debug-info');
        const playPauseBtn = document.getElementById('play-pause');
        if (!playPauseBtn) return;

        let actualPaused = true;
        let stalled = false;
        let readyState = 'N/A';
        let networkState = 'N/A';
        let errorCode = 'None';

        if (audio) {
            actualPaused = audio.paused;
            readyState = audio.readyState;
            networkState = audio.networkState;
            if (audio.error) errorCode = audio.error.code;
            if (readyState < 2 && !audio.paused) stalled = true;
        }

        const ampState = (typeof Amplitude !== 'undefined' && Amplitude.getPlayerState) ? Amplitude.getPlayerState() : 'unknown';
        if (debugEl) {
            // v34: 安定したためデバッグ表示をクリア
            debugEl.innerText = "";
        }

        const state = actualPaused ? 'paused' : 'playing';

        // 1. ボタンの状態同期 (属性とクラス)
        if (playPauseBtn.getAttribute('amplitude-player-state') !== state) playPauseBtn.setAttribute('amplitude-player-state', state);
        if (actualPaused) {
            playPauseBtn.classList.remove('amplitude-playing');
            playPauseBtn.setAttribute('data-state', 'paused');
        } else {
            playPauseBtn.classList.add('amplitude-playing');
            playPauseBtn.setAttribute('data-state', 'playing');
        }

        // 2. アイコンの物理的制御 (data-state に基づいた CSS で動かない場合の最終手段として直接 style を叩く)
        const playIcon = playPauseBtn.querySelector('.play-icon');
        const pauseIcon = playPauseBtn.querySelector('.pause-icon');
        if (playIcon && pauseIcon) {
            if (actualPaused) {
                playIcon.style.setProperty('display', 'block', 'important');
                pauseIcon.style.setProperty('display', 'none', 'important');
            } else {
                playIcon.style.setProperty('display', 'none', 'important');
                pauseIcon.style.setProperty('display', 'block', 'important');
            }
        }

        // 3. プレイリストのハイライト同期 (v16: インデックスではなく ID 指定で確実に。重い処理なので index 変更時のみでも良いが、確実性重視)
        const selector = '#track_list li.playing';
        const highlighted = document.querySelectorAll(selector);
        highlighted.forEach(el => {
            if (el.id !== `track-${currentTrackIndex}`) el.classList.remove('playing');
        });

        if (currentTrackIndex !== -1) {
            const activeLi = document.getElementById(`track-${currentTrackIndex}`);
            if (activeLi && !activeLi.classList.contains('playing')) {
                activeLi.classList.add('playing');
            }
        }

        // 4. ロック画面同期
        if ('mediaSession' in navigator) {
            const currentMedState = navigator.mediaSession.playbackState;
            const targetState = (stalled) ? currentMedState : (actualPaused ? 'paused' : 'playing');
            if (currentMedState !== targetState && (targetState === 'playing' || targetState === 'paused' || targetState === 'none')) {
                navigator.mediaSession.playbackState = targetState;
            }
        }

        const verEl = document.getElementById('app-version');
        if (verEl && verEl.innerText !== APP_VERSION) verEl.innerText = APP_VERSION;
    } catch (err) {
        console.error("syncUI Error:", err);
    }
};

// スクリプト読み込み直後から開始
setInterval(syncUI, 200);
document.addEventListener('visibilitychange', syncUI);
window.addEventListener('focus', syncUI);

const authBtn = document.getElementById('auth_btn');
const selector = document.getElementById('playlist_selector');
const customSelectContainer = document.getElementById('custom_select_container');
const playlistSearch = document.getElementById('playlist_search');
const customPlaylistList = document.getElementById('custom_playlist_list');
const trackList = document.getElementById('track_list');

// v17: ボタンのクリックを直接制御 (ライブラリの自動制御を無効化するため)
const playPauseBtn = document.getElementById('play-pause');
if (playPauseBtn) {
    playPauseBtn.onclick = () => {
        const audio = getRealAudio();
        if (audio) {
            if (audio.paused) {
                Amplitude.play();
            } else {
                Amplitude.pause();
            }
        } else {
            Amplitude.playPause();
        }
    };
}

// jukebox.js 側の togglePlaylistView は index.html 側と重複するため、
// 共通のグローバル関数として定義を一貫させます。
window.togglePlaylistView = function () {
    console.log("Toggle Clicked (from jukebox.js)!");
    const player = document.getElementById('flat-black-player');
    const list = document.getElementById('track_list');
    const text = document.getElementById('playlist-status-text');
    const arrow = document.getElementById('playlist-arrow');

    if (!player || !list) return;

    const isOpen = player.classList.toggle('playlist-open');
    list.style.display = isOpen ? 'block' : 'none';

    if (text) {
        text.innerText = isOpen ? "CLOSE TRACK LIST" : "SHOW TRACK LIST";
    }
    if (arrow) {
        arrow.style.transform = isOpen ? "rotate(180deg)" : "rotate(0deg)";
    }
};

function updateStatus(msg) {
    console.log("Jukebox Status:", msg);
    const statusElement = document.getElementById('status');
    if (statusElement) statusElement.innerText = msg;
}

// 1. 初期化
async function initApp() {
    updateStatus("Initializing Libraries...");

    // jsmediatags の読み込み待機
    let retry = 0;
    while (retry < 50) {
        if (window.jsmediatags) break;
        await new Promise(r => setTimeout(r, 100));
        retry++;
    }

    if (window.jsmediatags) {
        updateStatus("Libraries Ready");
    } else {
        updateStatus("Error: jsmediatags not found");
        return;
    }

    if (typeof Amplitude !== 'undefined') {
        Amplitude.init({
            audio_element: document.getElementById('jukebox-audio'), // 明示的なオーディオ要素をバインド
            songs: [],
            continue_next: false, // Amplitude独自の自動遷移をオフにする（重要）
            callbacks: {
                // 再生・一時停止の状態が変わるたびに呼び出される
                play_pause_cache: function () {
                    const state = Amplitude.getPlayerState(); // 'playing' または 'paused'
                    const el = document.getElementById('play-pause');
                    if (el) {
                        // HTML要素の属性を更新。これによりCSSの [amplitude-player-state="playing"] が効くようになる
                        el.setAttribute('amplitude-player-state', state);
                        console.log("Player state changed to:", state);
                    }
                },
                song_ended: function () {
                    console.log("Amplitude Callback: Song ended. Moving to next...");
                    playNextTrack();
                }
            }
        });
    }

    try {
        await new Promise(r => gapi.load('client', r));
        await gapi.client.init({});
        await gapi.client.load('https://www.googleapis.com/discovery/v1/apis/drive/v3/rest');
        gapiInited = true;
    } catch (e) { console.error("GAPI Error", e); }

    tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID, scope: SCOPES,
        callback: async (resp) => {
            if (resp.access_token) {
                // トークンと有効期限を保存
                const now = new Date().getTime();
                const expiresAt = now + (resp.expires_in * 1000);
                localStorage.setItem('gdrive_token', JSON.stringify({
                    access_token: resp.access_token,
                    expires_at: expiresAt
                }));

                authBtn.style.display = 'none';
                if (customSelectContainer) customSelectContainer.style.display = 'block';
                await startDiscovery();
            }
        }
    });

    // 保存されたトークンがあるか確認
    const storedToken = localStorage.getItem('gdrive_token');
    if (storedToken) {
        const tokenData = JSON.parse(storedToken);
        const now = new Date().getTime();
        // 有効期限の5分前までを「有効」と見なす
        if (tokenData.access_token && tokenData.expires_at > now + 300000) {
            console.log("Using stored token");
            gapi.client.setToken({ access_token: tokenData.access_token });
            authBtn.style.display = 'none';
            if (customSelectContainer) customSelectContainer.style.display = 'block';
            await startDiscovery();
        }
    }
    document.getElementById('custom-next').onclick = () => {
        playNextTrack();
    };
    document.getElementById('custom-prev').onclick = () => {
        const prev = Math.max(0, currentTrackIndex - 1);
        playWithAmplitude(prev);
    };

    // シャッフルとリピートの状態（見た目）の切り替え
    document.getElementById('shuffle').onclick = function () {
        isShuffleOn = !isShuffleOn;
        if (isShuffleOn) {
            this.classList.add('amplitude-shuffle-on');
            this.style.opacity = "1";
        } else {
            this.classList.remove('amplitude-shuffle-on');
            this.style.opacity = "0.5";
        }
        clearPrefetch();
    };

    document.getElementById('repeat').onclick = function () {
        isRepeatOn = !isRepeatOn;
        if (isRepeatOn) {
            this.classList.add('amplitude-repeat-on');
            this.style.opacity = "1";
        } else {
            this.classList.remove('amplitude-repeat-on');
            this.style.opacity = "0.5";
        }
        clearPrefetch();
    };
    gisInited = true;
    if (gapiInited && gisInited) {
        authBtn.disabled = false;
        authBtn.innerText = "Google Drive Auth";
        updateStatus("Ready");
    }

    // initApp の最後、または window.onload 内に記述
    const playlistBar = document.getElementById('playlist-bar-toggle');
    const playerFrame = document.getElementById('flat-black-player');
    const statusText = document.getElementById('playlist-status-text');
    const trackListEl = document.getElementById('track_list'); // 直接リストも取得

    playlistBar.onclick = () => {
        // クラスを入れ替える
        const isOpen = playerFrame.classList.toggle('playlist-open');

        // 文字の更新
        statusText.innerText = isOpen ? "Close DJ Chart" : "Show DJ Chart";

        // CSSだけで効かない場合のために、直接 style も叩く（念のため）
        trackListEl.style.display = isOpen ? "block" : "none";

        console.log("Playlist Toggled:", isOpen);
    };

    const clearBtn = document.getElementById('clear-cache-btn');
    if (clearBtn) {
        clearBtn.onclick = async () => {
            if (confirm("全てのキャッシュを削除して再読み込みしますか？")) {
                await JukeboxDB.clearAll();
                location.reload();
            }
        };
    }
}

authBtn.onclick = () => tokenClient.requestAccessToken({ prompt: '' });

// 2. フォルダスキャン
async function startDiscovery() {
    const res = await gapi.client.drive.files.list({
        q: "name = 'music_backup' and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
        fields: 'files(id)'
    });
    if (res.result.files && res.result.files.length > 0) {
        await findYearFolders(res.result.files[0].id);
    }
}

async function findYearFolders(parentId) {
    const res = await gapi.client.drive.files.list({
        q: `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id, name)'
    });
    selector.innerHTML = '<option value="">Select DJ Chart...</option>';
    const yearFolders = res.result.files.filter(f => f.name.match(/^\d{4}$/) && parseInt(f.name) >= 2023);
    
    let allFavs = [];
    let allRegs = [];

    for (const f of yearFolders) {
        const items = await findTracksFolder(f.id, f.name);
        allFavs.push(...items.favs);
        allRegs.push(...items.regs);
    }

    // 名前（ファイル名）で逆順ソート（新しい順）
    allFavs.sort((a, b) => b.dataset.fileName.localeCompare(a.dataset.fileName));
    allRegs.sort((a, b) => b.dataset.fileName.localeCompare(a.dataset.fileName));

    selector.append(...allFavs, ...allRegs);
    updateStatus("DJ Charts Loaded.");
    
    // v45: カスタムセレクターを更新
    renderCustomPlaylistList();
    setupCustomSelectorEvents();
}

/**
 * カスタムプレリストリストを描画する
 */
function renderCustomPlaylistList() {
    if (!customPlaylistList) return;
    customPlaylistList.innerHTML = '';
    
    const options = Array.from(selector.options).filter(opt => opt.value !== "");
    options.forEach(opt => {
        const item = document.createElement('div');
        item.className = 'custom-playlist-item';
        item.innerText = opt.innerText;
        item.dataset.value = opt.value;
        
        // 元のセレクトボックスの選択状態を反映
        if (selector.value === opt.value) {
            item.classList.add('selected');
        }
        
        item.onclick = (e) => {
            e.stopPropagation();
            selector.value = opt.value;
            // dispatch change event to trigger selector.onchange
            selector.dispatchEvent(new Event('change'));
            
            // UI更新
            document.querySelectorAll('.custom-playlist-item').forEach(i => i.classList.remove('selected'));
            item.classList.add('selected');
            playlistSearch.value = opt.innerText; // 選択した名前を表示
            customPlaylistList.style.display = 'none';
        };
        customPlaylistList.appendChild(item);
    });
}

/**
 * カスタムセレクターのイベントを設定する
 */
function setupCustomSelectorEvents() {
    if (!playlistSearch || !customPlaylistList) return;

    // 入力時のフィルタリング
    playlistSearch.oninput = (e) => {
        const query = e.target.value.toLowerCase();
        const items = customPlaylistList.querySelectorAll('.custom-playlist-item');
        let hasVisible = false;
        
        items.forEach(item => {
            const text = item.innerText.toLowerCase();
            if (text.includes(query)) {
                item.style.display = 'block';
                hasVisible = true;
            } else {
                item.style.display = 'none';
            }
        });
        
        customPlaylistList.style.display = hasVisible ? 'block' : 'none';
    };

    // フォーカス時にリストを表示
    playlistSearch.onfocus = () => {
        if (customPlaylistList.innerHTML !== '') {
            customPlaylistList.style.display = 'block';
            // 入力中ならフィルタリング、空なら全表示
            const query = playlistSearch.value.toLowerCase();
            const items = customPlaylistList.querySelectorAll('.custom-playlist-item');
            items.forEach(item => {
                const text = item.innerText.toLowerCase();
                item.style.display = text.includes(query) ? 'block' : 'none';
            });
        }
    };

    // 外側をクリックした時に閉じる
    document.addEventListener('click', (e) => {
        if (customSelectContainer && !customSelectContainer.contains(e.target)) {
            customPlaylistList.style.display = 'none';
        }
    });

    // キーボードナビゲーション（任意だが、使い勝手のために追加）
    playlistSearch.onkeydown = (e) => {
        if (e.key === 'Escape') {
            customPlaylistList.style.display = 'none';
            playlistSearch.blur();
        }
    };
}

function updateCustomItemLabel(value, label) {
    if (!customPlaylistList) return;
    const items = customPlaylistList.querySelectorAll('.custom-playlist-item');
    items.forEach(item => {
        if (item.dataset.value === value) {
            item.innerText = label;
        }
    });
}

async function findTracksFolder(yearId, yearName) {
    const res = await gapi.client.drive.files.list({
        q: `'${yearId}' in parents and name = 'tracks' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id)'
    });
    
    // 返り値用の配列
    const results = { favs: [], regs: [] };

    for (const tf of res.result.files) {
        const jRes = await gapi.client.drive.files.list({
            q: `'${tf.id}' in parents and mimeType = 'application/json' and trashed = false`,
            fields: 'files(id, name)'
        });

        // プレイリストファイルを読み込んで、中身のメタデータで表示名を更新する
        const optionsToAdd = [];
        for (const file of jRes.result.files) {
            const opt = document.createElement('option');
            const valueObj = { id: file.id, year: yearName };
            opt.value = JSON.stringify(valueObj);
            // "XXXX favorites.json" パターンを検出して先頭表示用にマーク
            const isFavoritesFile = /^\d{4}\s+favorites\.json$/i.test(file.name);
            if (isFavoritesFile) opt.dataset.isFavorites = 'true';
            opt.dataset.fileName = file.name; // ソート用にファイル名を保存

            // v19: キャッシュがあれば即座に名前をセット
            const cached = await JukeboxDB.get(file.id);
            if (cached && cached.label) {
                const now = Date.now();
                const createdAt = cached.createdAt || now;
                const updatedAt = cached.updatedAt || 0;
                const isNew = (now - createdAt) < REFLECTION_TIME_MS;
                const isFavoritesFile = /favorites/i.test(file.name);
                
                let isUpdated = false;
                if (cached.isIncomplete || isFavoritesFile) {
                    if ((now - updatedAt) < REFLECTION_TIME_MS) {
                        isUpdated = true;
                    }
                }

                let displayLabel = formatPlaylistLabel(cached.label, isNew, isUpdated, cached.isIncomplete);
                
                opt.innerText = displayLabel;
                updateCustomItemLabel(opt.value, displayLabel);
                isFavoritesFile ? results.favs.push(opt) : results.regs.push(opt);

                // v35: フォルダ年が現在の年より古い場合のみスキップする（2025年分が2026年になっても消えないように）
                const folderYear = parseInt(yearName);
                const currentYear = new Date().getFullYear();
                if (folderYear < currentYear - 1) {
                     continue;
                }
            } else {
                opt.innerText = `[${yearName}] Loading... ${file.name}`;
                isFavoritesFile ? results.favs.push(opt) : results.regs.push(opt);
            }

            // 非同期で最新情報を取得
            (async () => {
                try {
                    const jData = await gapi.client.drive.files.get({ fileId: file.id, alt: 'media' });
                    let d = jData.result;
                    if (typeof d === 'string') {
                        try { d = JSON.parse(d); } catch(e) { }
                    }

                    if (d && d.date && d.chart_artist && d.chart_title) {
                        const artist = d.chart_artist.trim();
                        const title = d.chart_title.trim();

                        // v25: 未完成判定 (1-10曲目にファイルがない)
                        const isIncomplete = d.chart && d.chart.slice(0, 10).some(t => !t.mp3_file || t.mp3_file.trim() === "");

                        let label = "";
                        const artistL = artist.toLowerCase();
                        const titleL = title.toLowerCase();
                        const aliases = { "micky more & andy tee": ["mm & at"], "dave lee zr": ["dave lee"], "dave lee": ["dave lee zr"] };
                        let isDuplicate = titleL.startsWith(artistL) || (aliases[artistL] && aliases[artistL].some(a => titleL.startsWith(a.toLowerCase())));

                        if (isDuplicate) {
                            label = `${d.date} ${title}`;
                        } else {
                            label = `${d.date} ${artist}'s ${title}`;
                        }

                        const now = Date.now();
                        const createdAt = (cached && cached.createdAt) ? cached.createdAt : now;
                        const isFavoritesFile = /favorites/i.test(file.name);
                        const isNew = (now - createdAt) < REFLECTION_TIME_MS;

                        let isUpdated = false;
                        if (isFavoritesFile || (cached && cached.isIncomplete)) {
                            const oldChartJson = (cached && cached.chart) ? JSON.stringify(cached.chart.slice(0, 10)) : "";
                            const newChartJson = JSON.stringify((d.chart || []).slice(0, 10));
                            const changed = (oldChartJson !== "" && oldChartJson !== newChartJson);
                            const withinReflection = (cached && cached.updatedAt && (now - cached.updatedAt) < REFLECTION_TIME_MS);
                            if (changed || withinReflection) {
                                isUpdated = true;
                            }
                        }

                        // updatedAt は内容が変わった時だけ更新する
                        let updatedAt = (cached && cached.updatedAt) ? cached.updatedAt : 0;
                        if (isUpdated && (!cached || (cached.chart && JSON.stringify(cached.chart) !== JSON.stringify(d.chart)))) {
                            updatedAt = now;
                        }

                        // v25: 絵文字付きラベル
                        const displayLabel = formatPlaylistLabel(label, isNew, isUpdated, isIncomplete);

                        if (opt.innerText !== displayLabel) {
                            opt.innerText = displayLabel;
                            updateCustomItemLabel(opt.value, displayLabel);
                        }

                        // メタデータキャッシュ保存
                        // Favoritesの場合はchartも保存する
                        const cacheData = { label, playlistDate: d.date, isIncomplete, updatedAt, metaOnly: !isFavoritesFile };
                        if (isFavoritesFile) cacheData.chart = d.chart;
                        await JukeboxDB.set(file.id, cacheData);
                    }
                } catch (err) {
                    console.error("Error background renaming:", err);
                }
            })();
        }
    }
    return results;
}

// 3. リスト表示
selector.onchange = async (e) => {
    if (!e.target.value) return;

    updateStatus("Loading DJ Chart...");

    // v45: 検索ボックスの表示を選択した名前に更新
    if (playlistSearch) {
        const selectedOpt = selector.options[selector.selectedIndex];
        if (selectedOpt) playlistSearch.value = selectedOpt.innerText;
    }

    // v21: 新しいプレイリスト選択時は一旦止める
    if (typeof Amplitude !== 'undefined') Amplitude.pause();

    const data = JSON.parse(e.target.value);
    const fileId = data.id;
    let played = false;

    // 1. キャッシュから即座に復元
    const cached = await JukeboxDB.get(fileId);
    if (cached && cached.chart) {
        console.log("Loading playlist from cache...");
        currentPlaylist = cached.chart;
        currentPlaylistDate = cached.playlistDate || "";
        currentIsIncomplete = cached.isIncomplete || false;
        
        // v42: 初期化（全体描画用にフラグを立てるが、後の比較で上書きされる可能性あり）
        const selectedOpt = selector.options[selector.selectedIndex];
        const labelText = selectedOpt ? selectedOpt.innerText : "";
        currentIsNewPlaylist = labelText.startsWith("🆕");
        currentNewMp3s.clear();

        renderList();
        showPlayer(data.year);
        // v21: キャッシュがあれば即座に再生開始
        playWithAmplitude(0);
        played = true;
    }

    // 2. バックグラウンドで最新情報を取得
    try {
        const res = await gapi.client.drive.files.get({ fileId: fileId, alt: 'media' });
        const newChart = res.result.chart || [];
        const newDate = res.result.date || "";
        // v25: 1-10曲目に未完成があるか
        const newIsIncomplete = newChart.slice(0, 10).some(t => !t.mp3_file || t.mp3_file.trim() === "");

        const oldJson = JSON.stringify(currentPlaylist);
        const newJson = JSON.stringify(newChart);

        if (oldJson !== newJson || currentPlaylistDate !== newDate || currentIsIncomplete !== newIsIncomplete) {
            console.log("DJ Chart updated from Drive. Re-rendering...");
            
            // v42: 新着判定と新曲比較
            const selectedOpt = selector.options[selector.selectedIndex];
            const labelText = selectedOpt ? selectedOpt.innerText : "";
            currentIsNewPlaylist = labelText.startsWith("🆕");
            currentNewMp3s.clear();
            
            if (!currentIsNewPlaylist && labelText.startsWith("🆙") && currentPlaylist.length > 0) {
                // 既存のMP3ファイル名のセットを作成
                const oldMp3s = new Set(currentPlaylist.map(t => t.mp3_file ? t.mp3_file.split('/').pop() : "").filter(f => f));
                newChart.forEach(t => {
                    if (t.mp3_file) {
                        const bname = t.mp3_file.split('/').pop();
                        if (bname && !oldMp3s.has(bname)) {
                            currentNewMp3s.add(bname);
                        }
                    }
                });
            }

            currentPlaylist = newChart;
            currentPlaylistDate = newDate;
            currentIsIncomplete = newIsIncomplete;
            renderList();
            showPlayer(data.year);
            // v21: まだ再生していなければ（キャッシュがなかった等）ここで開始
            if (!played) {
                playWithAmplitude(0);
                played = true;
            }
        } else if (!played) {
            // 内容が同じでも、まだ再生が始まっていなければ開始
            playWithAmplitude(0);
            played = true;
        }

        // キャッシュを更新 (labelも保持)
        const selectedOpt = selector.options[selector.selectedIndex];
        let label = selectedOpt ? selectedOpt.innerText : (cached ? cached.label : "");
        // v29: 絵文字を確実に除去してから保存
        label = label.replace(/^[🆕🆙\s]+/, "")
            .replace(/[\s🚧👷]+$/, "");
        await JukeboxDB.set(fileId, { label, chart: newChart, playlistDate: newDate, isIncomplete: newIsIncomplete, metaOnly: false });

    } catch (err) {
        console.error("Error background loading DJ Chart:", err);
    }

    updateStatus("Ready");
};

function showPlayer(year) {
    const player = document.getElementById('flat-black-player');
    if (player) {
        player.style.display = (window.innerWidth > 500) ? 'block' : 'flex';
    }
    updateStatus("Ready: " + year);
}


function renderList() {
    trackList.innerHTML = '';
    currentPlaylist.forEach((track, index) => {
        if (!track || !track.title) return; // JSON内に空要素等が含まれている場合はスキップする

        const fullTitle = track.version ? `${track.title} (${track.version})` : track.title;

        // mp3_file が存在するかチェック
        const hasFile = track.mp3_file && track.mp3_file.trim() !== "";

        // ★追加要望：11曲目以降（1-basedで11番目から）で mp3_file が無い場合は表示自体をスキップする
        if (index + 1 > 10 && !hasFile) {
            return;
        }

        const li = document.createElement('li');
        li.id = `track-${index}`;

        // ファイルがない場合は 'disabled' クラスを付与
        if (!hasFile) {
            li.classList.add('disabled');
        }

        // v42: Newアイコンの判定
        let showNewIcon = false;
        if (hasFile) {
            if (currentIsNewPlaylist) {
                showNewIcon = true;
            } else {
                const bname = track.mp3_file.split('/').pop();
                if (bname && currentNewMp3s.has(bname)) {
                    showNewIcon = true;
                }
            }
        }
        const newIconHtml = showNewIcon ? '<span style="color: #55b560; margin-right: 4px; font-size: 0.9em;">🆕</span>' : '';

        li.innerHTML = `
            <div class="meta-container" style="${!hasFile ? 'opacity: 0.4;' : ''}">
                <b>${newIconHtml}${track.num != null ? track.num + '. ' : ''}${fullTitle}</b><br>
                <small>${track.artist}</small>
            </div>`;

        // クリックイベントの設定
        li.onclick = function () {
            // ファイルがある場合のみ再生処理を実行
            if (hasFile) {
                playWithAmplitude(index);

                // リストを閉じる処理
                const list = document.getElementById('track_list');
                const player = document.getElementById('flat-black-player');
                const text = document.getElementById('playlist-status-text');
                if (list) list.style.display = 'none';
                if (player) player.classList.remove('playlist-open');
                if (text) text.innerText = "SHOW TRACK LIST";
                const arrow = document.getElementById('playlist-arrow');
                if (arrow) arrow.style.transform = "rotate(0deg)";
            } else {
                console.log("This track has no MP3 file.");
            }
        };
        trackList.appendChild(li);
    });

    // プレイリストが新しく描画されたら、スクロール位置を一番上にリセットする
    trackList.scrollTop = 0;
}

function updateMarquee() {
    const checkMarquee = (elementId) => {
        const el = document.getElementById(elementId);
        if (!el) return;
        const wrapper = el.parentElement;
        if (!wrapper) return;

        el.classList.remove('is-marquee');

        setTimeout(() => {
            // 文字の幅が、表示窓(wrapper)の幅より大きいか判定
            if (el.scrollWidth > wrapper.offsetWidth) {
                el.classList.add('is-marquee');
            }
        }, 100);
    };

    checkMarquee('now-playing-title');
    checkMarquee('now-playing-artist');
}

/**
 * 現在の曲の次の「有効な曲」をバックグラウンドでダウンロードし、
 * Blob URL を変数に保持しておく。
 */
async function prefetchNextTrack(currentIndex) {
    if (isPrefetching) return;
    isPrefetching = true;

    try {
        let targetIndex = -1;

        if (isShuffleOn && currentPlaylist.length > 0) {
            const validIndices = [];
            currentPlaylist.forEach((t, i) => {
                if (t.mp3_file && t.mp3_file.trim() !== "") {
                    validIndices.push(i);
                }
            });

            if (validIndices.length > 0) {
                let filtered = validIndices.filter(i => i !== currentIndex);
                if (filtered.length === 0) filtered = validIndices;
                targetIndex = filtered[Math.floor(Math.random() * filtered.length)];
            }
        } else {
            let idx = currentIndex + 1;
            let searchCount = 0;
            const maxSearch = currentPlaylist.length;

            while (searchCount < maxSearch) {
                if (idx >= currentPlaylist.length) {
                    if (isRepeatOn) {
                        idx = 0;
                    } else {
                        break;
                    }
                }

                const track = currentPlaylist[idx];
                if (track && track.mp3_file && track.mp3_file.trim() !== "") {
                    targetIndex = idx;
                    break;
                }
                idx++;
                searchCount++;
            }
        }

        // 2. 見つからなかった、または自分自身に戻ってきてしまった場合は終了
        if (targetIndex === -1 || targetIndex === currentIndex) {
            console.log("No more tracks to prefetch.");
            isPrefetching = false;
            return;
        }

        const track = currentPlaylist[targetIndex];
        const fileName = track.mp3_file.split('/').pop();
        console.log(`Prefetching start: ${track.title} (${fileName})`);

        // 2. Google Drive からファイルIDを特定
        const fRes = await gapi.client.drive.files.list({
            q: `name = '${fileName.replace(/'/g, "\\'")}' and trashed = false`,
            fields: 'files(id)', pageSize: 1
        });

        if (fRes.result.files && fRes.result.files.length > 0) {
            const targetId = fRes.result.files[0].id;

            // 3. バイナリデータを取得（バックグラウンド）
            const response = await gapi.client.drive.files.get({ fileId: targetId, alt: 'media' });

            const str = response.body;
            const buf = new Uint8Array(str.length);
            for (let i = 0; i < str.length; i++) buf[i] = str.charCodeAt(i) & 0xff;
            const blob = new Blob([buf], { type: 'audio/mpeg' });

            // 4. 古い先読みデータがあれば解放して更新
            if (nextBlobUrl) URL.revokeObjectURL(nextBlobUrl);
            if (nextCoverUrl && nextCoverUrl.startsWith('blob:')) URL.revokeObjectURL(nextCoverUrl);

            nextBlobUrl = URL.createObjectURL(blob);
            nextTrackIndex = targetIndex;

            // 5. カバーアートも先読み（jsmediatags）
            let coverUrl = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
            try {
                if (window.jsmediatags) {
                    const tags = await new Promise((res, rej) => {
                        window.jsmediatags.read(blob, {
                            onSuccess: t => res(t.tags),
                            onError: e => rej(e)
                        });
                    });
                    if (tags && tags.picture) {
                        const { data, format } = tags.picture;
                        coverUrl = URL.createObjectURL(new Blob([new Uint8Array(data)], { type: format }));
                    }
                }
            } catch (e) {
                console.log("Prefetch: Cover art extraction skipped.");
            }

            nextCoverUrl = coverUrl;
            console.log(`Prefetch complete: ${track.title}`);
        } else {
            console.warn(`Prefetch failed: File not found (${fileName})`);
        }
    } catch (e) {
        console.error("Prefetch process error:", e);
    } finally {
        isPrefetching = false;
    }
}

// --- 再生制御の統合ヘルパー ---
function playNextTrack() {
    // すでに先読み済みのインデックスがあればそれを優先する（シャッフル時も含む）
    if (nextTrackIndex !== -1) {
        console.log(`Using prefetched index: ${nextTrackIndex}`);
        playWithAmplitude(nextTrackIndex);
        return;
    }

    if (isShuffleOn && currentPlaylist.length > 0) {
        // ... (以下、先読みがない場合のフォールバックロジック)
        const validIndices = [];
        currentPlaylist.forEach((t, i) => {
            if (t.mp3_file && t.mp3_file.trim() !== "") {
                validIndices.push(i);
            }
        });

        if (validIndices.length > 0) {
            let filtered = validIndices.filter(i => i !== currentTrackIndex);
            if (filtered.length === 0) filtered = validIndices;

            const randomIdx = filtered[Math.floor(Math.random() * filtered.length)];
            playWithAmplitude(randomIdx);
            return;
        }
    }
    // 通常再生
    playWithAmplitude(currentTrackIndex + 1);
}

function clearPrefetch() {
    nextTrackIndex = -1;
    if (nextBlobUrl) URL.revokeObjectURL(nextBlobUrl);
    nextBlobUrl = null;
    nextCoverUrl = null;
    console.log("Prefetch cleared.");
    // 状態が変わったので必要なら新しい先読みを開始
    if (currentTrackIndex !== -1) {
        prefetchNextTrack(currentTrackIndex);
    }
}

// 4. 再生 & スキップロジック
async function playWithAmplitude(index) {
    // 世代を進める（古いタイマーやイベントからの呼び出しを無効化する）
    const thisGen = ++playGeneration;

    // 前の曲の監視タイマーとイベントを即座に破棄
    if (window.autoNextTimer) {
        clearInterval(window.autoNextTimer);
        window.autoNextTimer = null;
    }
    const audio = Amplitude.getAudio ? Amplitude.getAudio() : document.querySelector('audio');
    if (audio) {
        audio.onended = null;
    }

    // タイマーからの呼び出しなどで重なった場合でも、
    // 前のロードが「現在のインデックスと同じ」ならスキップして進めるようにする
    if (isLoadingTrack && index === currentTrackIndex) return;

    isLoadingTrack = true;

    try {
        // --- 1. 次の「有効な曲」を探すループ ---
        let searchCount = 0;
        const maxSearch = currentPlaylist.length + 1;

        while (searchCount < maxSearch) {
            // リストの最後まで到達した場合
            if (index >= currentPlaylist.length) {
                if (isRepeatOn && currentPlaylist.length > 0) {
                    console.log(`[Gen ${thisGen}] End of list. Wrapping to start.`);
                    index = 0;
                } else {
                    updateStatus("End of Playlist");
                    isLoadingTrack = false;
                    return;
                }
            }

            const track = currentPlaylist[index];
            if (track && track.mp3_file && track.mp3_file.trim() !== "") {
                // 有効な曲が見つかった
                break;
            }

            console.log(`[Gen ${thisGen}] Skipping index ${index} (No valid file).`);
            index++;
            searchCount++;
        }

        if (searchCount >= maxSearch) {
            updateStatus("No playable tracks found");
            isLoadingTrack = false;
            return;
        }

        const track = currentPlaylist[index];
        currentTrackIndex = index; // 現在のインデックスを確定

        // --- 2. 先読み(Prefetch)済みのURLがあるかチェック ---
        if (index === nextTrackIndex && nextBlobUrl) {
            console.log("Using prefetched data for:", track.title);

            if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl);
            currentBlobUrl = nextBlobUrl;
            const coverUrl = nextCoverUrl;

            // 先読み変数をリセット
            nextBlobUrl = null;
            nextCoverUrl = null;
            nextTrackIndex = -1;

            // 再生開始
            startPlayback(index, currentBlobUrl, coverUrl, thisGen);
            return; // ここで終了
        }

        // --- 3. 先読みがない場合、通常通りダウンロード ---
        const fileName = track.mp3_file.split('/').pop();
        updateStatus(`Searching: ${fileName}`);

        const fRes = await gapi.client.drive.files.list({
            q: `name = '${fileName.replace(/'/g, "\\'")}' and trashed = false`,
            fields: 'files(id)', pageSize: 1
        });

        if (fRes.result.files && fRes.result.files.length > 0) {
            const targetId = fRes.result.files[0].id;
            updateStatus('Downloading...');

            const response = await gapi.client.drive.files.get({ fileId: targetId, alt: 'media' });

            // バイナリ変換処理
            const str = response.body;
            const buf = new Uint8Array(str.length);
            for (let i = 0; i < str.length; i++) buf[i] = str.charCodeAt(i) & 0xff;
            const blob = new Blob([buf], { type: 'audio/mpeg' });

            if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl);
            currentBlobUrl = URL.createObjectURL(blob);

            // カバーアート抽出
            let coverUrl = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
            try {
                if (window.jsmediatags) {
                    const tags = await new Promise((res, rej) => {
                        window.jsmediatags.read(blob, {
                            onSuccess: t => res(t.tags),
                            onError: e => rej(e)
                        });
                    });
                    if (tags && tags.picture) {
                        const { data, format } = tags.picture;
                        coverUrl = URL.createObjectURL(new Blob([new Uint8Array(data)], { type: format }));
                    }
                }
            } catch (e) { console.log("Cover art extraction skipped."); }

            // 【重要】再生ボタン押下などで新しい世代が割り込んでいないか最終チェック
            if (playGeneration !== thisGen) {
                console.warn(`[Gen ${thisGen}] Interrupted before startPlayback. Aborting.`);
                return;
            }

            // 再生開始
            startPlayback(index, currentBlobUrl, coverUrl, thisGen);
        } else {
            // ファイルが見つからなかった場合は次の曲へ
            updateStatus(`Not Found: ${fileName}`);
            isLoadingTrack = false;
            playNextTrack();
        }
    } catch (e) {
        console.error("Playback flow error:", e);
        updateStatus("Error: " + e.message);
        isLoadingTrack = false;
    }
}

function startPlayback(index, url, cover, gen) {
    const track = currentPlaylist[index];
    if (!track) return;

    currentTrackIndex = index;
    const fullTitle = track.version ? `${track.title} (${track.version})` : track.title;

    // 1. Amplitudeでの再生
    const songData = {
        name: fullTitle,
        artist: track.artist || "Unknown",
        url: url,
        cover_art_url: cover
    };
    Amplitude.playNow(songData);

    // 2. スマホ等での再生失敗対策：少し後に再生状態を確認し、止まっていれば再度Playを叩く
    setTimeout(() => {
        const audio = Amplitude.getAudio ? Amplitude.getAudio() : document.querySelector('audio');
        if (audio && audio.paused && !isLoadingTrack) {
            console.log(`[Gen ${gen}] Playback seems stalled. Nudging play...`);
            Amplitude.play();
        }
    }, 500);

    // 3. ブラウザのAudioタグにイベントをセット
    const audio = Amplitude.getAudio ? Amplitude.getAudio() : document.querySelector('audio');
    if (audio) {
        audio.onended = () => {
            // 【重要】このイベントが発生した時の世代が、現在の世代と一致する場合のみ次へ
            if (playGeneration === gen) {
                console.log(`[Gen ${gen}] Native Audio Ended. Triggering next track...`);
                isLoadingTrack = false;
                playNextTrack();
            } else {
                console.warn(`[Gen ${gen}] Native Audio Ended but ignored (New gen ${playGeneration} is active).`);
            }
        };
    }

    // --- Media Session API (ロック画面制御) ---
    if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
            title: track.title,
            artist: track.artist || "Unknown",
            album: "Cloud Jukebox",
            artwork: [
                { src: cover, sizes: '512x512', type: 'image/png' }
            ]
        });

        navigator.mediaSession.setActionHandler('play', async () => {
            try {
                await Amplitude.play();
                navigator.mediaSession.playbackState = "playing";
            } catch (err) {
                console.error("MediaSession Play Error:", err);
            }
        });
        navigator.mediaSession.setActionHandler('pause', () => {
            try {
                Amplitude.pause();
                navigator.mediaSession.playbackState = "paused";
            } catch (err) {
                console.error("MediaSession Pause Error:", err);
            }
        });
        navigator.mediaSession.setActionHandler('previoustrack', () => {
            const prev = Math.max(0, currentTrackIndex - 1);
            playWithAmplitude(prev);
        });
        navigator.mediaSession.setActionHandler('nexttrack', () => { playNextTrack(); });
    }

    // --- UI更新 ---
    const titleEl = document.getElementById('now-playing-title');
    const artistEl = document.getElementById('now-playing-artist');
    if (titleEl) titleEl.innerText = fullTitle;
    if (artistEl) artistEl.innerText = track.artist || "";

    if (typeof updateMarquee === 'function') updateMarquee();

    document.querySelectorAll('#track_list li').forEach(el => el.classList.remove('playing'));
    const activeLi = document.getElementById(`track-${index}`);
    if (activeLi) activeLi.classList.add('playing');

    updateStatus('Playing');
    isLoadingTrack = false;

    console.log(`[Gen ${gen}] Starting prefetch...`);
    prefetchNextTrack(index);

    // --- 最終手段：監視タイマー ---
    window.autoNextTimer = setInterval(() => {
        // 【重要】世代が古くなっていたらタイマー自体を破棄
        if (playGeneration !== gen) {
            clearInterval(window.autoNextTimer);
            window.autoNextTimer = null;
            return;
        }

        const audio = Amplitude.getAudio ? Amplitude.getAudio() : document.querySelector('audio');
        if (audio && !audio.paused && audio.duration > 0) {
            const timeLeft = audio.duration - audio.currentTime;
            if (timeLeft < 0.5 && timeLeft > 0) {
                console.log(`[Gen ${gen}] Timer detected end. Forcing next...`);
                clearInterval(window.autoNextTimer);
                window.autoNextTimer = null;
                isLoadingTrack = false;
                playNextTrack();
            }
        }
    }, 300);
}
window.initApp = initApp;

// --- End of jukebox.js ---
