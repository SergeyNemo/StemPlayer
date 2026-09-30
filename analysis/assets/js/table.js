import { state, els } from './store.js?v=80';
import { buildPlayButton, bindSeek, applyPlaybackState, fmtMinSec } from './player.js?v=80';
import { fmtDuration, buildNameNode, trashIcon } from './utils.js?v=80';

// Число ступеней шкалы = ProgressStore::STAGES на сервере. Держим в одном
// месте, чтобы ширина считалась от одного числа; порядок подписей сервер
// присылает сам (current_stage_index / current_stage_label), здесь он не нужен.
const STAGE_TOTAL = 7;

// ---------- Отрисовка таблицы ----------

function renderTable(rows) {
    els.tbody.innerHTML = '';
    state.rowRefs.clear();

    rows.forEach((row, i) => {
        const tr = document.createElement('tr');

        const numCell = document.createElement('td');
        numCell.className = 'col-num';
        numCell.textContent = String(i + 1);

        const nameCell = document.createElement('td');
        nameCell.className = 'col-track';

        const playBtn = buildPlayButton(row.name, row.status === 'done');

        const playWrapper = document.createElement('div');
        playWrapper.className = 'play-wrap';
        const playFill = document.createElement('div');
        playFill.className = 'play-fill';
        const playBar = document.createElement('div');
        playBar.className = 'play-bar';
        playBar.appendChild(playFill);
        const playTime = document.createElement('span');
        playTime.className = 'play-time';
        // Время видно сразу, а не после нажатия play: иначе в момент клика
        // строка расползалась (текст появлялся и расширял ячейку). Формат —
        // тот же, что у плеера во время игры, чтобы счётчик не перескакивал.
        if (row.duration != null) playTime.textContent = `0:00 / ${fmtMinSec(row.duration)}`;
        playWrapper.append(playBar, playTime);

        bindSeek(playBar, row.name);

        const stack = document.createElement('div');
        stack.className = 'name-stack';
        stack.append(buildNameNode(row));
        stack.appendChild(playWrapper);

        const trackContent = document.createElement('div');
        trackContent.className = 'track-content';
        trackContent.append(playBtn, stack);
        nameCell.appendChild(trackContent);

        const bpmCell = document.createElement('td');
        bpmCell.className = 'col-center';
        // Подпись нужна только в узком экране, где таблица становится
        // карточками и значение выравнивается вправо (CSS content: attr()).
        bpmCell.dataset.label = 'BPM';
        bpmCell.textContent = row.bpm != null ? row.bpm : '—';

        const keyCell = document.createElement('td');
        keyCell.className = 'col-center';
        keyCell.dataset.label = 'Тональность';
        keyCell.textContent = row.key || '—';

        const durCell = document.createElement('td');
        durCell.className = 'col-center';
        durCell.dataset.label = 'Длительность';
        durCell.textContent = fmtDuration(row.duration);

        // Корзинка: удаляет трек из Inbox вместе с копией, стемами и
        // записями storage (см. delete.js и TrackCleaner). Обработчик не
        // вешаем здесь — клик ловится делегированием от tbody, иначе на
        // каждой перерисовке таблицы пришлось бы переподписывать кнопки.
        const delCell = document.createElement('td');
        delCell.className = 'col-act';

        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'row-del';
        delBtn.dataset.delete = row.name;
        delBtn.title = 'Удалить трек из Inbox';
        delBtn.setAttribute('aria-label', 'Удалить трек из Inbox: ' + row.name);
        delBtn.appendChild(trashIcon());

        delCell.appendChild(delBtn);

        if (row.status === 'error') tr.classList.add('row-error');
        if (row.status === 'done') tr.classList.add('row-done');

        tr.append(numCell, nameCell, bpmCell, keyCell, durCell, delCell);
        els.tbody.appendChild(tr);

        state.rowRefs.set(row.name, {
            tr, nameCell, bpmCell, keyCell, durCell, delBtn, row,
            playBtn, playWrapper, playFill, playTime, playBar,
            busyState: '',
        });
    });

    updateSortInd();
    applyPlaybackState();
    syncDeleteButtons();
}

// Корзинки ведут себя как кнопки play (см. syncPlayButtons): на время
// обработки неактивны все, а не только текущий трек — демон держит в памяти
// весь список файлов прогона, и удаление любого из них посреди работы
// роняет его на следующем шаге. Причина видна прямо на кнопке (title).
// Вызывается и из renderTable(): перерисовка во время прогона не должна
// возвращать удаление в строй.
function syncDeleteButtons() {
    const running = state.mode === 'processing' || state.mode === 'poll';

    state.rowRefs.forEach((ref) => {
        if (!ref.delBtn) return;

        ref.delBtn.disabled = running;

        if (running) {
            ref.delBtn.title = ref.busyState === 'run'
                ? 'Трек в работе — удалить можно после обработки'
                : 'Идёт обработка — удалить можно после неё';
        } else {
            ref.delBtn.title = 'Удалить трек из Inbox';
        }
    });
}

function updateSortInd() {
    document.querySelectorAll('th[data-sort]').forEach((th) => {
        const ind = th.querySelector('.sort-ind');
        const key = th.dataset.sort;
        if (!ind) return;
        if (state.sort.key === key) {
            ind.textContent = state.sort.dir === 1 ? '▲' : state.sort.dir === -1 ? '▼' : '⇄';
            th.classList.add('is-sorted');
        } else {
            ind.textContent = '';
            th.classList.remove('is-sorted');
        }
    });
}

// ---------- Обновление строк в реальном времени ----------

// Плавная смена содержимого ячейки: старый стек гаснет, новый появляется.
// fast=true — мгновенная замена без анимации (для массовых сбросов).
// Счётчик _swapSeq защищает от наложения: устаревший таймер не перезапишет
// более свежую смену.
function swapStack(nameCell, playBtn, buildNew, fast) {
    const content = nameCell.querySelector(':scope > .track-content') || nameCell;
    const oldStack = content.querySelector(':scope > .name-stack');
    const seq = (content._swapSeq = (content._swapSeq || 0) + 1);

    const apply = () => {
        const newStack = buildNew();
        content.replaceChildren(playBtn, newStack);
        requestAnimationFrame(() => requestAnimationFrame(() => newStack.classList.add('is-entering')));
    };

    if (fast || !oldStack || !oldStack.isConnected) {
        apply();
        return;
    }

    oldStack.classList.add('is-leaving');
    setTimeout(() => {
        if (content._swapSeq !== seq) return;
        apply();
    }, 170);
}

// Обработка трека: ступенчатая шкала по реальным этапам, а не индикатор «идёт
// работа». Этапы дискретные (см. ProgressStore::STAGES), поэтому заполнение
// только растёт и физически не может «заполниться дважды».
//
// Этап приходит из демона полем current_stage_index + current_stage_label:
// рисовать надо ровно то, что реально происходит сейчас.
function stagePercent(index) {
    const total = STAGE_TOTAL;
    if (!(index >= 0)) return 0;
    return Math.round(((index + 1) / total) * 100);
}

function rowProcessing(name, stageIndex, stageLabel) {
    const ref = state.rowRefs.get(name);
    if (!ref || state.stopping) return;

    // Готовый или упавший трек обратно в работу не возвращаем. Раньше здесь
    // стояла защита только от повторного вызова, и строка успевала откатиться
    // в «В очереди…», если опрос приходил в другой последовательности.
    // Явный сброс строки — rebuildRowIdle() в начале нового прогона.
    if (ref.busyState === 'done' || ref.busyState === 'error') return;

    if (ref.busyState === 'run') {
        // Уже в работе — только досылаем текущий этап (опрос мог прийти раньше
        // первого вызова rowProcessing).
        if (typeof stageIndex === 'number') setRowStage(name, stageIndex, stageLabel);
        return;
    }
    ref.busyState = 'run';

    ref.tr.classList.remove('row-done', 'row-error');
    ref.tr.classList.add('row-processing');

    const barRow = document.createElement('div');
    barRow.className = 'cell-progress is-staged';
    const bar = document.createElement('div');
    bar.className = 'cell-fill';
    bar.style.width = '0%';
    barRow.appendChild(bar);

    const status = document.createElement('span');
    status.className = 'cell-status';
    status.textContent = 'Обработка…';

    // Сохраняем ссылки: дальше этапы обновляются точечно, без перерисовки строки.
    ref.bar = bar;
    ref.stageLabel = status;

    swapStack(ref.nameCell, ref.playBtn, () => {
        const stack = document.createElement('div');
        stack.className = 'name-stack';
        stack.append(buildNameNode(ref.row), barRow, status, ref.playWrapper);
        return stack;
    });

    ref.bpmCell.textContent = '—';
    ref.keyCell.textContent = '—';
    ref.durCell.textContent = '—';

    // Идущий трек удалять нельзя: демон держит его открытым, а страница всё
    // равно гасит кнопки на всё время прогона (delete.js). Здесь — точная
    // подсказка «почему» на самой кнопке.
    if (ref.delBtn) {
        ref.delBtn.disabled = true;
        ref.delBtn.title = 'Трек в работе — удалить можно после обработки';
    }

    if (typeof stageIndex === 'number') setRowStage(name, stageIndex, stageLabel);
}

// Точечное обновление этапа: меняются только ширина полоски и подпись.
function setRowStage(name, stageIndex, stageLabel) {
    const ref = state.rowRefs.get(name);
    if (!ref || ref.busyState !== 'run' || !ref.bar) return;

    const percent = stagePercent(stageIndex);
    if (ref.stageShown === percent) return;

    ref.stageShown = percent;
    ref.bar.style.width = percent + '%';
    ref.bar.dataset.stage = String(stageIndex);

    if (stageLabel) ref.stageLabel.textContent = stageLabel;
}

// Строка ушла из состояния «в работе» — ссылки на полоску больше не нужны.
function clearBar(ref) {
    ref.bar = null;
    ref.stageLabel = null;
    ref.stageShown = -1;
}

// Трек ждёт своей очереди: только подпись, без полоски.
function rowQueued(name) {
    const ref = state.rowRefs.get(name);
    if (!ref || state.stopping) return;

    // Терминальные состояния не откатываем в очередь — см. rowProcessing.
    if (ref.busyState === 'done' || ref.busyState === 'error') return;
    if (ref.busyState === 'queued') return;
    ref.busyState = 'queued';

    const status = document.createElement('span');
    status.className = 'cell-status';
    status.textContent = 'В очереди…';

    swapStack(ref.nameCell, ref.playBtn, () => {
        const stack = document.createElement('div');
        stack.className = 'name-stack';
        stack.append(buildNameNode(ref.row), status, ref.playWrapper);
        return stack;
    });
}

function rowDone(name, result) {
    const ref = state.rowRefs.get(name);
    if (!ref) return;
    // Готовый трек не перерисовываем: список раз в 2 секунды уже содержит его,
    // и без этой проверки строка мигала бы, меняя статус на каждом опросе.
    if (ref.busyState === 'done') return;

    ref.busyState = 'done';
    ref.tr.classList.remove('row-processing', 'row-error');
    ref.tr.classList.add('row-done');

    const doneChip = document.createElement('span');
    doneChip.className = 'chip chip-ok';
    doneChip.textContent = '✓ Обработано';

    swapStack(ref.nameCell, ref.playBtn, () => {
        const stack = document.createElement('div');
        stack.className = 'name-stack';
        stack.append(buildNameNode(ref.row), doneChip, ref.playWrapper);
        return stack;
    });

    ref.bpmCell.textContent = result.bpm ?? '—';
    ref.keyCell.textContent = result.key || '—';
    ref.durCell.textContent = fmtDuration(result.duration);

    if (state.mode !== 'processing' && state.mode !== 'poll') {
        ref.playBtn.disabled = false;
        ref.playBtn.title = 'Играть / пауза';
    }
    clearBar(ref);
}

function rowError(name, message) {
    const ref = state.rowRefs.get(name);
    if (!ref) return;
    if (ref.busyState === 'error') return; // как в rowDone: не мигаем на каждом опросе

    ref.busyState = 'error';
    ref.tr.classList.remove('row-processing', 'row-done');
    ref.tr.classList.add('row-error');
    ref.durCell.textContent = '—';

    const chip = document.createElement('span');
    chip.className = 'chip chip-err';
    chip.textContent = '✕ ошибка';
    if (message) chip.title = message;

    swapStack(ref.nameCell, ref.playBtn, () => {
        const stack = document.createElement('div');
        stack.className = 'name-stack';
        stack.append(buildNameNode(ref.row), chip, ref.playWrapper);
        return stack;
    });

    clearBar(ref);
}

function rebuildRowIdle(ref, fast) {
    ref.busyState = '';
    clearBar(ref);

    // Возвращаем корзинку в строй: после прогона трек снова можно удалить.
    if (ref.delBtn) {
        ref.delBtn.disabled = false;
        ref.delBtn.title = 'Удалить трек из Inbox';
    }

    const content = ref.nameCell.querySelector(':scope > .track-content') || ref.nameCell;
    const oldStack = content.querySelector(':scope > .name-stack');
    if (!fast && oldStack && !oldStack.querySelector('.chip, .cell-status, .cell-progress')) {
        return; // уже idle — не трогаем
    }

    swapStack(ref.nameCell, ref.playBtn, () => {
        const stack = document.createElement('div');
        stack.className = 'name-stack';
        stack.append(buildNameNode(ref.row));
        stack.appendChild(ref.playWrapper);
        return stack;
    }, fast);
}

export { renderTable, updateSortInd, rowProcessing, setRowStage, rowQueued, rowDone, rowError, rebuildRowIdle, syncDeleteButtons };