'use strict';
(function (G) {
    const { els } = G;


    // Индикатор работы демона без процентов: полоса ездит туда-сюда и сообщает
    // только «идёт генерация». Долей прогресса нет ни на диске, ни в UI.
    G.showProgress = function showProgress(running) {
        if (!els.overallProgress || !els.progressBar) return;
        els.overallProgress.hidden = !running;
        els.progressBar.classList.toggle('is-active', !!running);
    };

    // Это «журнал» — одна строка под прогрессбаром. Поведение живёт в общем
    // ядре (StemUI.createLogLine), ровно как на странице «Обработка».
    // Одноразовые сообщения нашего UI (ошибка запуска, «генерация занята»,
    // «демон не отвечает») гаснут сами через LOG_LIFE_MS, иначе на экране
    // навсегда остаются сообщения о давних событиях. Подписи типа («OK»,
    // «ИНФО») в строке нет: тип и так виден по цвету самой строки.
    const logLine = window.StemUI.createLogLine(els.logLine);

    G.appendLog = function appendLog(msg) {
        logLine.append(String((msg && msg.type) || 'info').toLowerCase(), (msg && msg.message) || '', { expire: true });
    };

    // Живая строка журнала: демон пишет в progress.json единственное поле
    // last_message, polling подхватывает его и показывает, пока не придёт новое.
    // Строка этапа сама не гаснет: висит, пока следующий этап её не сменит, —
    // иначе текст моргал бы и пропадал посреди генерации. Срок ей выдаёт
    // logRunFinished() в конце прогона.
    let lastShownMessageKey = null;

    G.renderLogs = function renderLogs(entry) {
        if (!entry || !entry.message) return;
        const key = `${entry.time}|${entry.type}|${entry.message}`;
        if (key === lastShownMessageKey) return;
        lastShownMessageKey = key;
        logLine.append(String((entry.type || 'info').toLowerCase()), entry.message || '');
    };

    G.hideLogLine = function hideLogLine() {
        logLine.hide();
    };

    // Итог прогона. Индикатор статуса в шапке удалён, поэтому строка журнала —
    // единственное место, где пользователь узнаёт о финале. Пишем сообщение
    // демона из last_message, а не обезличенное «Готово», и гасим через
    // LOG_FINAL_MS: раньше итог жил в бейдже и строкой не дублировался.
    G.logRunFinished = function logRunFinished(entry, fallback) {
        logLine.final(entry, fallback);
    };

    // Баннер-хвост удалён вместе с разметкой: единственная текстовая подпись
    // на странице — живая строка журнала под прогрессбаром.
})(window.StemGen);
