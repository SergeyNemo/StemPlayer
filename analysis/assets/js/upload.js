import { state, els } from './store.js?v=80';
import { fetchJson, appendLog } from './utils.js?v=80';
import { switchToUpload, switchToTracks } from './views.js?v=80';

// ---------- Загрузка файлов ----------

function uploadFiles(files) {
    if (!files || files.length === 0) return;

    els.uploadProgress.hidden = false;
    els.uploadStatus.textContent = `Загрузка ${files.length} файл(ов)…`;

    const fd = new FormData();
    Array.from(files).forEach((f) => fd.append('files[]', f));

    fetchJson('upload', { method: 'POST', body: fd })
        .then(async (res) => {
            els.uploadFill.style.width = '100%';
            const uploaded = (res.uploaded || []).length;
            const rejected = res.rejected || [];
            els.uploadStatus.textContent = uploaded > 0
                ? `Загружено: ${uploaded}`
                : 'Ничего не загружено';

            rejected.forEach((r) => appendLog({ time: '--:--:--', type: 'warning', message: `${r.name}: ${r.reason}` }));

            if (uploaded > 0) {
                appendLog({ time: '--:--:--', type: 'info', message: `Загружено файлов: ${uploaded}` });
            }

            await refreshInbox();
        })
        .catch((err) => {
            els.uploadStatus.textContent = 'Ошибка загрузки';
            appendLog({ time: '--:--:--', type: 'error', message: `Загрузка не удалась: ${err.message}` });
        })
        .finally(() => {
            setTimeout(() => {
                els.uploadProgress.hidden = true;
                els.uploadFill.style.width = '0%';
            }, 1500);
            els.fileInput.value = '';
        });
}

function refreshInbox() {
    return fetchJson('get_inbox')
        .then((data) => {
            state.rows = data.rows || [];
            state.sort = {};
            state.stemgenRunning = !!(data.stemgen_running);
            if (state.rows.length === 0) {
                switchToUpload();
            } else {
                switchToTracks(state.rows);
            }
        })
        .catch(() => appendLog({ time: '--:--:--', type: 'error', message: 'Не удалось получить список треков.' }));
}

function bindUpload() {
    const openPicker = () => els.fileInput.click();

    els.pickBtn.addEventListener('click', openPicker);
    els.dropzone.addEventListener('click', openPicker);

    els.dropzone.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') openPicker();
    });

    els.fileInput.addEventListener('change', () => uploadFiles(els.fileInput.files));

    ['dragenter', 'dragover'].forEach((ev) =>
        els.dropzone.addEventListener(ev, (e) => {
            e.preventDefault();
            els.dropzone.classList.add('dz-over');
        })
    );
    ['dragleave', 'drop'].forEach((ev) =>
        els.dropzone.addEventListener(ev, (e) => {
            e.preventDefault();
            els.dropzone.classList.remove('dz-over');
        })
    );
    els.dropzone.addEventListener('drop', (e) => uploadFiles(e.dataTransfer.files));
}

export { uploadFiles, refreshInbox, bindUpload };