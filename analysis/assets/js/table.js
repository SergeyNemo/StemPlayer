import { state, els } from './store.js';
import { fmtDuration, buildNameNode } from './utils.js';
import { buildPlayButton, bindSeek, applyPlaybackState } from './player.js';

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

        const playBtn = buildPlayButton(row.name);

        const playWrapper = document.createElement('div');
        playWrapper.className = 'play-wrap';
        const playFill = document.createElement('div');
        playFill.className = 'play-fill';
        const playBar = document.createElement('div');
        playBar.className = 'play-bar';
        playBar.appendChild(playFill);
        const playTime = document.createElement('span');
        playTime.className = 'play-time';
        playWrapper.append(playBar, playTime);

        bindSeek(playBar, row.name);

        const stack = document.createElement('div');
        stack.className = 'name-stack';
        stack.append(buildNameNode(row));
        stack.appendChild(playWrapper);

        nameCell.append(playBtn, stack);

        const bpmCell = document.createElement('td');
        bpmCell.className = 'col-center';
        bpmCell.textContent = row.bpm != null ? row.bpm : '—';

        const keyCell = document.createElement('td');
        keyCell.className = 'col-center';
        keyCell.textContent = row.key || '—';

        const durCell = document.createElement('td');
        durCell.className = 'col-center';
        durCell.textContent = fmtDuration(row.duration);

        if (row.status === 'error') tr.classList.add('row-error');
        if (row.status === 'done') tr.classList.add('row-done');

        tr.append(numCell, nameCell, bpmCell, keyCell, durCell);
        els.tbody.appendChild(tr);

        state.rowRefs.set(row.name, {
            tr, nameCell, bpmCell, keyCell, durCell, row,
            playBtn, playWrapper, playFill, playTime, playBar,
        });
    });

    els.trackTotalText.textContent = `Треков: ${rows.length}`;
    updateSortInd();
    applyPlaybackState();
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

function rowProcessing(name) {
    const ref = state.rowRefs.get(name);
    if (!ref || state.stopping) return;

    ref.tr.classList.remove('row-done', 'row-error');
    ref.tr.classList.add('row-processing');

    const barRow = document.createElement('div');
    barRow.className = 'cell-progress';
    const bar = document.createElement('div');
    bar.className = 'cell-fill';
    bar.style.width = '2%';
    barRow.appendChild(bar);

    const status = document.createElement('span');
    status.className = 'cell-status';
    status.textContent = 'Загрузка · 0%';

    const stack = document.createElement('div');
    stack.className = 'name-stack';
    stack.append(buildNameNode(ref.row), barRow, status, ref.playWrapper);

    ref.nameCell.replaceChildren(ref.playBtn, stack);

    ref.barEl = bar;
    ref.statusEl = status;
    ref.bpmCell.textContent = '—';
    ref.keyCell.textContent = '—';
    ref.durCell.textContent = '—';
}

function rowProgress(name, data) {
    const ref = state.rowRefs.get(name);
    if (!ref || !ref.barEl || state.stopping) return;

    const pct = Math.round((Number(data.progress) || 0) * 100);
    ref.barEl.style.width = `${Math.min(100, Math.max(0, pct))}%`;
    ref.statusEl.textContent = `${data.phase || 'Анализ'} · ${pct}%`;
}

function rowDone(name, result) {
    const ref = state.rowRefs.get(name);
    if (!ref) return;

    ref.tr.classList.remove('row-processing', 'row-error');
    ref.tr.classList.add('row-done');

    const doneChip = document.createElement('span');
    doneChip.className = 'chip chip-ok';
    doneChip.textContent = '✓ обработан';

    const stack = document.createElement('div');
    stack.className = 'name-stack';
    stack.append(buildNameNode(ref.row), doneChip, ref.playWrapper);
    ref.nameCell.replaceChildren(ref.playBtn, stack);

    ref.bpmCell.textContent = result.bpm ?? '—';
    ref.keyCell.textContent = result.key || '—';
    ref.durCell.textContent = fmtDuration(result.duration);
}

function rowError(name, message) {
    const ref = state.rowRefs.get(name);
    if (!ref) return;

    ref.tr.classList.remove('row-processing', 'row-done');
    ref.tr.classList.add('row-error');
    ref.durCell.textContent = '—';

    const chip = document.createElement('span');
    chip.className = 'chip chip-err';
    chip.textContent = '✕ ошибка';
    if (message) chip.title = message;

    const stack = document.createElement('div');
    stack.className = 'name-stack';
    stack.append(buildNameNode(ref.row), chip, ref.playWrapper);
    ref.nameCell.replaceChildren(ref.playBtn, stack);
}

function rebuildRowIdle(ref) {
    const stack = document.createElement('div');
    stack.className = 'name-stack';
    stack.append(buildNameNode(ref.row));
    stack.appendChild(ref.playWrapper);
    ref.nameCell.replaceChildren(ref.playBtn, stack);
}

export { renderTable, updateSortInd, rowProcessing, rowProgress, rowDone, rowError, rebuildRowIdle };