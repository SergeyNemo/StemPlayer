const POLL_INTERVAL = 2000;
const TERMINAL_STATES = new Set(['complete', 'error', 'stopped']);

const $ = (selector) => document.querySelector(selector);

const els = {
    uploadZone: $('#upload-zone'),
    tracksView: $('#tracks-view'),
    dropzone: $('#dropzone'),
    pickBtn: $('#pick-btn'),
    fileInput: $('#file-input'),
    uploadProgress: $('#upload-progress'),
    uploadStatus: $('#upload-status'),
    uploadFill: $('#upload-fill'),
    addBtn: $('#add-btn'),
    processBtn: $('#process-btn'),
    stopBtn: $('#stop-btn'),
    progressBar: $('#progress-bar'),
    overallProgress: $('#overall-progress'),
    tbody: $('#tracks-tbody'),
    logLine: $('#log-line'),
    stemsLink: $('#nav-stemgen'),
    homeLink: $('#nav-home'),
    // Модалка подтверждения удаления (delete.js)
    delOverlay: $('#del-overlay'),
    delName: $('#del-name'),
    delIcon: $('#del-icon'),
    delCancel: $('#del-cancel'),
    delConfirm: $('#del-confirm'),
};

const state = {
    rows: [],                 // строки из get_inbox
    rowRefs: new Map(),       // name -> {tr, nameCell, bpmCell, keyCell, durCell, delBtn, playBtn, playWrapper, playFill, playTime, playBar, busyState}
    sort: {},                 // { key: 'num'|'track'|'bpm'|'key'|'duration', dir: 1|-1|0 }
    mode: 'idle',             // 'idle' | 'processing' | 'poll' | 'done'
    pollTimer: null,
    stopping: false,
    sawRun: false,            // видели ли статус 'running' (для детекта «run исчез»)
    // Ждём первого 'running' после нажатия «Обработать». До этого момента
    // терминальный статус в progress.json — остаток ПРОШЛОГО прогона.
    awaitingRun: false,
    launchedAt: 0,            // когда нажали «Обработать» (мс)
    play: { audio: null, name: null },
};

const api = { base: 'analysisApi.php' };

export { POLL_INTERVAL, TERMINAL_STATES, els, state, api };
