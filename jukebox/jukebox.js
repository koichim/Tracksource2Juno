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

const authBtn = document.getElementById('auth_btn');
const selector = document.getElementById('playlist_selector');
const trackList = document.getElementById('track_list');

window.togglePlaylistView = function () {
    const player = document.getElementById('flat-black-player');
    const list = document.getElementById('track_list');
    const text = document.getElementById('playlist-status-text');

    if (!player || !list) return;

    const isOpen = player.classList.toggle('playlist-open');

    // 表示・非表示の切り替えとテキストの更新
    list.style.display = isOpen ? 'block' : 'none';

    if (text) {
        // ここを TITLE LIST に変更
        text.innerText = isOpen ? "CLOSE TRACK LIST" : "SHOW TRACK LIST";
    }

    // 矢印の回転など（既にある場合）
    const arrow = document.getElementById('playlist-arrow');
    if (arrow) arrow.style.transform = isOpen ? "rotate(180deg)" : "rotate(0deg)";
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
                    console.log("Song ended. Moving to next track...");
                    playWithAmplitude(currentTrackIndex + 1);
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

    updateStatus("Loading New Playlist...");

    // 1. もし再生中なら一旦止める（任意）
    if (typeof Amplitude !== 'undefined') {
        Amplitude.pause();
    }

    const data = JSON.parse(e.target.value);
    const res = await gapi.client.drive.files.get({ fileId: data.id, alt: 'media' });
    currentPlaylist = res.result.chart;

    // 2. リストを新しい内容で描き直す
    renderList();

    // 3. プレイヤーを表示させる
    const player = document.getElementById('flat-black-player');
    if (player) {
        player.style.display = 'flex'; // 再表示
        // PC表示の場合は block になるよう、CSSのメディアクエリに合わせる
        if (window.innerWidth > 500) {
            player.style.display = 'block';
        }
    }

    updateStatus("Ready: " + data.year);
    
    // 最初の有効な曲から自動再生を開始
    playWithAmplitude(0);
};


function renderList() {
    trackList.innerHTML = '';
    currentPlaylist.forEach((track, index) => {
        if (!track || !track.title) return; // JSON内に空要素等が含まれている場合はスキップする
        
        const fullTitle = track.version ? `${track.title} (${track.version})` : track.title;

        // mp3_file が存在するかチェック
        const hasFile = track.mp3_file && track.mp3_file.trim() !== "";

        const li = document.createElement('li');
        li.id = `track-${index}`;

        // ファイルがない場合は 'disabled' クラスを付与
        if (!hasFile) {
            li.classList.add('disabled');
        }

        li.innerHTML = `
            <div class="meta-container" style="${!hasFile ? 'opacity: 0.4;' : ''}">
                <b>${track.num}. ${fullTitle}</b><br>
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
        let targetIndex = currentIndex + 1;

        // 1. 次に再生可能な（mp3_fileがある）曲を探す
        while (targetIndex < currentPlaylist.length && (!currentPlaylist[targetIndex] || !currentPlaylist[targetIndex].mp3_file)) {
            targetIndex++;
        }

        // リストの最後まで到達していたら終了
        if (targetIndex >= currentPlaylist.length) {
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

// 4. 再生 & スキップロジック
async function playWithAmplitude(index) {
    // タイマーからの呼び出しなどで重なった場合でも、
    // 前のロードが「現在のインデックスと同じ」ならスキップして進めるようにする
    if (isLoadingTrack && index === currentTrackIndex) return;

    isLoadingTrack = true;

    try {
        // --- 1. 次の「有効な曲(mp3_fileがある曲)」を探す ---
        while (index < currentPlaylist.length && (!currentPlaylist[index] || !currentPlaylist[index].mp3_file)) {
            index++;
        }

        // リストの最後まで到達したら終了
        if (index >= currentPlaylist.length) {
            updateStatus("End of Playlist");
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
            startPlayback(index, currentBlobUrl, coverUrl);
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

            // 再生開始
            startPlayback(index, currentBlobUrl, coverUrl);
        } else {
            // ファイルが見つからなかった場合は次の曲へ
            updateStatus(`Not Found: ${fileName}`);
            isLoadingTrack = false;
            playWithAmplitude(index + 1);
        }
    } catch (e) {
        console.error("Playback flow error:", e);
        updateStatus("Error: " + e.message);
        isLoadingTrack = false;
    }
}

function startPlayback(index, url, cover) {
    const track = currentPlaylist[index];
    if (!track) return;

    currentTrackIndex = index;
    const fullTitle = track.version ? `${track.title} (${track.version})` : track.title;

    // 1. Amplitudeでの再生（playNowを使用し再初期化を避ける）
    // 再初期化（Amplitude.init）するとAudio要素が作り直され、ブラウザの自動再生ブロックに掛かるため
    const songData = {
        name: fullTitle,
        artist: track.artist || "Unknown",
        url: url,
        cover_art_url: cover
    };
    Amplitude.playNow(songData);

    // 3. 【最重要】ブラウザのAudioタグを直接捕まえてイベントをセット
    // Amplitudeが生成したaudio要素を特定
    const audio = Amplitude.getAudio ? Amplitude.getAudio() : document.querySelector('audio');
    if (audio) {
        // 既存のイベントを一度削除してクリーンにする
        audio.onended = null;
        
        // Amplitudeのsong_endedコールバックを使いますが、念のためバックアップとして設定
        audio.onended = () => {
            console.log("Native Audio Ended: Triggering next track...");
            // フラグを強制リセットしてロックを解除
            isLoadingTrack = false;
            playWithAmplitude(currentTrackIndex + 1);
        };
    }

    // --- UI更新 ---
    const titleEl = document.getElementById('now-playing-title');
    const artistEl = document.getElementById('now-playing-artist');
    if (titleEl) titleEl.innerText = fullTitle;
    if (artistEl) artistEl.innerText = track.artist || "";

    // マーキー（流れる文字）の判定
    if (typeof updateMarquee === 'function') updateMarquee();

    // プレイリスト内のハイライト更新
    document.querySelectorAll('#track_list li').forEach(el => el.classList.remove('playing'));
    const activeLi = document.getElementById(`track-${index}`);
    if (activeLi) activeLi.classList.add('playing');

    updateStatus('Playing');
    isLoadingTrack = false;

    // ★重要：再生が始まったら、バックグラウンドで「さらに次の曲」を先読み
    console.log("Starting prefetch for the next valid track...");
    prefetchNextTrack(index);

    // --- 最終手段：残り時間を監視して強制的に次へ飛ばす ---
    if (window.autoNextTimer) clearInterval(window.autoNextTimer);

    window.autoNextTimer = setInterval(() => {
        const audio = Amplitude.getAudio ? Amplitude.getAudio() : document.querySelector('audio');
        if (audio && !audio.paused && audio.duration > 0) {
            // 残り時間が 0.5秒を切ったら「終了」とみなす
            const timeLeft = audio.duration - audio.currentTime;
            if (timeLeft < 0.5 && timeLeft > 0) {
                console.log("Timer detected end of track. Forcing next...");
                clearInterval(window.autoNextTimer);

                // ロックを解除して次を再生
                isLoadingTrack = false;
                // 次の曲を再生
                playWithAmplitude(currentTrackIndex + 1);
            }
        }
    }, 300); // 0.3秒ごとにチェック
}
window.initApp = initApp;

