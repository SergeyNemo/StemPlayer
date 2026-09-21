import { els, state, api } from './store.js';

function fetchJson(action, options) {
    return fetch(`${api.base}?action=${encodeURIComponent(action)}`, options)
        .then(async (res) => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
        });
}

function fmtDuration(sec) {
    if (sec == null || !Number.isFinite(Number(sec))) return '—';
    const s = Math.round(Number(sec));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

function setBadge(status) {
    els.badge.dataset.state = status;
    els.badge.textContent = (status || 'idle').replace('_', ' ');
}

function appendLog(entry) {
    const { time, type, message } = entry || {};
    const row = document.createElement('div');
    row.className = 'log';

    const timeEl = document.createElement('span');
    timeEl.className = 'time';
    timeEl.textContent = time || '--:--:--';

    const badgeEl = document.createElement('span');
    badgeEl.className = `badge badge-${['info', 'success', 'error', 'warning'].includes(type) ? type : 'info'}`;
    badgeEl.textContent = (type || 'info').toUpperCase();

    const msgEl = document.createElement('span');
    msgEl.textContent = message;

    row.append(timeEl, badgeEl, msgEl);
    els.console.appendChild(row);
    els.console.scrollTop = els.console.scrollHeight;

    if (type === 'error' && els.console.hidden) toggleLog(true);
}

function renderLogs(logs = []) {
    for (let i = state.renderedLogs; i < logs.length; i++) appendLog(logs[i]);
    state.renderedLogs = Math.max(state.renderedLogs, logs.length);
}

function updateOverall(processed, total) {
    const t = total ?? 0;
    const d = processed ?? 0;
    const percent = t > 0 ? Math.min(100, Math.round((d / t) * 100)) : 0;

    els.progressFill.style.width = `${percent}%`;
    els.progressLabel.textContent = t > 0 ? `${percent}% · ${d}/${t}` : '0%';
    els.progressFill.classList.toggle('is-running', state.mode === 'processing');
}

function buildNameNode(row) {
    const wrap = document.createElement('div');
    wrap.className = 'name-stack';

    const line1 = document.createElement('span');
    line1.className = 'track-title';
    line1.textContent = row.title || row.name;

    const line2 = document.createElement('span');
    line2.className = 'track-artist';
    line2.textContent = `${row.artist || 'Неизвестен'} · ${row.name}`;

    wrap.append(line1, line2);
    return wrap;
}

function toggleLog(force) {
    const show = typeof force === 'boolean' ? force : els.console.hidden;
    els.console.hidden = !show;
    els.logToggle.classList.toggle('is-open', show);
    if (show) els.console.scrollTop = els.console.scrollHeight;
}

export { fetchJson, fmtDuration, setBadge, appendLog, renderLogs, updateOverall, buildNameNode, toggleLog };