import { els, state } from './store.js';
import { setBadge } from './utils.js';
import { renderTable } from './table.js';

// ---------- Состояния-вью ----------

function switchToUpload() {
    els.uploadZone.hidden = false;
    els.tracksView.hidden = true;
    els.processBtn.disabled = true;
    setBadge('idle');
}

function switchToTracks(rows) {
    els.uploadZone.hidden = true;
    els.tracksView.hidden = false;
    renderTable(rows);
    const active = state.mode === 'processing' || state.mode === 'poll';
    els.processBtn.disabled = active;
    els.stopBtn.hidden = !active;
}

function showBanner(text, folders) {
    els.banner.hidden = false;
    els.bannerText.textContent = text;

    els.bannerFoldersToggle.hidden = !(folders && folders.length > 0);
    els.bannerFolders.innerHTML = '';

    if (folders && folders.length > 0) {
        folders.forEach((folder) => {
            const dir = document.createElement('div');
            dir.className = 'dir';
            dir.textContent = `music/sorted/${folder.name}/`;
            const sub = document.createElement('ul');
            (folder.files || []).forEach((f) => {
                const li = document.createElement('li');
                li.className = 'file';
                li.textContent = f;
                sub.appendChild(li);
            });
            dir.appendChild(sub);
            els.bannerFolders.appendChild(dir);
        });
    }
}

function hideBanner() {
    els.banner.hidden = true;
}

export { switchToUpload, switchToTracks, showBanner, hideBanner };