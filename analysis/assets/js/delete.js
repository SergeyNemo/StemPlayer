import { els, state } from './store.js?v=93';
import { fetchJson, appendLog, trashIcon } from './utils.js?v=93';
import { switchToTracks, switchToUpload } from './views.js?v=93';

// Трек, для которого открыта модалка: { name, btn }.
let pending = null;
let lastFocus = null;

// Поколение открытия: растущий счётчик отменяет отложенное добавление класса
// is-open, если модалку закрыли раньше, чем сработал кадр анимации.
// Без этого был реальный баг: клик по «Отмена»/Esc в первые ~30 мс после
// открытия снимал is-open, но висящий rAF возвращал его — guard в setTimeout
// видел класс и не прятал оверлей. Модалка залипала поверх таблицы.
let openSeq = 0;

function isRunning() {
    return state.mode === 'processing' || state.mode === 'poll';
}

function openDeleteModal(name, btn) {
    if (isRunning()) {
        appendLog({
            time: '--:--:--',
            type: 'warning',
            message: 'Идёт обработка — дождитесь окончания, потом удалите трек.',
        });
        return;
    }

    pending = { name, btn };
    lastFocus = btn || document.activeElement;

    // Защита от XSS: вставка имени файла только через textContent:
    els.delName.textContent = name;

    els.delOverlay.hidden = false;
    // Переход display:none -> flex нельзя анимировать сразу — ждём кадр,
    // иначе оверлей просто появится без мягкого проявления (как в views.js).
    const seq = ++openSeq;

    requestAnimationFrame(() => requestAnimationFrame(() => {
        if (seq === openSeq) els.delOverlay.classList.add('is-open');
    }));

    els.delConfirm.focus();
}

function closeDeleteModal() {
    if (!els.delOverlay || els.delOverlay.hidden) return;

    openSeq++; // модалка закрыта — отменяем её отложенное открытие
    els.delOverlay.classList.remove('is-open');

    setTimeout(() => {
        if (!els.delOverlay.classList.contains('is-open')) els.delOverlay.hidden = true;
    }, 200);

    if (lastFocus && lastFocus.isConnected) lastFocus.focus();
    lastFocus = null;
    pending = null;
}

// Удалённый трек мог играть: замолкаем, иначе плеер продолжит крутить файл,
// которого больше нет. play.name сбрасываем — renderTable() после перерисовки
// дёрнет applyPlaybackState() и не оставит подсвеченной кнопку play.
function stopIfPlaying(name) {
    const play = state.play || {};

    if (play.name !== name || !play.audio) return;

    play.audio.pause();
    play.audio.currentTime = 0;
    play.name = null;
}

async function confirmDelete() {
    if (!pending) return;

    const { name, btn } = pending;

    els.delConfirm.disabled = true;
    els.delCancel.disabled = true;
    els.delConfirm.textContent = 'Удаляю…';

    if (btn) {
        btn.classList.add('is-busy');
        btn.disabled = true;
    }

    try {
        // Имя уходит в теле POST, а не в строке запроса: fetchJson() кодирует
        // переданную строку целиком, и «delete_track&name=…» склеился бы в
        // одно значение action (сервер отвечал бы «Неизвестное действие»).
        // Сервер читает $_POST['name'] — поэтому здесь обычная форма.
        const res = await fetchJson('delete_track', {
            method: 'POST',
            body: new URLSearchParams({ name }),
        });

        closeDeleteModal();

        if (res.status !== 'ok') {
            appendLog({ time: '--:--:--', type: 'error', message: res.message || 'Не удалось удалить трек.' });
            return;
        }

        stopIfPlaying(name);

        // Перечитываем список: строка должна исчезнуть по-настоящему, а не
        // дорисовываться на месте — иначе в таблице остался бы фантом.
        const inbox = await fetchJson('get_inbox');
        state.rows = inbox.rows || [];

        // Подтверждаем удаление строкой журнала: трек исчез из таблицы, но
        // это мгновенно и в той же строке, где он был, — легко не заметить.
        // Раньше эта строка висела до следующего события навсегда; теперь её
        // гасит общий таймер журнала (LOG_LIFE_MS), как и все остальные.
        appendLog({ time: '--:--:--', type: 'success', message: res.message || `«${name}» удалён.` });

        if (state.rows.length === 0) {
            switchToUpload();
        } else {
            switchToTracks(state.rows);
        }
    } catch (e) {
        closeDeleteModal();
        appendLog({
            time: '--:--:--',
            type: 'error',
            message: 'Не удалось удалить трек: ' + (e && e.message ? e.message : 'ошибка сети'),
        });
    } finally {
        els.delConfirm.disabled = false;
        els.delCancel.disabled = false;
        els.delConfirm.textContent = 'Удалить';

        if (btn) {
            btn.classList.remove('is-busy');
            btn.disabled = false;
        }
    }
}

function initDelete() {
    if (!els.delOverlay) return;

    // Иконка та же, что в кнопке строки — рисуем один раз при инициализации.
    if (els.delIcon) els.delIcon.appendChild(trashIcon());

    // Делегирование: строки перерисовываются вместе с таблицей, а слушатель
    // при этом один — вешать click в renderTable() на каждую кнопку незачем.
    els.tbody.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-delete]');
        if (!btn || !els.tbody.contains(btn)) return;
        openDeleteModal(btn.dataset.delete, btn);
    });

    els.delCancel.addEventListener('click', closeDeleteModal);
    els.delConfirm.addEventListener('click', confirmDelete);
    els.delOverlay.addEventListener('click', (e) => {
        if (e.target === els.delOverlay) closeDeleteModal();
    });

    document.addEventListener('keydown', (e) => {
        if (els.delOverlay.hidden) return;

        if (e.key === 'Escape') {
            e.preventDefault();
            closeDeleteModal();
        }
    });
}

export { initDelete };
