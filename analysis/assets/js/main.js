import { els, state } from './store.js?v=93';
import { fetchJson, renderLogs } from './utils.js?v=93';
import { initPlayer } from './player.js?v=93';
import { switchToUpload, switchToTracks } from './views.js?v=93';
import { sortBy } from './sort.js?v=93';
import { bindUpload } from './upload.js?v=93';
import { initDelete } from './delete.js?v=93';
import { startProcessing, requestStop, startPolling } from './analysis.js?v=93';

// ---------- Инициализация ----------

function init() {
    bindUpload();
    initPlayer();
    initDelete();

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
            // это остаток прошлого запуска: он показывал COMPLETE на 3 секунды
            // и путал («я же ничего не нажимал»). Индикатора статуса в шапке
            // больше нет, итог напишет строка журнала, когда прогон реально
            // дойдёт до конца в этой сессии.
            state.stemgenRunning = !!(inbox.stemgen_running || progress.stemgen_running);

            if (inbox.rows && inbox.rows.length === 0) {
                switchToUpload();
                return;
            }

            state.rows = inbox.rows;
            switchToTracks(state.rows);

            if (progress.status === 'running') {
                // в другом окне уже идёт обработка — просто следуем.
                // Анонс «Обнаружен идущий анализ» не нужен: прогрессбар и
                // живая строка журнала уже всё говорят сами.
                renderLogs(progress.last_message);
                startPolling(false);
            }
        })
        .catch(() => {
            switchToUpload();
        });
}

document.addEventListener('DOMContentLoaded', init);