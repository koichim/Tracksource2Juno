/* --- 設定エリア --- */
const CLIENT_ID = '584975721862-ce0db6ved3d295vbeb88k3titfcq5h6n.apps.googleusercontent.com';
const SCOPES = 'https://www.googleapis.com';


let tokenClient, gapiInited = false, gisInited = false;
let currentPlaylist = [], currentTrackIndex = -1, currentYearName = "";
let currentBlobUrl = null, isLoadingTrack = false;

const authBtn = document.getElementById('auth_btn');
const selector = document.getElementById('playlist_selector');
const trackList = document.getElementById('track_list');

window.togglePlaylistView = function() {
    console.log("Playlist Toggle Clicked!");
    const player = document.getElementById('flat-black-player');
    const list = document.getElementById('track_list');
    const text = document.getElementById('playlist-status-text');

    if (!player || !list) return;

    // 表示・非表示の切り替え
    const isOpen = player.classList.toggle('playlist-open');
    list.style.display = isOpen ? 'block' : 'none';
    if (text) text.innerText = isOpen ? "Close Playlist" : "Show Playlist";
    
    console.log("Current State: ", isOpen);
};

/* --- ここから下の既存のコード（CLIENT_ID等）はそのまま --- */
const CLIENT_ID = '...';

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
                    playWithAmplitude(currentTrackIndex + 1);
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
                authBtn.style.display = 'none';
                selector.style.display = 'block';
                await startDiscovery();
            }
        }
    });
    document.getElementById('custom-next').onclick = () => {
        playWithAmplitude(currentTrackIndex + 1);
    };
    document.getElementById('custom-prev').onclick = () => {
        const prev = Math.max(0, currentTrackIndex - 1);
        playWithAmplitude(prev);
    };

    // シャッフルとリピートの状態（見た目）の切り替え
    document.getElementById('shuffle').onclick = function () {
        this.style.opacity = this.classList.contains('amplitude-shuffle-on') ? "1" : "0.5";
    };
    document.getElementById('repeat').onclick = function () {
        this.style.opacity = this.classList.contains('amplitude-repeat-on') ? "1" : "0.5";
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
        statusText.innerText = isOpen ? "Close Playlist" : "Show Playlist";

        // CSSだけで効かない場合のために、直接 style も叩く（念のため）
        trackListEl.style.display = isOpen ? "block" : "none";

        console.log("Playlist Toggled:", isOpen);
    };
}

authBtn.onclick = () => tokenClient.requestAccessToken({ prompt: 'consent' });

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
    selector.innerHTML = '<option value="">Select Playlist...</option>';
    const yearFolders = res.result.files.filter(f => f.name.match(/^\d{4}$/) && parseInt(f.name) >= 2023);
    for (const f of yearFolders) await findTracksFolder(f.id, f.name);
    updateStatus("Playlists Loaded.");
}

async function findTracksFolder(yearId, yearName) {
    const res = await gapi.client.drive.files.list({
        q: `'${yearId}' in parents and name = 'tracks' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id)'
    });
    for (const tf of res.result.files) {
        const jRes = await gapi.client.drive.files.list({
            q: `'${tf.id}' in parents and mimeType = 'application/json' and trashed = false`,
            fields: 'files(id, name)'
        });
        jRes.result.files.forEach(file => {
            const opt = document.createElement('option');
            opt.value = JSON.stringify({ id: file.id, year: yearName });
            opt.innerText = `[${yearName}] ${file.name}`;
            selector.appendChild(opt);
        });
    }
}

// 3. リスト表示
selector.onchange = async (e) => {
    if (!e.target.value) return;
    updateStatus("Loading JSON...");
    const data = JSON.parse(e.target.value);
    const res = await gapi.client.drive.files.get({ fileId: data.id, alt: 'media' });
    currentPlaylist = res.result.chart;
    currentYearName = data.year;
    renderList();
};

function renderList() {
    trackList.innerHTML = '';
    currentPlaylist.forEach((track, index) => {
        const isEmpty = !track.mp3_file || track.mp3_file === "";
        const li = document.createElement('li');
        li.classList.add('amplitude-song-container');
        li.id = `track-${index}`;
        if (isEmpty) li.style.opacity = "0.3";
        li.innerHTML = `<div class="meta-container"><b>${track.num}. ${track.title}</b><br><small>${track.artist}</small></div>`;

        li.addEventListener('click', function () {
            if (!isEmpty) {
                // UI上のプレイリストを閉じる（CSS/HTML側で制御している場合）
                document.getElementById('flat-black-player').classList.remove('playlist-open');
                playWithAmplitude(index);
            }
        });
        trackList.appendChild(li);
    });
    updateStatus("Tracklist Ready.");
}

// 4. 再生 & スキップロジック
async function playWithAmplitude(index) {
    if (isLoadingTrack) return;
    isLoadingTrack = true;

    try {
        let trackFoundAndPlayed = false;
        // ループ条件を厳密にし、再生成功時は即座に「関数自体を終了」させる
        while (index < currentPlaylist.length && !trackFoundAndPlayed) {
            const track = currentPlaylist[index];
            currentTrackIndex = index;

            if (!track || !track.mp3_file) {
                index++; continue;
            }

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

                const str = response.body;
                const buf = new Uint8Array(str.length);
                for (let i = 0; i < str.length; i++) buf[i] = str.charCodeAt(i) & 0xff;
                const blob = new Blob([buf], { type: 'audio/mpeg' });

                if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl);
                currentBlobUrl = URL.createObjectURL(blob);

                // --- カバーアート抽出 (エラーが出ても無視するように改良) ---
                let coverUrl = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
                try {
                    if (window.jsmediatags) {
                        const tags = await new Promise((res, rej) => {
                            window.jsmediatags.read(blob, { onSuccess: t => res(t.tags), onError: e => rej(e) });
                        });
                        if (tags && tags.picture) {
                            const { data, format } = tags.picture;
                            coverUrl = URL.createObjectURL(new Blob([new Uint8Array(data)], { type: format }));
                        }
                    }
                } catch (e) { console.log("Cover art skip."); }

                // --- 再生実行 (ここが重要) ---
                // 再生開始前にフラグを立ててロックを解除し、ループを抜ける準備をする
                trackFoundAndPlayed = true;
                isLoadingTrack = false;

                Amplitude.playNow({
                    name: track.title || "Unknown",
                    artist: track.artist || "Unknown",
                    url: currentBlobUrl,
                    cover_art_url: coverUrl
                });

                // UI更新 (エラーになっても止まらないように全てオプション（?）扱いに)
                const titleEl = document.getElementById('now-playing-title');
                const artistEl = document.getElementById('now-playing-artist');
                if (titleEl) titleEl.innerText = track.title || "";
                if (artistEl) artistEl.innerText = track.artist || "";

                document.querySelectorAll('#track_list li').forEach(el => el.classList.remove('playing'));
                const activeLi = document.getElementById(`track-${index}`);
                if (activeLi) activeLi.classList.add('playing');

                updateStatus('Playing');

                return; // ★これ以上ループさせないために、ここで関数を強制終了★
            } else {
                updateStatus(`Skipping: ${fileName}`);
                index++;
            }
        }
    } catch (e) {
        console.error("Playback Error handled:", e);
    } finally {
        isLoadingTrack = false;
    }
}

window.initApp = initApp;

