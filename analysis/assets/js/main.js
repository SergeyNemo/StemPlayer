import { els, state } from './store.js?v=15';
import { fetchJson, setBadge, renderLogs, appendLog } from './utils.js?v=15';
import { initPlayer } from './player.js?v=15';
import { switchToUpload, switchToTracks } from './views.js?v=15';
import { sortBy } from './sort.js?v=15';
import { bindUpload } from './upload.js?v=15';
import { startProcessing, requestStop, startPolling } from './analysis.js?v=15';

// ---------- Инициализация ----------

function init() {
    bindUpload();
    initPlayer();

    els.processBtn.addEventListener('click', startProcessing);
    els.stopBtn.addEventListener('click', requestStop);
    els.addBtn.addEventListener('click', () => els.fileInput.click());

    document.querySelectorAll('th[data-sort]').forEach((th) =>
        th.addEventListener('click', () => sortBy(th.dataset.sort))
    );

    Promise.all([
        fetchJson('get_inbox'),
        fetchJson('get_progress'),
    ])
        .then(([inbox, progress]) => {
            // На старте отражаем только живой прогон. «complete» в progress.json —
            // это остаток прошлого запуска: paints COMPLETE на 3 секунды и
            // путает («я же ничего не нажимал»). Настоящий финал покажет
            // опрос, когда закончится прогон в этой сессии.
            setBadge(progress.status === 'running' ? 'running' : 'idle');
            state.stemgenRunning = !!(inbox.stemgen_running || progress.stemgen_running);

            if (inbox.rows && inbox.rows.length === 0) {
                switchToUpload();
                return;
            }

            state.rows = inbox.rows;
            switchToTracks(state.rows);

            if (progress.status === 'running') {
                // в другом окне уже идёт обработка — просто следуем
                renderLogs(progress.last_message);
                appendLog({ time: '--:--:--', type: 'warning', message: 'Обнаружен идущий анализ (другое окно). Слежу за прогрессом.' });
                startPolling(false);
            }
        })
        .catch(() => {
            switchToUpload();
        });
}

document.addEventListener('DOMContentLoaded', init);