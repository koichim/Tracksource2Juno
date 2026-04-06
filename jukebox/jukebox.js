/* --- 設定エリア --- */
const CLIENT_ID = '584975721862-ce0db6ved3d295vbeb88k3titfcq5h6n.apps.googleusercontent.com';
const SCOPES = 'https://www.googleapis.com/auth/drive.readonly';


let tokenClient, gapiInited = false, gisInited = false;
let tokenResolve, tokenReject; // v67: Token refresh Promise state
let tokenIsMandatory = false;  // v73: 期限切れでの更新なら真、予備の更新なら偽
let discoveryStarted = false; // v62: サイレントリフレッシュ時の二重走査防止用
let currentPlaylist = [], currentTrackIndex = -1, currentYearName = "";
let currentBlobUrl = null, isLoadingTrack = false;
let nextTrackIndex = -1;
let nextBlobUrl = null;
let nextCoverUrl = null;
let isPrefetching = false;
let isShuffleOn = false;
let isRepeatOn = false;
let playGeneration = 0; // 世代管理：古い再生予約をキャンセルするため
let isInitAppDone = false; // v86: initAppの二重実行ガード
const APP_VERSION = "v87"; // プロダクション用バージョン
let currentPlaylistDate = ""; // v23: 現在のリストの日付
let currentIsIncomplete = false; // v25: 現在のリストが未完成か
const REFLECTION_TIME_DAYS = 15; // v35: 15日間
const REFLECTION_TIME_MS = REFLECTION_TIME_DAYS * 24 * 60 * 60 * 1000;
let currentIsNewPlaylist = false; // v42: 現在のプレイリストが「新着」か
let currentNewMp3s = new Set();    // v42: 🆙プレイリスト内で新しく追加された曲のセット

/**
 * Promiseにタイムアウト制限を設けるヘルパー
 */
function withTimeout(promise, ms, label = "Operation") {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            console.warn(`[Timeout] ${label} exceeded ${ms}ms`);
            reject(new Error(`${label} Timeout`));
        }, ms);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

// --- メタデータ取得キュー (並列制限用) ---
const MetadataQueue = {
    pending: [],
    running: 0,
    maxConcurrent: 1, // v47: データベースのロックを避けるため並列数を1に制限
    add(task) {
        return new Promise((resolve, reject) => {
            this.pending.push(async () => {
                try {
                    const res = await task();
                    resolve(res);
                } catch (e) {
                    console.error("[MetadataQueue] Task execution failed:", e);
                    reject(e);
                } finally {
                    this.running--;
                    // v51.1: スタックの深さを避けるため setTimeout を挟む
                    setTimeout(() => this.next(), 0);
                }
            });

            // 安全策：キューが止まっている（pendingがあるのにrunningが0）なら再始動
            if (this.running === 0) {
                this.next();
            } else if (this.running < this.maxConcurrent) {
                this.next();
            }
        });
    },
    next() {
        if (this.running >= this.maxConcurrent || this.pending.length === 0) {
            return;
        }

        while (this.running < this.maxConcurrent && this.pending.length > 0) {
            this.running++;
            const task = this.pending.shift();
            // console.log(`MetadataQueue: starting task. Running: ${this.running}, Pending: ${this.pending.length}`);
            task();
        }
    },
    clear() {
        this.pending = [];
        this.running = 0; // 強制リセット
        console.log("MetadataQueue cleared.");
    }
};

/**
 * ファイル名から暫定的な表示ラベルを生成するフォールバック
 */
function getFallbackLabel(filename, yearName) {
    if (/^\d{4}\s+favorites\.json$/i.test(filename)) {
        return `Koichi Masuda's ${filename.replace(/\.json$/i, "")}`;
    }
    // パターン: YYYY-MM-DD_Artist_Title CHART.json
    const match = filename.match(/^(\d{4}-\d{2}-\d{2})_(.*?)_(.*?) CHART\.json$/i);
    if (match) {
        const date = match[1];
        const artist = match[2];
        const title = match[3];
        const artistL = artist.toLowerCase();
        const titleL = title.toLowerCase();
        const aliases = { "micky more & andy tee": ["mm & at"], "dave lee zr": ["dave lee"], "dave lee": ["dave lee zr"] };
        const isDuplicate = titleL.startsWith(artistL) || (aliases[artistL] && aliases[artistL].some(a => titleL.startsWith(a.toLowerCase())));

        if (isDuplicate) {
            return `${date} ${title}`;
        } else {
            return `${date} ${artist}'s ${title}`;
        }
    }
    // 標準的なフォールバック
    return `[${yearName}] ${filename.replace(/\.json$/i, "")}`;
}

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
    dbVersion: 5, // v65: スキーマ更新を確実にするため 5 に上げる
    db: null,
    openPromise: null,
    log(...args) {
        if (typeof Logger !== 'undefined' && Logger.originalConsole) {
            Logger.originalConsole.log.apply(console, args);
        } else {
            console.log.apply(console, args);
        }
    },
    warn(...args) {
        if (typeof Logger !== 'undefined' && Logger.originalConsole) {
            Logger.originalConsole.warn.apply(console, args);
        } else {
            console.warn.apply(console, args);
        }
    },
    error(...args) {
        if (typeof Logger !== 'undefined' && Logger.originalConsole) {
            Logger.originalConsole.error.apply(console, args);
        } else {
            console.error.apply(console, args);
        }
    },
    async open() {
        if (this.db) return this.db;
        if (this.openPromise) return this.openPromise;

        this.openPromise = withTimeout(new Promise((resolve, reject) => {
            this.log("Opening IndexedDB (v" + this.dbVersion + ")...");
            const request = indexedDB.open(this.dbName, this.dbVersion);

            request.onblocked = () => {
                this.warn("IndexedDB open blocked. Please close other tabs of this app.");
            };

            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                this.log("IndexedDB Upgrade Needed. Current version: " + e.oldVersion);

                if (!db.objectStoreNames.contains('playlists')) {
                    db.createObjectStore('playlists', { keyPath: 'fileId' });
                }

                // v50: ファイル名 -> Google Drive ID のマッピング用ストア
                if (!db.objectStoreNames.contains('fileIds')) {
                    const store = db.createObjectStore('fileIds', { keyPath: 'name' });
                    store.createIndex('updatedAt', 'updatedAt', { unique: false });
                } else {
                    // 既存ストアにインデックスを追加する場合 (v2 -> v3)
                    const transaction = e.target.transaction;
                    const store = transaction.objectStore('fileIds');
                    if (!store.indexNames.contains('updatedAt')) {
                        store.createIndex('updatedAt', 'updatedAt', { unique: false });
                    }
                }

                if (!db.objectStoreNames.contains('logs')) {
                    const store = db.createObjectStore('logs', { keyPath: 'id', autoIncrement: true });
                    store.createIndex('timestamp', 'timestamp', { unique: false });
                }
            };

            request.onerror = (e) => {
                this.error("IndexedDB Open Error:", e);
                reject(new Error("IndexedDB open error"));
            };

            request.onsuccess = (e) => {
                this.db = e.target.result;
                // ストアとインデックスの最終チェック
                const hasStore = this.db.objectStoreNames.contains('fileIds');
                const hasLogsStore = this.db.objectStoreNames.contains('logs');
                let hasIndex = false;
                try {
                    hasIndex = hasStore && this.db.transaction(['fileIds'], 'readonly').objectStore('fileIds').indexNames.contains('updatedAt');
                } catch (err) {
                    this.warn("Check index error:", err);
                }

                if (!hasStore || !hasIndex || !hasLogsStore) {
                    this.warn("DB schema incomplete. Forcing upgrade...");
                    const nextVer = Math.max(this.db.version + 1, 4);
                    this.db.close();
                    this.db = null;
                    const req2 = indexedDB.open(this.dbName, nextVer);
                    req2.onupgradeneeded = (ev) => {
                        const db2 = ev.target.result;
                        if (!db2.objectStoreNames.contains('playlists')) db2.createObjectStore('playlists', { keyPath: 'fileId' });
                        if (!db2.objectStoreNames.contains('fileIds')) {
                            const s = db2.createObjectStore('fileIds', { keyPath: 'name' });
                            s.add({ name: "__schema_ver__", id: nextVer, updatedAt: Date.now() });
                            s.createIndex('updatedAt', 'updatedAt', { unique: false });
                        } else {
                            const s = ev.target.transaction.objectStore('fileIds');
                            if (!s.indexNames.contains('updatedAt')) s.createIndex('updatedAt', 'updatedAt', { unique: false });
                        }
                        if (!db2.objectStoreNames.contains('logs')) {
                            const s = db2.createObjectStore('logs', { keyPath: 'id', autoIncrement: true });
                            s.createIndex('timestamp', 'timestamp', { unique: false });
                        }
                    };
                    req2.onsuccess = (ev) => { this.db = ev.target.result; resolve(this.db); };
                    req2.onerror = () => reject(new Error("IndexedDB retry failed"));
                } else {
                    resolve(this.db);
                }
            };
        }), 10000, "DB Open");
        
        try {
            this.db = await this.openPromise;
            return this.db;
        } finally {
            this.openPromise = null;
        }
    },
    async get(fileId) {
        try {
            const db = await this.open();
            return withTimeout(new Promise((resolve, reject) => {
                const transaction = db.transaction(['playlists'], 'readonly');
                const request = transaction.objectStore('playlists').get(fileId);
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(new Error("Get Error"));
            }), 5000, "DB Get " + fileId);
        } catch (e) { return null; }
    },
    async set(fileId, data) {
        try {
            const db = await this.open();
            const existing = await this.get(fileId);
            const createdAt = (existing && existing.createdAt !== undefined) ? existing.createdAt : Date.now();
            return withTimeout(new Promise((resolve, reject) => {
                const transaction = db.transaction(['playlists'], 'readwrite');
                const request = transaction.objectStore('playlists').put({
                    fileId,
                    ...data,
                    createdAt,
                    updatedAt: (data.updatedAt !== undefined ? data.updatedAt : (existing && existing.updatedAt !== undefined ? existing.updatedAt : Date.now()))
                });
                request.onsuccess = () => resolve();
                request.onerror = () => reject(new Error("Set Error"));
            }), 5000, "DB Set " + fileId);
        } catch (e) { /* ignore */ }
    },
    // v50: ファイル名からIDを取得
    async getFileId(name) {
        try {
            const db = await this.open();
            return withTimeout(new Promise((resolve, reject) => {
                const transaction = db.transaction(['fileIds'], 'readonly');
                const request = transaction.objectStore('fileIds').get(name);
                request.onsuccess = () => resolve(request.result ? request.result.id : null);
                request.onerror = () => reject(new Error("GetFileId Error"));
            }), 3000, "DB GetFileId " + name);
        } catch (e) { return null; }
    },
    // v50: ファイル名からIDを保存 (2000件を超えたら古いものを削除)
    async setFileId(name, id) {
        try {
            const db = await this.open();
            // 1. まず保存
            const putRequest = withTimeout(new Promise((resolve, reject) => {
                const transaction = db.transaction(['fileIds'], 'readwrite');
                const request = transaction.objectStore('fileIds').put({ name, id, updatedAt: Date.now() });
                request.onsuccess = () => resolve();
                request.onerror = () => reject(new Error("SetFileId Error"));
            }), 3000, "DB SetFileId " + name);
            await putRequest;

            // 2. 件数チェックと整理 (Pruning)
            const transaction = db.transaction(['fileIds'], 'readwrite');
            const store = transaction.objectStore('fileIds');
            const countRequest = store.count();

            countRequest.onsuccess = () => {
                if (countRequest.result > 2000) {
                    this.log("Pruning fileId cache (count: " + countRequest.result + ")");
                    // 古い方から100件削除
                    const index = store.index('updatedAt');
                    const cursorRequest = index.openCursor(); // 昇順（古い順）
                    let deletedCount = 0;
                    cursorRequest.onsuccess = (e) => {
                        const cursor = e.target.result;
                        if (cursor && deletedCount < 100) {
                            cursor.delete();
                            deletedCount++;
                            cursor.continue();
                        }
                    };
                }
            };
        } catch (e) { /* ignore */ }
    },
    async clearAll() {
        try {
            // v75: ログイン情報もクリアして再認証を容易にする
            localStorage.removeItem('gdrive_token');
            
            const db = await this.open();
            return new Promise((resolve) => {
                const transaction = db.transaction(['playlists', 'fileIds', 'logs'], 'readwrite');
                transaction.objectStore('playlists').clear();
                transaction.objectStore('fileIds').clear();
                transaction.objectStore('logs').clear();
                transaction.oncomplete = () => resolve();
                transaction.onerror = () => resolve();
            });
        } catch (e) { /* ignore */ }
    },
    // --- Logging Support ---
    async saveLog(type, content) {
        try {
            const db = await this.open();
            if (!db.objectStoreNames.contains('logs')) return;
            const transaction = db.transaction(['logs'], 'readwrite');
            transaction.objectStore('logs').add({
                type,
                content,
                timestamp: Date.now()
            });
        } catch (e) { 
            if (typeof Logger !== 'undefined' && Logger.originalConsole) {
                Logger.originalConsole.error("saveLog error:", e);
            }
        }
    },
    async getLogs(limit = 2000) {
        try {
            const db = await this.open();
            return new Promise((resolve) => {
                const transaction = db.transaction(['logs'], 'readonly');
                const store = transaction.objectStore('logs');
                const index = store.index('timestamp');
                const logs = [];
                const request = index.openCursor(null, 'prev'); // 最新順
                request.onsuccess = (e) => {
                    const cursor = e.target.result;
                    if (cursor && logs.length < limit) {
                        logs.push(cursor.value);
                        cursor.continue();
                    } else {
                        resolve(logs.reverse()); // 時系列（古い順）に戻す
                    }
                };
                request.onerror = () => resolve([]);
            });
        } catch (e) { return []; }
    },
    async pruneLogs(daysToKeep = 7) {
        try {
            const db = await this.open();
            const threshold = Date.now() - (daysToKeep * 24 * 60 * 60 * 1000);
            const transaction = db.transaction(['logs'], 'readwrite');
            const store = transaction.objectStore('logs');
            const index = store.index('timestamp');
            const range = IDBKeyRange.upperBound(threshold);
            const request = index.openCursor(range);
            request.onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor) {
                    cursor.delete();
                    cursor.continue();
                }
            };
        } catch (e) { /* ignore */ }
    }
};

/**
 * --- Logger: Console Hooks & Export ---
 */
const Logger = {
    buffer: [], // メモリ上のバッファ（DB保存前や失敗時の予備）
    isLogging: false,
    originalConsole: {
        log: console.log,
        warn: console.warn,
        error: console.error
    },
    init() {
        const self = this;
        // console.log のフック
        console.log = function() {
            self.originalConsole.log.apply(console, arguments);
            self.save('LOG', arguments);
        };
        // console.warn のフック
        console.warn = function() {
            self.originalConsole.warn.apply(console, arguments);
            self.save('WARN', arguments);
        };
        // console.error のフック
        console.error = function() {
            self.originalConsole.error.apply(console, arguments);
            self.save('ERROR', arguments);
        };

        // Window エラーの捕捉
        window.addEventListener('error', (event) => {
            self.save('EXCEPTION', [event.message, event.filename, event.lineno]);
        });
        
        // v65: システムイベントの合言葉
        window.addEventListener('visibilitychange', () => {
            this.logDirect("SYSTEM", `Visibility changed to: ${document.visibilityState}`);
        });
        window.addEventListener('online', () => this.logDirect("SYSTEM", "Network: Online"));
        window.addEventListener('offline', () => this.logDirect("SYSTEM", "Network: Offline"));

        // 起動時のリフレッシュ（ローテーション）
        setTimeout(() => JukeboxDB.pruneLogs(7), 5000);
        
        // 疎通確認のためのテストログ
        this.logDirect("INFO", `[Logger] v65 Initialized at ${new Date().toISOString()}`);
    },
    // オーディオ要素の状態を監視
    monitorAudio(audio) {
        if (!audio || audio._loggingAdded) return;
        audio._loggingAdded = true;
        ['play', 'pause', 'stalled', 'waiting', 'playing', 'error'].forEach(evt => {
            audio.addEventListener(evt, () => {
                const label = audio.src ? audio.src.split('/').pop().substring(0, 30) : "no-src";
                this.logDirect("AUDIO", `Event: ${evt} (src: ${label}, time: ${audio.currentTime.toFixed(1)}, state: ${audio.readyState})`);
            });
        });
    },
    // コンソールのフックを通さずに直接保存する（内部用）
    logDirect(type, msg) {
        this.saveToMemory(type, msg);
        JukeboxDB.saveLog(type, msg);
    },
    saveToMemory(type, msg) {
        this.buffer.push({
            type,
            content: msg,
            timestamp: Date.now()
        });
        if (this.buffer.length > 500) this.buffer.shift(); // 最大500件保持
    },
    save(type, args) {
        if (this.isLogging) return; // 再帰防止
        this.isLogging = true;
        try {
            const msg = Array.from(args).map(arg => {
                if (typeof arg === 'object') {
                    try { return JSON.stringify(arg); } catch(e) { return String(arg); }
                }
                return String(arg);
            }).join(' ');
            
            this.saveToMemory(type, msg);
            JukeboxDB.saveLog(type, msg);
        } catch(e) { 
        } finally {
            this.isLogging = false;
        }
    },
    async export() {
        updateStatus("Gathering logs...");
        
        // DBからログ取得（失敗しても続行）
        let dbLogs = [];
        let dbStatus = "Unknown";
        try {
            dbLogs = await JukeboxDB.getLogs(10000);
            dbStatus = JukeboxDB.db ? "Connected" : "Disconnected";
        } catch (e) {
            dbStatus = "Error: " + e.message;
        }

        // メモリバッファとDBログを統合
        updateStatus("Processing logs...");
        const combinedLogs = [...dbLogs];
        const dbTimestamps = new Set(dbLogs.map(l => l.timestamp));
        
        this.buffer.forEach(ml => {
            if (!dbTimestamps.has(ml.timestamp)) {
                combinedLogs.push(ml);
            }
        });
        
        combinedLogs.sort((a, b) => a.timestamp - b.timestamp);

        if (combinedLogs.length === 0) {
            alert("No logs found in memory or DB.");
            updateStatus("Ready");
            return;
        }

        updateStatus(`Formatting ${combinedLogs.length} logs...`);
        const lines = [];
        lines.push(`Jukebox Debug Logs`);
        lines.push(`Generated: ${new Date().toLocaleString()}`);
        lines.push(`App Version: ${APP_VERSION}`);
        lines.push(`DB Status: ${dbStatus}`);
        lines.push(`User Agent: ${navigator.userAgent}`);
        lines.push(`Log Count: ${combinedLogs.length} (Memory: ${this.buffer.length}, DB: ${dbLogs.length})`);
        lines.push(`----------------------------------------\n`);

        combinedLogs.forEach(l => {
            const time = new Date(l.timestamp).toISOString();
            lines.push(`[${time}] [${l.type}] ${l.content}`);
        });

        const body = lines.join('\n');
        const now = new Date();
        const dateStr = now.toISOString().split('T')[0];
        const timeStr = now.toLocaleTimeString('ja-JP', { hour12: false }).replace(/:/g, '-');
        const filename = `jukebox_logs_${dateStr}_${timeStr}.txt`;
        const blob = new Blob([body], { type: 'text/plain' });
        const file = new File([blob], filename, { type: 'text/plain' });

        // 基本的なシェア情報
        const shareData = {
            title: 'Jukebox Logs',
            text: (body.length < 100000) ? body : "Logs are attached as a file due to size (full log exceeds 100KB)."
        };

        updateStatus("Launching Share Menu...");

        // ファイル共有がサポートされているか確認
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
            try {
                await navigator.share({
                    ...shareData,
                    files: [file]
                });
                updateStatus("Logs shared (with file).");
            } catch (err) {
                if (err.name !== 'AbortError') {
                    this.error("File share failed:", err);
                    this.tryTextShare(shareData, blob, filename);
                }
            }
        } else {
            // ファイル未対応の場合、テキストのみでのシェアを試みる
            this.tryTextShare(shareData, blob, filename);
        }
    },
    async tryTextShare(shareData, blob, filename) {
        if (navigator.share) {
            try {
                await navigator.share(shareData);
                updateStatus("Logs shared (text only).");
            } catch (err) {
                if (err.name !== 'AbortError') {
                    this.fallbackDownload(blob, filename);
                }
            }
        } else {
            this.fallbackDownload(blob, filename);
        }
    },
    fallbackDownload(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        updateStatus("Logs downloaded (Share API not supported).");
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
        const version = APP_VERSION;
        const appVersionEl = document.getElementById('app-version');
        if (appVersionEl) appVersionEl.innerText = version;
    } catch (err) {
        console.error("[UI] syncUI failed to update playback state:", err);
    }
};

// スクリプト読み込み直後から開始
setInterval(syncUI, 200);
document.addEventListener('visibilitychange', syncUI);
window.addEventListener('focus', syncUI);

/**
 * トークンの有効期限をチェックし、必要であればサイレントリフレッシュを行う (v63: 非同期対応)
 */
async function ensureValidToken(isBackground = false, forceRefresh = false) {
    const storedToken = localStorage.getItem('gdrive_token');
    const now = Date.now();
    let needsRefresh = forceRefresh;
    tokenIsMandatory = !isBackground;

    if (!storedToken) {
        needsRefresh = true;
        tokenIsMandatory = true;
    } else if (!forceRefresh) {
        try {
            const tokenData = JSON.parse(storedToken);
            const remainingMs = tokenData.expires_at - now;
            
            if (!tokenData.expires_at || remainingMs <= 0) {
                needsRefresh = true;
                tokenIsMandatory = true;
            } else if (remainingMs < 300000) {
                // 本番設定: 残り5分を切ったら更新（予備の更新なので mandatory ではない）
                needsRefresh = true;
                tokenIsMandatory = false;
            }
        } catch (e) {
            console.error("[Auth] Failed to parse stored token:", e);
            needsRefresh = true;
            tokenIsMandatory = true;
        }
    }

    if (needsRefresh) {
        if (!isBackground || forceRefresh) {
            console.log(`[Auth] Token refresh triggered (force=${forceRefresh}, mandatory=${tokenIsMandatory}).`);
        }
        
        if (tokenResolve) {
            console.log("[Auth] Wait for existing token exchange/refresh...");
            await new Promise((res) => {
                const check = () => {
                    if (!tokenResolve) res();
                    else setTimeout(check, 100);
                };
                check();
            });
            return;
        }

        const storedTokenDataString = localStorage.getItem('gdrive_token');
        const storedTokenData = JSON.parse(storedTokenDataString || '{}');
        const refreshToken = storedTokenData.refresh_token;

        if (refreshToken) {
            if (!isBackground || forceRefresh) updateStatus("Refreshing authorization via proxy...");
            return new Promise((resolve, reject) => {
                tokenResolve = resolve;
                tokenReject = reject;
                
                // v86: Proxy fetch retry
                const fetchWithRetry = async (url, options, maxRetry = 3) => {
                    for (let i = 1; i <= maxRetry; i++) {
                        try {
                            console.log(`[Auth] Proxy fetch start: action=refresh (Attempt ${i}/${maxRetry})`);
                            const res = await fetch(url, options);
                            return res;
                        } catch (err) {
                            if (i === maxRetry) throw err;
                            console.warn(`[Auth] Proxy fetch attempt ${i} failed, retrying in ${i * 500}ms...`, err);
                            await new Promise(r => setTimeout(r, i * 500));
                        }
                    }
                };

                fetchWithRetry('./auth_proxy.cgi', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'refresh', refresh_token: refreshToken })
                })
                .then(res => {
                    console.log(`[Auth] Proxy fetch status: ${res.status} ${res.statusText}`);
                    return res.json();
                })
                .then(data => {
                    if (data.access_token) {
                        const now = Date.now();
                        const expiresAt = now + (data.expires_in * 1000);
                        localStorage.setItem('gdrive_token', JSON.stringify({
                            access_token: data.access_token,
                            refresh_token: refreshToken, // 引き継ぐ
                            expires_at: expiresAt
                        }));
                        gapi.client.setToken({ access_token: data.access_token });
                        console.log(`[Auth] Token refreshed successfully via proxy. Valid for ${data.expires_in}s. (Snippet: ${data.access_token.substring(0, 5)}...)`);
                        if (tokenResolve) tokenResolve();
                    } else {
                        console.error("[Auth] Proxy returned JSON error:", data);
                        throw new Error(data.error || "Failed to refresh token via proxy");
                    }
                })
                .catch(err => {
                    console.error("[Auth] Proxy refresh failed:", err);
                    if (tokenIsMandatory) {
                        if (tokenReject) tokenReject(err);
                        updateStatus("Auth failed. Re-authentication required.");
                    } else {
                        console.warn("[Auth] Pre-emptive refresh via proxy failed, continuing with current token.");
                        if (tokenResolve) tokenResolve();
                    }
                })
                .finally(() => {
                    tokenResolve = null;
                    tokenReject = null;
                });
            });
        } else {
            console.warn("[Auth] No refresh token found in storage.");
            if (tokenIsMandatory) {
                updateStatus("Authentication required.");
                authBtn.style.display = 'block';
                authBtn.disabled = false;
                throw new Error("No refresh token available");
            } else {
                console.warn("[Auth] Continuing with potentially expired token...");
            }
        }
    }
}

/**
 * v72: ヒント（hint）用のユーザー情報を取得
 */
async function fetchUserInfo() {
    try {
        if (!gapi.client.drive) return;
        const res = await gapi.client.drive.about.get({ fields: 'user' });
        if (res.result.user && res.result.user.emailAddress) {
            localStorage.setItem('gdrive_user_email', res.result.user.emailAddress);
            console.log("[Auth] Stored user email for hint:", res.result.user.emailAddress);
        }
    } catch (e) {
        console.warn("[Auth] Failed to fetch user info for hint:", e);
    }
}

async function checkTokenExpiry() {
    try {
        await ensureValidToken(true);
    } catch (e) {
        console.error("[Auth] checkTokenExpiry failed during background check:", e);
    }
}
setInterval(checkTokenExpiry, 60000); // 1分ごとにチェック

/**
 * GAPIリクエストを認証状態で実行し、401エラー時は自動リフレッシュして1回リトライする (v63)
 */
async function authorizedRequest(requestFunc) {
    await ensureValidToken(true);
    try {
        const res = await requestFunc();
        return res;
    } catch (err) {
        const errorCode = (err.result && err.result.error && err.result.error.code) || err.status || 'unknown';
        
        // 401 (Unauthorized) または Code -1 (Network Error on Android)
        if (errorCode === 401 || errorCode === -1) {
            console.warn(`[Auth] Auth/Network failure detected (Code: ${errorCode}). Retrying with fresh token...`);
            // v84: removeItemをせず、強制的にリフレッシュを試みる（リフレッシュトークンを維持するため）
            await ensureValidToken(true, true);
            return await requestFunc();
        }
        
        console.error(`[Auth] Request failed (Code: ${errorCode}):`, err);
        throw err;
    }
}

const authBtn = document.getElementById('auth_btn');
const selector = document.getElementById('playlist_selector');
const customSelectContainer = document.getElementById('custom_select_container');
const playlistSearch = document.getElementById('playlist_search');
const clearSearchBtn = document.getElementById('clear_search_btn');
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
    if (isInitAppDone) return;
    isInitAppDone = true;
    Logger.init(); // ロガーを最速で初期化
    updateStatus("Loading Program...");

    // jsmediatags の読み込み待機
    let retry = 0;
    while (retry < 50) {
        if (window.jsmediatags) break;
        await new Promise(r => setTimeout(r, 100));
        retry++;
    }

    if (window.jsmediatags) {
        updateStatus("Loading Program...");
    } else {
        updateStatus("Error: jsmediatags not found");
        return;
    }

    // v46: 初期状態をJS側でも強制（HTMLのキャッシュ対策）
    if (playlistSearch) {
        playlistSearch.disabled = true;
        playlistSearch.placeholder = "Loading DJ charts...";
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
                }
                // v62: song_ended コールバックを削除。
                // ネイティブ audio.onended（世代チェック付き）と監視タイマーに一本化することで、
                // 二重発火によるデッドロックを防止する。
            }
        });
    }

    try {
        updateStatus("Loading Google API...");
        await new Promise(r => gapi.load('client', r));
        updateStatus("Initializing Google Client...");
        await gapi.client.init({});
        updateStatus("Accessing Google Drive API...");
        await gapi.client.load('https://www.googleapis.com/discovery/v1/apis/drive/v3/rest');
        gapiInited = true;
    } catch (e) {
        console.error("[GAPI] Initialization or client load failed:", e);
        updateStatus("Google API Error (Check Console)");
    }

    tokenClient = google.accounts.oauth2.initCodeClient({
        client_id: CLIENT_ID, 
        scope: SCOPES,
        ux_mode: 'popup',
        access_type: 'offline', // リフレッシュトークンを取得するために必須
        callback: async (resp) => {
            if (resp.code) {
                updateStatus("Exchanging code for tokens...");
                authBtn.innerText = "Authenticating...";
                authBtn.disabled = true;
                try {
                    const res = await fetch('./auth_proxy.cgi', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ action: 'exchange', code: resp.code })
                    });
                    const data = await res.json();
                    
                    if (data.access_token) {
                        const now = Date.now();
                        const expiresAt = now + (data.expires_in * 1000);
                        localStorage.setItem('gdrive_token', JSON.stringify({
                            access_token: data.access_token,
                            refresh_token: data.refresh_token, // リフレッシュトークンを保存
                            expires_at: expiresAt
                        }));
                        gapi.client.setToken({ access_token: data.access_token });
                        
                        if (tokenResolve) {
                            tokenResolve();
                            tokenResolve = null;
                            tokenReject = null;
                        }

                        if (!discoveryStarted) {
                            discoveryStarted = true;
                            authBtn.disabled = true;
                            fetchUserInfo();
                            await startDiscovery();
                        } else {
                            console.log(`[Auth] Initial authorization successful. Valid for ${data.expires_in}s.`);
                            updateStatus("Authorization fixed.");
                            fetchUserInfo();
                        }
                    } else {
                        throw new Error(data.error || "Failed to exchange code");
                    }
                } catch (e) {
                    console.error("[Auth] Code exchange failed:", e);
                    updateStatus("Auth error: " + e.message);
                    if (tokenReject) {
                        tokenReject(e);
                        tokenResolve = null;
                        tokenReject = null;
                    }
                }
            } else if (resp.error) {
                console.error("[Auth] Code client returned error:", resp.error);
                if (tokenReject) {
                    tokenReject(new Error(resp.error));
                    tokenResolve = null;
                    tokenReject = null;
                }
            }
        }
    });

    // 保存されたトークンがあるか確認
    const storedToken = localStorage.getItem('gdrive_token');
    if (storedToken) {
        const tokenData = JSON.parse(storedToken);
        const now = new Date().getTime();
        // 有効期限内ならそのまま開始 (v75: リフレッシュトークンがあることが前提)
        if (tokenData.access_token && tokenData.expires_at > now + 300000) {
            const remainingSec = Math.round((tokenData.expires_at - now) / 1000);
            console.log(`[Auth] Using stored token (${remainingSec}s remaining).`);
            discoveryStarted = true; // キャッシュから開始
            gapi.client.setToken({ access_token: tokenData.access_token });
            authBtn.innerText = "Loading DJ charts...";
            authBtn.disabled = true;
            await startDiscovery();
        }
    }
    document.getElementById('custom-next').onclick = () => {
        playNextTrack();
    };
    document.getElementById('custom-prev').onclick = () => {
        const prevIndex = findValidTrackIndex(currentTrackIndex - 1, -1);
        if (prevIndex !== -1) {
            playWithAmplitude(prevIndex);
        } else {
            // 最悪でも0番目を目指す（playWithAmplitude内でvalidチェックされる）
            playWithAmplitude(0);
        }
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
        if (!discoveryStarted) {
            authBtn.disabled = false;
            authBtn.innerText = "Google Drive Auth";
            updateStatus("Ready");
        }
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

    const shareLogsBtn = document.getElementById('share-logs-btn');
    if (shareLogsBtn) {
        shareLogsBtn.onclick = () => Logger.export();
    }
}

authBtn.onclick = () => tokenClient.requestCode();

// 2. フォルダスキャン
async function startDiscovery() {
    updateStatus("Listing up DJ charts...");
    try {
        const res = await authorizedRequest(() => withTimeout(gapi.client.drive.files.list({
            q: "name = 'music_backup' and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
            fields: 'files(id)'
        }), 10000, "Discovery Project Root"));

        if (res.result.files && res.result.files.length > 0) {
            await findYearFolders(res.result.files[0].id);
        } else {
            updateStatus("Error: music_backup folder not found");
        }
    } catch (e) {
        console.error("[Discovery] Failed to find 'music_backup' root folder:", e);
        updateStatus("Discovery Error (Check Network/Auth)");
    }
}

async function findYearFolders(parentId) {
    const res = await authorizedRequest(() => withTimeout(gapi.client.drive.files.list({
        q: `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id, name)'
    }), 10000, "Listing Year Folders"));
    selector.innerHTML = '<option value="">Select DJ Chart...</option>';
    const yearFolders = res.result.files
        .filter(f => f.name.match(/^\d{4}$/) && parseInt(f.name) >= 2023)
        .sort((a, b) => b.name.localeCompare(a.name));

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

    // v46: カスタムセレクターを更新 & 有効化
    renderCustomPlaylistList();
    setupCustomSelectorEvents();
    if (playlistSearch) {
        playlistSearch.disabled = false;
        playlistSearch.placeholder = "Search DJ Chart...";
    }
    if (authBtn) authBtn.style.display = 'none';
    if (customSelectContainer) customSelectContainer.style.display = 'block';
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
            updatePlaylistSearchMarquee(); // v55: マーキー更新
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

    let lastSearchQuery = "";

    // 入力時のフィルタリング
    playlistSearch.oninput = (e) => {
        lastSearchQuery = e.target.value;
        const query = lastSearchQuery.toLowerCase();
        const items = customPlaylistList.querySelectorAll('.custom-playlist-item');
        let hasVisible = false;

        if (clearSearchBtn) {
            clearSearchBtn.style.display = lastSearchQuery.length > 0 ? 'block' : 'none';
        }

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

            // v48: 前回の検索ワードを復元（選んだリスト名で埋まるのを防ぐ）
            playlistSearch.value = lastSearchQuery;

            if (clearSearchBtn) {
                clearSearchBtn.style.display = lastSearchQuery.length > 0 ? 'block' : 'none';
            }

            // 入力中ならフィルタリング、空なら全表示
            const query = lastSearchQuery.toLowerCase();
            const items = customPlaylistList.querySelectorAll('.custom-playlist-item');
            items.forEach(item => {
                const text = item.innerText.toLowerCase();
                item.style.display = text.includes(query) ? 'block' : 'none';
            });
        }
        updatePlaylistSearchMarquee(); // v55
    };

    playlistSearch.onblur = () => {
        updatePlaylistSearchMarquee(); // v55
    };

    // 外側をクリックした時に閉じる
    document.addEventListener('click', (e) => {
        if (customSelectContainer && !customSelectContainer.contains(e.target)) {
            customPlaylistList.style.display = 'none';

            // v53: リストを閉じた際、現在選択中のチャート名に戻す
            const selectedOpt = selector.options[selector.selectedIndex];
            if (selectedOpt && selectedOpt.value !== "") {
                playlistSearch.value = selectedOpt.innerText;
                if (clearSearchBtn) clearSearchBtn.style.display = 'none';
                updatePlaylistSearchMarquee(); // v55
            }
        }
    });

    // キーボードナビゲーション（任意だが、使い勝手のために追加）
    playlistSearch.onkeydown = (e) => {
        if (e.key === 'Escape') {
            customPlaylistList.style.display = 'none';

            // v53: キャンセル時、現在選択中のチャート名に戻す
            const selectedOpt = selector.options[selector.selectedIndex];
            if (selectedOpt && selectedOpt.value !== "") {
                playlistSearch.value = selectedOpt.innerText;
                if (clearSearchBtn) clearSearchBtn.style.display = 'none';
            }

            playlistSearch.blur();
        }
    };

    if (clearSearchBtn) {
        clearSearchBtn.onclick = (e) => {
            e.stopPropagation();
            playlistSearch.value = '';
            lastSearchQuery = '';
            clearSearchBtn.style.display = 'none';
            const items = customPlaylistList.querySelectorAll('.custom-playlist-item');
            items.forEach(item => item.style.display = 'block');
            playlistSearch.focus();
        };
    }
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
    const res = await authorizedRequest(() => withTimeout(gapi.client.drive.files.list({
        q: `'${yearId}' in parents and name = 'tracks' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id)'
    }), 10000, "Finding tracks folder (" + yearName + ")"));

    // 返り値用の配列
    const results = { favs: [], regs: [] };

    for (const tf of res.result.files) {
        const jRes = await authorizedRequest(() => withTimeout(gapi.client.drive.files.list({
            q: `'${tf.id}' in parents and mimeType = 'application/json' and trashed = false`,
            fields: 'files(id, name)',
            pageSize: 1000
        }), 15000, "Listing JSON files (" + yearName + ")"));

        // v47: 最新のファイルから先に MetadataQueue に追加されるようソート
        jRes.result.files.sort((a, b) => b.name.localeCompare(a.name));

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
                if (updatedAt > 0 && (now - updatedAt) < REFLECTION_TIME_MS) {
                    isUpdated = true;
                }

                let displayLabel = formatPlaylistLabel(cached.label, isNew, isUpdated, cached.isIncomplete);

                opt.innerText = displayLabel;
                updateCustomItemLabel(opt.value, displayLabel);
                isFavoritesFile ? results.favs.push(opt) : results.regs.push(opt);

                // v47: 最適化 - favorites/不完全なリスト以外で、すでに名前があれば背景読み込みをスキップ
                const isUpdatedCheckNeeded = isFavoritesFile || cached.isIncomplete;
                if (!isUpdatedCheckNeeded) {
                    // 通常のチャートは一度名前が決まれば再取得不要

                    continue;
                }

                const folderYear = parseInt(yearName);
                const currentYear = new Date().getFullYear();
                if (folderYear < currentYear - 1) {
                    continue;
                }
            } else {
                const fallbackLabel = getFallbackLabel(file.name, yearName);
                opt.innerText = fallbackLabel;
                isFavoritesFile ? results.favs.push(opt) : results.regs.push(opt);
            }

            // 非同期で最新情報を取得
            MetadataQueue.add(async () => {
                try {
                    // console.log("Starting background metadata fetch:", file.name);

                    // v51.1/v63: 8秒で一度諦める。ただし一度だけリトライ。認証付与。
                    const fetchMeta = async (fileId, timeoutMs) => {
                        return authorizedRequest(() => withTimeout(gapi.client.request({
                            path: `https://www.googleapis.com/drive/v3/files/${fileId}`,
                            params: { alt: 'media' }
                        }), timeoutMs, "Fetch " + file.name));
                    };

                    let jData;
                    const maxRetries = 10;
                    for (let i = 1; i <= maxRetries; i++) {
                        try {
                            // v83: モバイル環境のためにタイムアウトを緩和
                            const timeoutMs = (i === 1) ? 15000 : 12000;
                            
                            // v83: リトライ時は少し待機（バックオフ）
                            if (i > 1) {
                                await new Promise(r => setTimeout(r, i * 500));
                            }
                            
                            jData = await fetchMeta(file.id, timeoutMs);
                            console.log(`[Success] Background fetch metadata for: ${file.name} (Attempt ${i}/${maxRetries})`);
                            break;
                        } catch (e) {
                            if (i === maxRetries) {
                                console.error(`[Give up] Background fetch failed after ${maxRetries} attempts for file: ${file.name} (ID: ${file.id})`);
                                return;
                            }
                            console.warn(`[Retry] Background fetch timeout or error, retrying (${i}/${maxRetries}) for: ${file.name}`);
                        }
                    }

                    // console.log("Received metadata response for:", file.name);

                    let d = jData.result;
                    if (typeof d === 'string') {
                        try { d = JSON.parse(d); } catch (e) { console.error("JSON Parse Error:", e); return; }
                    }

                    if (d && d.chart) {
                        // ... (ラベル生成とDB保存のロジックは変更なし)
                        // v50: ここは元から複雑なので一部省略して全体を維持
                        const playlistDate = d.date || (file.name.match(/^\d{4}-\d{2}-\d{2}/) || [""])[0];
                        const artist = String(d.chart_artist || "Unknown Artist").trim();
                        const title = String(d.chart_title || "Unknown Title").trim();
                        const isIncomplete = d.chart && d.chart.slice(0, 10).some(t => !t || !t.mp3_file || t.mp3_file.trim() === "");

                        let label = "";
                        const artistL = artist.toLowerCase();
                        const titleL = title.toLowerCase();
                        const aliases = { "micky more & andy tee": ["mm & at"], "dave lee zr": ["dave lee"], "dave lee": ["dave lee zr"] };
                        let isDuplicate = titleL.startsWith(artistL) || (aliases[artistL] && aliases[artistL].some(a => titleL.startsWith(a.toLowerCase())));
                        const isKoichiFav = artistL.includes("koichi masuda") && titleL.includes("favorites");

                        if (isKoichiFav) label = `${artist}'s ${title}`;
                        else if (isDuplicate) label = `${playlistDate} ${title}`;
                        else label = `${playlistDate} ${artist}'s ${title}`;

                        const now = Date.now();
                        const createdAt = (cached && cached.createdAt) ? cached.createdAt : now;
                        const isFavoritesFile = /favorites/i.test(file.name);
                        const isNew = (now - createdAt) < REFLECTION_TIME_MS;

                        let isUpdated = false;
                        let updatedAt = (cached && cached.updatedAt) ? cached.updatedAt : 0;

                        if (updatedAt > 0 && (now - updatedAt) < REFLECTION_TIME_MS) {
                            isUpdated = true;
                        }

                        let newlyUpdated = false;
                        if (cached) {
                            if (cached.playlistDate !== d.playlistDate) newlyUpdated = true;
                            if (cached.isIncomplete !== d.isIncomplete) newlyUpdated = true;

                            if (!newlyUpdated && (isFavoritesFile || cached.isIncomplete)) {
                                const oldChartSlice = cached.chart ? JSON.stringify(cached.chart.slice(0, 10)) : null;
                                const newChartSlice = JSON.stringify((d.chart || []).slice(0, 10));
                                if (oldChartSlice !== null && oldChartSlice !== newChartSlice) {
                                    newlyUpdated = true;
                                }
                            }
                        }

                        if (newlyUpdated) {
                            isUpdated = true;
                            updatedAt = now;
                        }

                        const displayLabel = formatPlaylistLabel(label, isNew, isUpdated, isIncomplete);
                        if (opt.innerText !== displayLabel) {
                            opt.innerText = displayLabel;
                            updateCustomItemLabel(opt.value, displayLabel);
                        }

                        // v58: 個々の曲の追加日時 (addedAt) を付与
                        const nowMs = Date.now();
                        const newChart = d.chart || [];
                        newChart.forEach(t => {
                            if (t && t.mp3_file) {
                                const cachedTrack = (cached && cached.chart) ? cached.chart.find(ct => ct && ct.mp3_file === t.mp3_file) : null;
                                t.addedAt = (cachedTrack && cachedTrack.addedAt) ? cachedTrack.addedAt : nowMs;
                            }
                        });

                        const hasRecentAdditions = newChart.some(t => t && t.addedAt && (nowMs - t.addedAt) < REFLECTION_TIME_MS);
                        const keepCache = isFavoritesFile || isIncomplete || hasRecentAdditions || (updatedAt > 0 && (nowMs - updatedAt) < REFLECTION_TIME_MS);

                        const cacheData = { label, playlistDate, isIncomplete, updatedAt, metaOnly: !keepCache };
                        if (keepCache) cacheData.chart = newChart;

                        await JukeboxDB.set(file.id, cacheData);
                        // console.log("Completed background metadata fetch:", displayLabel);
                    }
                } catch (err) {
                    console.error(`[Metadata] Failed to process background update for '${file.name}':`, err);
                } finally {
                    // console.log("Background task finished (released queue):", file.name);
                }
            });
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
        const res = await authorizedRequest(() => gapi.client.drive.files.get({ fileId: fileId, alt: 'media' }));
        const newChart = res.result.chart || [];
        const newDate = res.result.date || "";
        // v25: 1-10曲目に未完成があるか
        const newIsIncomplete = newChart.slice(0, 10).some(t => !t || !t.mp3_file || t.mp3_file.trim() === "");

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
                const oldMp3s = new Set(currentPlaylist.map(t => (t && t.mp3_file) ? t.mp3_file.split('/').pop() : "").filter(f => f));
                newChart.forEach(t => {
                    if (t && t.mp3_file) {
                        const bname = t.mp3_file.split('/').pop();
                        if (bname && !oldMp3s.has(bname)) {
                            currentNewMp3s.add(bname);
                        }
                    }
                });
            }

            // v58: ここでもバックグラウンドと同様に addedAt をマージする
            const nowMs = Date.now();
            newChart.forEach(t => {
                if (t && t.mp3_file) {
                    const cachedTrack = currentPlaylist.find(ct => ct && ct.mp3_file === t.mp3_file);
                    t.addedAt = (cachedTrack && cachedTrack.addedAt) ? cachedTrack.addedAt : nowMs;
                }
            });

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

        const nowMs = Date.now();
        const isFavoritesFile = selectedOpt && selectedOpt.dataset.fileName ? /favorites/i.test(selectedOpt.dataset.fileName) : false;
        const hasRecentAdditions = newChart.some(t => t && t.addedAt && (nowMs - t.addedAt) < REFLECTION_TIME_MS);
        const uAt = cached ? (cached.updatedAt || 0) : 0;
        const keepCache = isFavoritesFile || newIsIncomplete || hasRecentAdditions || ((nowMs - uAt) < REFLECTION_TIME_MS);

        await JukeboxDB.set(fileId, { label, chart: newChart, playlistDate: newDate, isIncomplete: newIsIncomplete, metaOnly: !keepCache, updatedAt: uAt });

    } catch (err) {
        console.error(`[Playlist] Error loading DJ Chart (FileID: ${fileId}):`, err);
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

        // v42/v58: Newアイコンの判定 (addedAtを優先)
        let showNewIcon = false;
        if (hasFile) {
            if (currentIsNewPlaylist) {
                showNewIcon = true;
            } else if (track.addedAt && (Date.now() - track.addedAt) < REFLECTION_TIME_MS) {
                // v58: キャッシュの追加日時が15日以内なら NEW
                showNewIcon = true;
            } else {
                // 後方互換性：addedAtがない場合でも直近の差分があれば NEW
                const bname = track.mp3_file.split('/').pop();
                if (bname && currentNewMp3s.has(bname)) {
                    showNewIcon = true;
                }
            }
        }
        const newIconHtml = showNewIcon ? '<span style="color: #55b560; margin-right: 4px; font-size: 0.9em;">🆕</span>' : '';

        li.innerHTML = `
            <div class="meta-container">
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

        if (el.dataset.originalText) {
            el.innerText = el.dataset.originalText;
        } else {
            el.dataset.originalText = el.innerText;
        }

        el.classList.remove('is-marquee');
        el.style.animationDuration = ''; // reset

        setTimeout(() => {
            // 文字の幅が、表示窓(wrapper)の幅より大きいか判定
            if (el.scrollWidth > wrapper.offsetWidth) {
                const gapText = '\u00A0\u00A0\u00A0\u00A0\u00A0';
                el.innerText = el.dataset.originalText + gapText + el.dataset.originalText + gapText;

                // ピクセル数に応じてアニメーション速度を一定に保つ (約40px/秒)
                const duration = (el.scrollWidth / 2) / 40;
                el.style.animationDuration = Math.max(5, duration) + 's';
                el.classList.add('is-marquee');
            }
        }, 100);
    };

    checkMarquee('now-playing-title');
    checkMarquee('now-playing-artist');
    updatePlaylistSearchMarquee(); // v55
}

/**
 * playlist_search 入力フィールドのテキストが溢れている場合にマーキー効果を適用する
 */
function updatePlaylistSearchMarquee() {
    const input = document.getElementById('playlist_search');
    const marquee = document.getElementById('playlist_search_marquee');
    const windowEl = document.querySelector('.playlist-search-marquee-window');
    if (!input || !marquee || !windowEl) return;

    // フォーカス中、または入力が空の場合はマーキーを停止して入力を表示
    if (document.activeElement === input || !input.value) {
        marquee.classList.remove('is-marquee');
        input.classList.remove('marquee-active');
        marquee.style.animationDuration = '';
        return;
    }

    // 表示用テキストを設定
    marquee.innerText = input.value;
    marquee.classList.remove('is-marquee');
    marquee.style.animationDuration = '';

    // テキストがウィンドウ幅を超えているか判定
    setTimeout(() => {
        if (marquee.scrollWidth > windowEl.offsetWidth) {
            const gapText = '\u00A0\u00A0\u00A0\u00A0\u00A0';
            marquee.innerText = input.value + gapText + input.value + gapText;
            const duration = (marquee.scrollWidth / 2) / 40;
            marquee.style.animationDuration = Math.max(5, duration) + "s";

            marquee.classList.add('is-marquee');
            input.classList.add('marquee-active');
        } else {
            input.classList.remove('marquee-active');
        }
    }, 50);
}

/**
 * 現在のインデックスから、指定された方向（+1 または -1）に
 * 有効な曲（mp3_fileあり）を探す。見つからなければ -1 を返す。
 */
function findValidTrackIndex(startIndex, direction = 1) {
    if (!currentPlaylist || currentPlaylist.length === 0) return -1;

    let idx = startIndex;
    let searchCount = 0;
    const maxSearch = currentPlaylist.length;

    while (searchCount < maxSearch) {
        // インデックスの範囲外チェックとループ処理
        if (idx >= currentPlaylist.length) {
            if (isRepeatOn) {
                idx = 0;
            } else {
                return -1;
            }
        } else if (idx < 0) {
            if (isRepeatOn) {
                idx = currentPlaylist.length - 1;
            } else {
                return -1;
            }
        }

        const track = currentPlaylist[idx];
        if (track && track.mp3_file && track.mp3_file.trim() !== "") {
            return idx;
        }

        idx += direction;
        searchCount++;
    }

    return -1;
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
                if (t && t.mp3_file && t.mp3_file.trim() !== "") {
                    validIndices.push(i);
                }
            });

            if (validIndices.length > 0) {
                let filtered = validIndices.filter(i => i !== currentIndex);
                if (filtered.length === 0) filtered = validIndices;
                targetIndex = filtered[Math.floor(Math.random() * filtered.length)];
            }
        } else {
            // 次の有効なインデックスを探す
            targetIndex = findValidTrackIndex(currentIndex + 1, 1);
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
        updateStatus(`⏳ Pre-fetching: ${track.title}`);

        // v50: まずキャッシュを確認
        let targetId = await JukeboxDB.getFileId(fileName);

        if (!targetId) {
            // 2. キャッシュになければ Google Drive からファイルIDを特定 (v63: 認証追加)
            const fRes = await authorizedRequest(() => gapi.client.drive.files.list({
                q: `name = '${fileName.replace(/'/g, "\\'")}' and trashed = false`,
                fields: 'files(id)', pageSize: 1
            }));

            if (fRes.result.files && fRes.result.files.length > 0) {
                targetId = fRes.result.files[0].id;
                await JukeboxDB.setFileId(fileName, targetId);
            }
        }

        if (targetId) {
            // 3. fetch API でバイナリ直接取得 (CPU/メモリ・スパイク対策)
            const memBefore = performance.memory ? (performance.memory.usedJSHeapSize / 1024 / 1024).toFixed(1) : 'N/A';
            const startMs = performance.now();

            const blob = await authorizedRequest(async () => {
                const tokenData = JSON.parse(localStorage.getItem('gdrive_token'));
                const res = await fetch(`https://www.googleapis.com/drive/v3/files/${targetId}?alt=media`, {
                    headers: { 'Authorization': 'Bearer ' + tokenData.access_token }
                });
                if (!res.ok) {
                    if (res.status === 401) throw { status: 401 };
                    throw new Error(`Fetch failed with status: ${res.status}`);
                }
                return await res.blob();
            });

            const endMs = performance.now();
            const memAfter = performance.memory ? (performance.memory.usedJSHeapSize / 1024 / 1024).toFixed(1) : 'N/A';
            console.log(`[Performance] Fetch Prefetch taking ${Math.round(endMs - startMs)}ms. Heap: ${memBefore}MB -> ${memAfter}MB`);

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
            updateStatus(`✅ Pre-fetched: ${track.title}`);
            setTimeout(() => {
                const audio = getRealAudio();
                if (audio && !audio.paused && currentTrackIndex >= 0 && currentPlaylist[currentTrackIndex]) {
                    updateStatus(`Playing: ${currentPlaylist[currentTrackIndex].title}`);
                } else {
                    updateStatus("Ready");
                }
            }, 3000);
        } else {
            console.warn(`Prefetch failed: File not found (${fileName})`);
            updateStatus(`⚠️ Pre-fetch failed: ${fileName}`);
            setTimeout(() => {
                const audio = getRealAudio();
                if (audio && !audio.paused && currentTrackIndex >= 0 && currentPlaylist[currentTrackIndex]) {
                    updateStatus(`Playing: ${currentPlaylist[currentTrackIndex].title}`);
                } else {
                    updateStatus("Ready");
                }
            }, 3000);
        }
    } catch (e) {
        console.error(`[Prefetch] Failed to prefetch track '${track ? track.title : 'unknown'}':`, e);
        updateStatus(`⚠️ Pre-fetch error: ${track ? track.title : 'unknown'}`);
        setTimeout(() => {
            const audio = getRealAudio();
            if (audio && !audio.paused && currentTrackIndex >= 0 && currentPlaylist[currentTrackIndex]) {
                updateStatus(`Playing: ${currentPlaylist[currentTrackIndex].title}`);
            } else {
                updateStatus("Ready");
            }
        }, 3000);
    } finally {
        isPrefetching = false;
    }
}

// --- 再生制御の統合ヘルパー ---
let isNextTrackPending = false; // v62: 二重呼び出し防止フラグ
function playNextTrack() {
    // v62: 二重呼び出し防止（ネイティブonendedと監視タイマーの競合対策）
    if (isNextTrackPending) {
        console.warn("playNextTrack: Already pending. Ignoring duplicate call.");
        return;
    }
    isNextTrackPending = true;
    // フラグは playWithAmplitude 内の startPlayback 完了後にリセットされる
    // 万が一リセットされない場合の安全策として 5秒後に自動リセット
    setTimeout(() => { isNextTrackPending = false; }, 5000);

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
            if (t && t.mp3_file && t.mp3_file.trim() !== "") {
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
        // --- 1. 指定されたインデックスまたはそれ以降の「有効な曲」を探す ---
        const validIndex = findValidTrackIndex(index, 1);

        if (validIndex === -1) {
            updateStatus("End of Playlist");
            isLoadingTrack = false;
            return;
        }

        if (validIndex !== index) {
            console.log(`[Gen ${thisGen}] Skipping to index ${validIndex} (No valid file at ${index}).`);
            index = validIndex;
        }

        const track = currentPlaylist[index];
        currentTrackIndex = index; // 現在のインデックスを確定

        // --- 2. 先読み(Prefetch)済みのURLがあるかチェック ---
        if (index === nextTrackIndex && nextBlobUrl) {


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

        // v50: まずキャッシュを確認
        let targetId = await JukeboxDB.getFileId(fileName);

        if (!targetId) {
            updateStatus(`Searching: ${fileName}`);

            // v50: タイムアウト付きの検索 (10秒) / v63: 認証追加
            const searchDrive = async () => {
                const fRes = await authorizedRequest(() => gapi.client.drive.files.list({
                    q: `name = '${fileName.replace(/'/g, "\\'")}' and trashed = false`,
                    fields: 'files(id)', pageSize: 1
                }));
                return (fRes.result.files && fRes.result.files.length > 0) ? fRes.result.files[0].id : null;
            };


            try {
                targetId = await withTimeout(searchDrive(), 10000, "Search Drive " + fileName);
                if (targetId) {
                    await JukeboxDB.setFileId(fileName, targetId);
                }
            } catch (err) {
                console.error(`[Search] File query failed for '${fileName}':`, err);
                updateStatus("Search Timeout. Retrying...");
                // 1回だけリトライ
                await new Promise(r => setTimeout(r, 2000));
                try {
                    targetId = await withTimeout(searchDrive(), 15000, "Search Drive (Deep) " + fileName);
                    if (targetId) await JukeboxDB.setFileId(fileName, targetId);
                } catch (e2) {
                    console.error(`[Search] Retry also failed for '${fileName}':`, e2);
                }
            }
        }

        if (targetId) {
            updateStatus(`Downloading: ${track.title}`);

            const fetchFile = async () => {
                return await authorizedRequest(async () => {
                    const tokenData = JSON.parse(localStorage.getItem('gdrive_token'));
                    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${targetId}?alt=media`, {
                        headers: { 'Authorization': 'Bearer ' + tokenData.access_token }
                    });
                    if (!res.ok) {
                        if (res.status === 401) throw { status: 401 };
                        throw new Error(`Fetch failed with status: ${res.status}`);
                    }
                    return await res.blob();
                });
            };

            const downloadTimeout = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error("Download Timeout")), ms));

            let blob;
            const memBefore = performance.memory ? (performance.memory.usedJSHeapSize / 1024 / 1024).toFixed(1) : 'N/A';
            const startMs = performance.now();
            try {
                // v50: ダウンロードにもタイムアウト (30秒)
                blob = await Promise.race([fetchFile(), downloadTimeout(30000)]);
            } catch (err) {
                console.error(`[Download] File download failed for '${track.title}' (FileID: ${targetId}):`, err);
                updateStatus(`Download Timeout: ${track.title}`);
                isLoadingTrack = false;
                return;
            }
            const endMs = performance.now();
            const memAfter = performance.memory ? (performance.memory.usedJSHeapSize / 1024 / 1024).toFixed(1) : 'N/A';
            console.log(`[Performance] Fetch Playback taking ${Math.round(endMs - startMs)}ms. Heap: ${memBefore}MB -> ${memAfter}MB`);

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
            // 短い待ち時間を置いてから次へ（無限ループ防止）
            await new Promise(r => setTimeout(r, 1000));
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
        Logger.monitorAudio(audio);
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
            console.log("[MediaSession] User clicked 'Play' from OS controls");
            try {
                await Amplitude.play();
                navigator.mediaSession.playbackState = "playing";
            } catch (err) {
                console.error("MediaSession Play Error:", err);
            }
        });
        navigator.mediaSession.setActionHandler('pause', () => {
            console.log("[MediaSession] User clicked 'Pause' from OS controls");
            try {
                Amplitude.pause();
                navigator.mediaSession.playbackState = "paused";
            } catch (err) {
                console.error("MediaSession Pause Error:", err);
            }
        });
        navigator.mediaSession.setActionHandler('previoustrack', () => {
            console.log("[MediaSession] User clicked 'Previous' from OS controls");
            const prevIndex = findValidTrackIndex(currentTrackIndex - 1, -1);
            if (prevIndex !== -1) {
                playWithAmplitude(prevIndex);
            } else {
                // 有効な前曲がない場合は、リピートオフなら最初へ、オンなら最後へ（findValidで処理済み）
                playWithAmplitude(0);
            }
        });
        navigator.mediaSession.setActionHandler('nexttrack', () => { 
            console.log("[MediaSession] User clicked 'Next' from OS controls");
            playNextTrack(); 
        });
    }

    // --- UI更新 ---
    const titleEl = document.getElementById('now-playing-title');
    const artistEl = document.getElementById('now-playing-artist');
    if (titleEl) {
        titleEl.innerText = fullTitle;
        delete titleEl.dataset.originalText;
    }
    if (artistEl) {
        artistEl.innerText = track.artist || "";
        delete artistEl.dataset.originalText;
    }

    if (typeof updateMarquee === 'function') updateMarquee();

    document.querySelectorAll('#track_list li').forEach(el => el.classList.remove('playing'));
    const activeLi = document.getElementById(`track-${index}`);
    if (activeLi) activeLi.classList.add('playing');

    updateStatus('Playing');
    isLoadingTrack = false;
    isNextTrackPending = false; // v61: 次曲遷移の二重呼び出し防止フラグをリセット

    console.log(`[Gen ${gen}] Starting prefetch...`);
    prefetchNextTrack(index);

    // --- 最終手段：監視タイマー ---
    if (window.autoNextTimer) {
        clearInterval(window.autoNextTimer);
        window.autoNextTimer = null;
    }
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
