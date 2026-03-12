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
                authBtn.style.display = 'none';
                selector.style.display = 'block';
                await startDiscovery();
            }
        }
    });
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
        
        // プレイリストファイルを読み込んで、中身のメタデータで表示名を更新する
        for (const file of jRes.result.files) {
            const opt = document.createElement('option');
            opt.value = JSON.stringify({ id: file.id, year: yearName });
            opt.innerText = `[${yearName}] Loading... ${file.name}`;
            selector.appendChild(opt);

            try {
                const jData = await gapi.client.drive.files.get({ fileId: file.id, alt: 'media' });
                const d = jData.result;
                if (d && d.date && d.chart_artist && d.chart_title) {
                    // アーティスト名の重複チェック：タイトルがアーティスト名で始まっているか
                    const artist = d.chart_artist.trim();
                    const title = d.chart_title.trim();
                    const titleL = title.toLowerCase();
                    const artistL = artist.toLowerCase();

                    // 特定のアーティストの略称などの同一視設定
                    const aliases = {
                        "micky more & andy tee": ["mm & at"],
                        "dave lee zr": ["dave lee"],
                        "dave lee": ["dave lee zr"]
                    };
                    
                    let isDuplicate = titleL.startsWith(artistL);
                    
                    // 略称でも始まっているかチェック
                    if (!isDuplicate && aliases[artistL]) {
                        isDuplicate = aliases[artistL].some(a => titleL.startsWith(a.toLowerCase()));
                    }
                    
                    if (isDuplicate) {
                        // 重複（または略称一致）しているのでアーティスト名を省く
                        opt.innerText = `${d.date} ${title}`;
                    } else {
                        // 重複していないので (artist)'s (title) 形式
                        opt.innerText = `${d.date} ${artist}'s ${title}`;
                    }
                } else {
                    opt.innerText = `[${yearName}] ${file.name}`;
                }
            } catch (err) {
                console.error("Error renaming playlist:", err);
                opt.innerText = `[${yearName}] ${file.name}`;
            }
        }
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

