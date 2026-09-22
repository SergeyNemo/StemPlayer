import { els, state, TERMINAL_STATES } from './store.js';
import { fetchJson, setBadge, toggleLog, renderLogs, appendLog } from './utils.js';
import { initPlayer } from './player.js';
import { switchToUpload, switchToTracks, showBanner } from './views.js';
import { sortBy } from './sort.js';
import { bindUpload } from './upload.js';
import { startProcessing, requestStop, startPolling } from './analysis.js';

// ---------- Инициализация ----------

function init() {
    bindUpload();
    initPlayer();
    els.logToggle.addEventListener('click', () => toggleLog());
    els.bannerFoldersToggle.addEventListener('click', () => {
        els.bannerFolders.hidden = !els.bannerFolders.hidden;
        els.bannerFoldersToggle.textContent = els.bannerFolders.hidden ? 'Папки ▾' : 'Папки ▴';
    });

    els.processBtn.addEventListener('click', startProcessing);
    els.stopBtn.addEventListener('click', requestStop);

    document.querySelectorAll('th[data-sort]').forEach((th) =>
        th.addEventListener('click', () => sortBy(th.dataset.sort))
    );

    Promise.all([
        fetchJson('get_inbox'),
        fetchJson('get_progress'),
    ])
        .then(([inbox, progress]) => {
            setBadge(progress.status || 'idle');

            if (inbox.rows && inbox.rows.length === 0) {
                switchToUpload();
                return;
            }

            state.rows = inbox.rows;
            switchToTracks(state.rows);
            renderLogs(progress.log || []);

            if (progress.status === 'running') {
                // в другом окне уже идёт обработка — просто следуем
                appendLog({ time: '--:--:--', type: 'warning', message: 'Обнаружен идущий анализ (другое окно). Слежу за прогрессом.' });
                startPolling(false);
            } else if (TERMINAL_STATES.has(progress.status)) {
                if (progress.status === 'complete' && inbox.rows.length > 0) {
                    showBanner(`Последний прогон: ${progress.log.length > 0 ? 'завершён.' : ''}`, progress.folders || []);
                }
            }
        })
        .catch(() => {
            switchToUpload();
        });
}

document.addEventListener('DOMContentLoaded', init);