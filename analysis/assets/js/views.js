import { els, state } from './store.js?v=93';
import { updateProcessUI } from './utils.js?v=93';
import { renderTable } from './table.js?v=93';

// ---------- Состояния-вью ----------

function switchToUpload() {
    els.uploadZone.hidden = false;
    els.tracksView.hidden = true;
    els.processBtn.disabled = true;
    updateProcessUI();
}

function switchToTracks(rows) {
    els.uploadZone.hidden = true;
    els.tracksView.hidden = false;
    renderTable(rows);
    const active = state.mode === 'processing' || state.mode === 'poll';
    els.processBtn.disabled = active;
    els.stopBtn.hidden = !active;
    updateProcessUI();
}

// Баннер-хвост сверху таблицы удалён: единственная текстовая подпись на
// странице — живая строка журнала под прогрессбаром.
export { switchToUpload, switchToTracks };
