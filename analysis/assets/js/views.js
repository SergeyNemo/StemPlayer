import { els, state } from './store.js?v=48';
import { setBadge, updateProcessUI } from './utils.js?v=48';
import { renderTable } from './table.js?v=48';

// ---------- Состояния-вью ----------

function switchToUpload() {
    els.uploadZone.hidden = false;
    els.tracksView.hidden = true;
    els.processBtn.disabled = true;
    setBadge('idle');
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

let bannerTimer = null;

// Плавно показываем баннер, через 3 секунды плавно прячем.
function showBanner(text) {
    if (bannerTimer) {
        clearTimeout(bannerTimer);
        bannerTimer = null;
    }

    els.bannerText.textContent = text;
    els.banner.hidden = false;

    // Переход display:none -> flex нельзя анимировать сразу, ждём следующий кадр.
    requestAnimationFrame(() => requestAnimationFrame(() => els.banner.classList.add('is-visible')));

    bannerTimer = setTimeout(() => hideBanner(), 3000);
}

function hideBanner() {
    if (bannerTimer) {
        clearTimeout(bannerTimer);
        bannerTimer = null;
    }
    els.banner.classList.remove('is-visible');
    setTimeout(() => {
        if (!els.banner.classList.contains('is-visible')) els.banner.hidden = true;
    }, 350);
}

export { switchToUpload, switchToTracks, showBanner, hideBanner };