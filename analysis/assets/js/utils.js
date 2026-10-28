import { els, state, api } from './store.js?v=93';

function fetchJson(action, options) {
    return fetch(`${api.base}?action=${encodeURIComponent(action)}`, { cache: 'no-store', ...(options || {}) })
        .then(async (res) => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
        });
}

function fmtDuration(sec) {
    if (sec == null || !Number.isFinite(Number(sec))) return '—';
    const s = Math.round(Number(sec));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

// Блокировка ссылок и строка журнала живут в общем ядре (core/ui.js), чтобы
// «Обработка» и «Стемы» вели себя одинаково.
const StemUI = window.StemUI;

if (!StemUI) {
    throw new Error('Не загружено общее ядро assets/js/core/ui.js - подключи его в index.php до main.js');
}

// Это «журнал» — одна строка под прогрессбаром. Поведение живёт в общем ядре
// (StemUI.createLogLine), чтобы «Обработка» и «Стемы» гасили строки одинаково.
const logLine = StemUI.createLogLine(els.logLine);

// Одноразовое сообщение нашего UI (загрузка, удаление, «сначала обработайте
// хотя бы один трек»): гаснет само через LOG_LIFE_MS — иначе на экране
// навсегда остаются сообщения о давних событиях.
function appendLog(entry) {
    const { type, message } = entry || {};
    logLine.append(type, message || '', { expire: true });
}

// Итог прогона: отображение финального сообщения демона из last_message.
function logRunFinished(entry, fallback) {
    logLine.final(entry, fallback);
}

function hideLogLine() {
    logLine.hide();
}

let lastShownMessageKey = null;

// Прогресс несёт только последнюю строку журнала (last_message) — показываем её,
// если сообщение изменилось с прошлого опроса. Так строка под прогрессбаром
// живая: Demucs/анализатор пишут в неё на каждом этапе, опрос подхватывает.
// Строка этапа НЕ гаснет сама: висит, пока следующий этап её не сменит, —
// иначе текст моргал бы и пропадал посреди работы демона. Срок ей выдаёт
// logRunFinished() в конце прогона.
function renderLogs(entry) {
    if (!entry || !entry.message) return;
    const key = `${entry.time}|${entry.type}|${entry.message}`;
    if (key === lastShownMessageKey) return;
    lastShownMessageKey = key;
    const { type, message } = entry;
    logLine.append(type, message || '');
}

// Общая полоса прогресса прогона: без процентов, просто полоса ездит туда-сюда,
// пока демон жив. Доли прогресса внутри трека рисует таблица — по реальным
// этапам (current_stage_index из progress.json), см. table.js.
// На диске долей нет и не нужно: markStage() пишет 7 раз на трек, по событию.
function showProgress(running) {
    if (!els.overallProgress || !els.progressBar) return;
    els.overallProgress.hidden = !running;
    els.progressBar.classList.toggle('is-active', !!running);
}

// UI кнопки/прогресса: при обработке — «Идёт обработка» (неактивна);
// когда все треки в списке обработаны (status === 'done') — кнопку и
// прогрессбар справа прячем целиком. Полоска видна только во время обработки
// (после завершения или остановки — скрыта).
function updateProcessUI() {
    const running = state.mode === 'processing' || state.mode === 'poll';
    const pending = state.rows.some((r) => (r.status || 'pending') !== 'done');
    const allDone = !running && !pending;
    const blocked = !!state.stemgenRunning; // идёт генерация стемов — обработку не запускаем
    els.processBtn.textContent = running ? 'Идёт обработка' : 'Обработать';
    els.processBtn.disabled = running || blocked;
    els.processBtn.title = blocked && !running ? 'Идёт генерация стемов — дождитесь завершения' : '';
    if (els.addBtn) els.addBtn.disabled = running;
    els.processBtn.hidden = allDone;
    // Play едет на том же признаке, что и кнопка: пока «Обработать» на экране,
    // все треки не обработаны — играть нельзя, а как только кнопка скрылась, все
    // готовы и play разлочен (даже если прогон останавливали: mode там ещё
    // какое-то время не idle, а кнопка уже hide). Синхронизируем здесь, в
    // единственной точке, где меняется видимость кнопки, — иначе смены из
    // views.js/analysis.js оставляли play в старом состоянии. То же правило
    // продублировано в player.js:syncPlayButtons (там же вызывается после
    // updateProcessUI) и в table.js:rowDone — условие одно: els.processBtn.hidden.
    state.rowRefs.forEach((ref) => {
        const done = ref.row.status === 'done';
        ref.playBtn.disabled = !allDone || !done;
        ref.playBtn.title = !allDone ? 'Обработка идёт' : done ? 'Играть / пауза' : 'Не обработан';
    });
    showProgress(running);
    // Ссылки в шапке обновляем здесь же: это единственная точка, через
    // которую проходят ВСЕ смены состояния (views.js, analysis.js, upload.js).
    // Отдельные вызовы updateNav() по контекстам расползлись бы при первой
    // же новой ветке, и ссылка снова осталась бы «живой».
    updateNav();
}

function buildNameNode(row) {
    const wrap = document.createElement('div');
    wrap.className = 'name-stack';

    const line1 = document.createElement('span');
    line1.className = 'track-title';
    line1.textContent = row.title || row.name;

    const line2 = document.createElement('span');
    line2.className = 'track-artist';
    line2.textContent = `${row.artist || 'Неизвестен'} · ${row.name}`;

    wrap.append(line1, line2);
    return wrap;
}

// Правила блокировки навигации модуля (в дополнение к серверному PageGuard).
// Клик по заблокированной ссылке выводит причину в журнал.
const ownBusy = () => state.mode === 'processing' || state.mode === 'poll';
const otherRuns = () => !!state.stemgenRunning; // стемы генерируются - обработку не запускаем
const hasDone = () => state.rows.some((r) => r.status === 'done');

const updateNav = StemUI.createNav({
    onBlocked: (reason) => appendLog({ time: '--:--:--', type: 'warning', message: reason }),
    links: [
        {
            el: els.homeLink,
            busy: () => ownBusy() || otherRuns(),
            reason: () => `Идёт ${otherRuns() ? 'генерация стемов' : 'обработка треков'} — страница «Главная» сейчас закрыта`,
        },
        {
            el: els.stemsLink,
            busy: () => otherRuns() || ownBusy() || !hasDone(),
            reason: () => {
                if (otherRuns()) return 'Идёт генерация стемов — дождитесь завершения';
                if (ownBusy()) return 'Идёт обработка треков — страница «Стемы» сейчас закрыта';
                return 'Сначала обработайте хотя бы один трек';
            },
        },
    ],
});

// Иконка корзинки для удаления трека — тот же приём, что у play-глифа в
// player.js: inline-SVG со stroke: currentColor, поэтому кнопка красится сама
// (символ юникода рисуется системным шрифтом и в общей цветовой гамме смотрится
// чужеродно). Живёт здесь, а не в delete.js, чтобы таблица не тянула модуль
// удаления: иначе получился бы цикл table.js -> delete.js -> views.js -> table.js.
const SVG_NS = 'http://www.w3.org/2000/svg';

function trashIcon() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'del-glyph');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.7');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');

    // Ручка, бортик с крышкой и полоски ведра — тонким контуром, как в иконках
    // Material: узнаётся сразу и не зависит от начертания шрифта.
    for (const d of [
        'M9.5 3.5h5',
        'M5.5 6.5h13M6.2 6.5l.9 12.1a2 2 0 0 0 2 1.9h5.8a2 2 0 0 0 2-1.9l.9-12.1',
        'M10.3 10.3v6.4M13.7 10.3v6.4',
    ]) {
        const path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('d', d);
        svg.appendChild(path);
    }

    return svg;
}

export { fetchJson, fmtDuration, trashIcon, appendLog, logRunFinished, renderLogs, showProgress, updateProcessUI, buildNameNode, hideLogLine, updateNav };
