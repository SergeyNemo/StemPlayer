const POLL_INTERVAL = 2000;
const TERMINAL_STATES = new Set(['complete', 'error', 'stopped']);

const $ = (selector) => document.querySelector(selector);

const els = {
    badge: $('#status-badge'),
    uploadZone: $('#upload-zone'),
    tracksView: $('#tracks-view'),
    dropzone: $('#dropzone'),
    pickBtn: $('#pick-btn'),
    fileInput: $('#file-input'),
    uploadProgress: $('#upload-progress'),
    uploadStatus: $('#upload-status'),
    uploadFill: $('#upload-fill'),
    processBtn: $('#process-btn'),
    stopBtn: $('#stop-btn'),
    queueCheck: $('#queue-check'),
    trackTotalText: $('#track-total-text'),
    progressFill: $('#progress-fill'),
    progressLabel: $('#progress-label'),
    banner: $('#banner'),
    bannerText: $('#banner-text'),
    bannerFoldersToggle: $('#banner-folders-toggle'),
    bannerFolders: $('#banner-folders'),
    tbody: $('#tracks-tbody'),
    logToggle: $('#log-toggle'),
    console: $('#console'),
};

const state = {
    rows: [],                 // строки из get_inbox
    rowRefs: new Map(),       // name -> {tr, nameCell, bpmCell, keyCell, durCell, playBtn, playWrapper, playFill, playTime, playBar}
    sort: {},                 // { key: 'num'|'track'|'bpm'|'key'|'duration', dir: 1|-1|0 }
    mode: 'idle',             // 'idle' | 'processing' | 'poll' | 'done'
    es: null,
    pollTimer: null,
    liveTimer: null,
    fallbackFired: false,
    stopping: false,
    renderedLogs: 0,
    play: { audio: null, name: null },
};

const api = { base: 'analysisApi.php' };

export { POLL_INTERVAL, TERMINAL_STATES, $, els, state, api };