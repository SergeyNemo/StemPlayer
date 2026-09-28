import { els, state, api } from './store.js?v=15';

function fetchJson(action, options) {
    return fetch(`${api.base}?action=${encodeURIComponent(action)}`, options)
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

// Бейдж статуса и блокировка ссылок живут в общем ядре (core/ui.js), чтобы
// «Обработка» и «Стемы» вели себя одинаково. Здесь только тонкая обёртка,
// чтобы существующие вызовы setBadge() не пришлось переписывать.
const StemUI = window.StemUI;

if (!StemUI) {
    throw new Error('Не загружено общее ядро assets/js/core/ui.js - подключи его в index.php до main.js');
}

// COMPLETE держим 3 секунды и возвращаем idle — иначе бейдж «залипает»
// на комплите. Терминальный статус показывается один раз за запуск:
// опрос раз в 2 с не должен постоянно перезапускать таймер.
const setBadge = StemUI.createBadge(els.badge, { holdMs: StemUI.BADGE_HOLD_MS });

let logSwapTimer = null;

// Это «журнал» теперь — одна строка под прогрессбаром. Видна постоянно,
// пока не придёт новая запись: старая плавно гаснет, новая плавно появляется.
function buildLogLine(type, message) {
    const cls = ['info', 'success', 'error', 'warning'].includes(type) ? type : 'info';
    els.logLine.className = `log-line log-${cls}`;
    els.logLine.innerHTML = '';

    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = (type || 'info').toUpperCase();

    const text = document.createElement('span');
    text.className = 'message';
    text.textContent = message;

    els.logLine.append(badge, text);
    els.logLine.hidden = false;

    requestAnimationFrame(() => requestAnimationFrame(() => els.logLine.classList.add('is-show')));
}

function showLogLine(type, message) {
    if (!els.logLine) return;
    if (logSwapTimer) {
        clearTimeout(logSwapTimer);
        logSwapTimer = null;
    }

    if (!els.logLine.hidden && els.logLine.classList.contains('is-show')) {
        els.logLine.classList.remove('is-show');
        logSwapTimer = setTimeout(() => buildLogLine(type, message), 200);
    } else {
        buildLogLine(type, message);
    }
}

function appendLog(entry) {
    const { type, message } = entry || {};
    showLogLine(type, message || '');
}

function hideLogLine() {
    els.logLine.classList.remove('is-show');
    setTimeout(() => {
        if (!els.logLine.classList.contains('is-show')) els.logLine.hidden = true;
    }, 300);
}

let lastShownMessageKey = null;

// Прогресс несёт только последнюю строку журнала (last_message) — показываем её,
// если сообщение изменилось с прошлого опроса. Так строка под прогрессбаром
// живая: Demucs/анализатор пишут в неё на каждом этапе, опрос подхватывает.
function renderLogs(entry) {
    if (!entry || !entry.message) return;
    const key = `${entry.time}|${entry.type}|${entry.message}`;
    if (key === lastShownMessageKey) return;
    lastShownMessageKey = key;
    appendLog(entry);
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

// Ссылки в шапке блокирует общее ядро (StemUI.createNav). Здесь только
// правила для этого модуля: когда ссылка недоступна и почему. Источник
// правды — core/PageGuard.php: пока работает какой-то модуль, закрыты
// «Главная» (enforceHome) и страница соседнего модуля.
//
// Настоящая защита серверная (core/PageGuard.php отдаёт 302), поэтому
// href у ссылки остаётся всегда: <a> без href не кликается, и
// пользователь нажимает «всё равно ничего не происходит». Про клик по
// заблокированной ссылке пишем в ленту прогресса, а не молчим.
//
//  <Главная> - закрыта на время любого прогона;
//  <Стемы>   - закрыта, если идёт любой демон (страницу «Стемов»
//              всё равно перехватит PageGuard, а ссылка мигала бы
//              «готовой» посреди прогона) или ещё нет ни одного
//              обработанного трека (там показывают замок).
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

export { fetchJson, fmtDuration, setBadge, appendLog, renderLogs, showProgress, updateProcessUI, buildNameNode, hideLogLine, updateNav };