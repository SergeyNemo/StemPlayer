import { state, els, TERMINAL_STATES, POLL_INTERVAL, api } from './store.js';
import { fetchJson, appendLog, renderLogs, setBadge, updateOverall } from './utils.js';
import { rowProcessing, rowProgress, rowDone, rowError, rebuildRowIdle } from './table.js';
import { showBanner, hideBanner } from './views.js';
import { refreshInbox } from './upload.js';

// ---------- SSE-поток ----------

function startProcessing() {
    state.mode = 'processing';
    state.fallbackFired = false;
    state.stopping = false;
    stopPolling();
    closeStream();

    els.processBtn.disabled = true;
    els.stopBtn.hidden = false;
    hideBanner();
    els.console.innerHTML = '';
    state.renderedLogs = 0;
    setBadge('running');
    updateOverall(0, state.rows.length);

    // сбрасываем все строки в «ожидание»
    state.rowRefs.forEach((ref) => {
        ref.tr.classList.remove('row-done', 'row-error', 'row-processing');
        rebuildRowIdle(ref);
        ref.bpmCell.textContent = '—';
        ref.keyCell.textContent = '—';
        ref.durCell.textContent = '—';
    });

    const es = new EventSource(`${api.base}?action=stream_analyze`);
    state.es = es;

    const events = {
        log: (d) => appendLog(d),
        progress: (d) => updateOverall(d.processed, d.total),
        track_start: (d) => rowProcessing(d.name),
        track_progress: (d) => rowProgress(d.name, d),
        track_done: (d) => rowDone(d.name, d),
        track_error: (d) => rowError(d.name, d.message),
        idle: (d) => {
            appendLog({ time: '--:--:--', type: 'warning', message: d.message || 'Нет файлов для обработки.' });
            finishProcessing('idle');
        },
        already_running: (d) => {
            appendLog({ time: '--:--:--', type: 'warning', message: d.message || 'Анализ уже выполняется в другом окне.' });
            closeStream();
            startPolling(false);
        },
        done: (d) => {
            const wasStopped = d && d.status === 'stopped';
            updateOverall(wasStopped ? (d.processed ?? 0) : d.total, d.total);
            const message = wasStopped
                ? `Остановлено: обработано ${d.sorted ?? 0} из ${d.total ?? 0} файлов.`
                : `Готово: обработано ${d.sorted ?? 0} из ${d.total ?? 0} файлов.`;
            showBanner(message, d.folders || []);
            appendLog({ time: '--:--:--', type: 'info', message });
            finishProcessing(wasStopped ? 'stopped' : 'complete');
            refreshInbox();
        },
        error: (d) => {
            appendLog({ time: '--:--:--', type: 'error', message: d.message || 'Ошибка сервера.' });
            finishProcessing('error');
        },
    };

    Object.entries(events).forEach(([name, handler]) =>
        es.addEventListener(name, (e) => {
            try { handler(JSON.parse(e.data)); } catch { /* повреждённое событие */ }
        })
    );

    es.onerror = () => fallbackToPolling();

    // Страховка на случай буферизации стрима: полоса и статус всё равно
    // двигаются из progress.json, который сервер пишет параллельно циклу.
    startLivePoll();
}

function fallbackToPolling() {
    if (state.mode !== 'processing') return;
    appendLog({ time: '--:--:--', type: 'warning', message: 'Поток реального времени прервался, переключаюсь на опрос…' });
    startPolling(true);
}

function finishProcessing(status) {
    closeStream();
    stopPolling();
    stopLivePoll();
    state.mode = 'done';
    state.stopping = false;
    els.processBtn.disabled = false;
    els.stopBtn.hidden = true;
    setBadge(status); // complete/error/idle/stopped — все терминальные состояния подсвечиваем
}

function closeStream() {
    if (state.es) {
        state.es.close();
        state.es = null;
    }
}

// ---------- Живой опрос прогресса (страховка от буферизации SSE) ----------

function startLivePoll() {
    stopLivePoll();
    state.liveTimer = setInterval(pollLive, 500);
}

function stopLivePoll() {
    if (state.liveTimer !== null) {
        clearInterval(state.liveTimer);
        state.liveTimer = null;
    }
}

function pollLive() {
    if (state.mode !== 'processing') {
        stopLivePoll();
        return;
    }

    fetchJson('get_progress')
        .then((p) => {
            if (state.mode !== 'processing') return;

            const status = p.status || 'idle';
            if (TERMINAL_STATES.has(status)) {
                stopLivePoll();
                return;
            }

            updateOverall(p.processed, p.total);
            renderLogs(p.log || []);

            const live = p.live;
            if (live && live.name) {
                rowProgress(live.name, live);
            } else if (p.current_file) {
                rowProcessing(p.current_file);
            }
        })
        .catch(() => {});
}

// ---------- Остановка анализа ----------

function requestStop() {
    state.stopping = true;
    els.stopBtn.disabled = true;
    els.stopBtn.textContent = 'Останавливаю…';

    appendLog({ time: '--:--:--', type: 'warning', message: 'Запрошена остановка: завершаю текущий трек…' });

    fetchJson('stop_analysis')
        .then(() => {
            // Истинное завершение придёт событием done(status: stopped)
            // либо терминальным состоянием через опрос.
        })
        .catch((err) => {
            els.stopBtn.disabled = false;
            els.stopBtn.textContent = '■ Стоп';
            appendLog({ time: '--:--:--', type: 'error', message: `Не удалось остановить: ${err.message}` });
        });
}

// ---------- Фолбэк: опрос ----------

function startPolling(launchAnalysis) {
    stopPolling();
    state.mode = 'poll';
    els.processBtn.disabled = true;
    els.stopBtn.hidden = false;

    if (launchAnalysis && !state.fallbackFired) {
        state.fallbackFired = true;
        fetchJson('analyze_inbox').catch(() => {});
    }

    state.pollTimer = setInterval(pollProgress, POLL_INTERVAL);
    pollProgress();
}

function stopPolling() {
    if (state.pollTimer !== null) {
        clearInterval(state.pollTimer);
        state.pollTimer = null;
    }
}

function pollProgress() {
    fetchJson('get_progress')
        .then((progress) => {
            const status = progress.status || 'idle';
            setBadge(status);
            updateOverall(progress.processed, progress.total);
            renderLogs(progress.log || []);

            if (status === 'running') {
                const live = progress.live;
                if (live && live.name) {
                    rowProgress(live.name, live);
                } else {
                    const cur = progress.current_file;
                    state.rowRefs.forEach((ref, name) => {
                        if (cur && name === cur) rowProcessing(name);
                    });
                }
                return;
            }

            if (TERMINAL_STATES.has(status)) {
                stopPolling();
                els.processBtn.disabled = false;
                els.stopBtn.hidden = true;
                state.mode = 'done';
                updateOverall(progress.processed, progress.total);

                if (status === 'complete') {
                    showBanner('Анализ завершён.', progress.folders || []);
                    refreshInbox();
                } else if (status === 'stopped') {
                    showBanner('Анализ остановлен.', progress.folders || []);
                    refreshInbox();
                }
            }
        })
        .catch(() => {
            stopPolling();
            state.mode = 'idle';
            els.processBtn.disabled = false;
        });
}

export { startProcessing, requestStop, startPolling };