'use strict';

/**
 * Общее UI-ядро StemPlayer. Один файл на оба модуля.
 *
 * Зачем он общий: «Обработка» и «Стемы» — это разные страницы одного
 * приложения, и поведение верхней панели у них обязано совпадать
 * (блокировка ссылок, строка журнала). Раньше это было написано дважды,
 * и правки разъезжались: на «Стемах» ссылка «Обработка» оставалась
 * активной во время генерации, а на «Обработке» кнопка «Стемы»
 * не блокировалась по «нет готовых треков».
 *
 * Индикатора статуса в шапке (бейдж IDLE/RUNNING/COMPLETE) больше нет:
 * он был вторым источником правды о прогоне, дублировал строку журнала и
 * только мешал. Итог прогона теперь пишет сама строка журнала —
 * см. final() в createLogLine.
 *
 * Подключается обычным <script> (не модуль) — модульные системы у
 * страниц разные (analysis на ES-модулях, stemgen на window.StemGen),
 * а этот код нужен обеим. Классический скрипт грузится раньше
 * отложенных модулей, поэтому window.StemUI уже готов к моменту
 * их запуска.
 */
window.StemUI = (function () {
    'use strict';

    /**
     * Сколько живёт ОДНОРАЗОВОЕ сообщение журнала (загрузка файла, удаление
     * трека, «сначала обработайте хотя бы один трек»).
     *
     * Раньше строки жили вечно: лента показывала последнюю запись и держала
     * её, пока не случалось что-то ещё. Из-за этого на экране навсегда
     * оставались «Загружено файлов: 1», «Сначала обработайте хотя бы один
     * трек», зелёные «Готово» и «… удалён» — сообщения о событиях, которые
     * давно закончились. Такие строки гаснут сами.
     */
    var LOG_LIFE_MS = 4000;

    /** Сколько живёт ПОСЛЕДНЯЯ строка прогона: этапы идут, строка меняется и
     *  висит дальше (таймера у неё нет — иначе посреди работы демона текст
     *  моргал бы и пропадал), а как прогон дошёл до последнего этапа, строка
     *  ещё LOG_FINAL_MS напоминает о нём и гаснет. */
    var LOG_FINAL_MS = 3000;

    /** Старая строка гаснет перед подменой, новая проявляется. */
    var LOG_SWAP_MS = 200;

    /** Пауза между снятием класса и-hidden, чтобы гаснение было видно. */
    var LOG_HIDE_MS = 300;

    var LOG_TYPES = ['info', 'success', 'error', 'warning'];

    // ---------------------------------------------------------------- журнал

    /**
     * Строка журнала: одна реализация на «Обработку» и «Стемы».
     *
     * Правило поведения везде одинаковое:
     *   - новая запись сменяет старую (старая гаснет, новая проявляется);
     *   - строка этапа прогона держится ДО СЛЕДУЮЩЕГО этапа: таймера у неё
     *     нет (append без expire), иначе посреди работы демона текст моргал
     *     бы и пропадал на несколько секунд;
     *   - последняя строка, когда прогон дошёл до конца, ещё LOG_FINAL_MS
     *     висит и гаснет сама — это final();
     *   - одноразовые сообщения (append с expire) гаснут через LOG_LIFE_MS;
     *   - hide() гасит немедленно и отменяет отложенную подмену, иначе
     *     строка, которую только что спрятали, успевала появиться снова
     *     (подмена срабатывает через 200 мс, скрытие ждёт 300 мс).
     *
     * Подписи типа («SUCCESS», «OK», «ИНФО», «ОШИБКА») в строке нет: тип и так
     * виден по цвету самой строки, а слово занимало место и дублировало то,
     * что показывает строка. Это единственная текстовая подпись о прогоне:
     * индикатор статуса в шапке удалён.
     *
     * @param {HTMLElement|null} el элемент .log-line
     * @param {{lifeMs?: number, finalMs?: number}} [opts]
     * @returns {{append: (type: string, message: string, opts?: {expire?: boolean, expireMs?: number}) => void,
     *            hide: () => void,
     *            final: (entry: {message?: string, type?: string}|null, fallback: string) => void}}
     */
    function createLogLine(el, opts) {
        var cfg = opts || {};
        var lifeMs = cfg.lifeMs || LOG_LIFE_MS;
        var finalMs = cfg.finalMs || LOG_FINAL_MS;

        var swapTimer = null;
        var lifeTimer = null;
        var hideTimer = null;

        function clearTimers() {
            if (swapTimer !== null) { clearTimeout(swapTimer); swapTimer = null; }
            if (lifeTimer !== null) { clearTimeout(lifeTimer); lifeTimer = null; }
            if (hideTimer !== null) { clearTimeout(hideTimer); hideTimer = null; }
        }

        function build(type, message) {
            el.className = 'log-line log-' + type;
            el.innerHTML = '';

            var t = document.createElement('span');
            t.className = 'message';
            // textContent, а не innerHTML: текст приходит из демона и из
            // имён файлов, там не должно быть возможности вписать разметку.
            t.textContent = message || '';

            el.appendChild(t);
            el.hidden = false;

            requestAnimationFrame(function () {
                requestAnimationFrame(function () { el.classList.add('is-show'); });
            });
        }

        function hide() {
            if (!el) return;
            clearTimers();
            el.classList.remove('is-show');

            hideTimer = setTimeout(function () {
                hideTimer = null;
                if (!el.classList.contains('is-show')) el.hidden = true;
            }, LOG_HIDE_MS);
        }

        // ms = 0 — строка живёт до следующей (таймер снят).
        function armLife(ms) {
            if (lifeTimer !== null) { clearTimeout(lifeTimer); lifeTimer = null; }
            if (!ms) return;
            lifeTimer = setTimeout(function () {
                lifeTimer = null;
                hide();
            }, ms);
        }

        function append(type, message, opts) {
            if (!el) return;

            var t = LOG_TYPES.indexOf(type) >= 0 ? type : 'info';
            var o = opts || {};
            var ms = o.expire ? (o.expireMs || lifeMs) : 0;

            if (swapTimer !== null) {
                clearTimeout(swapTimer);
                swapTimer = null;
            }
            // Старый срок снимаем сразу, а не после подмены: подмена стоит
            // 200 мс, и иначе гаснущая строка успела бы погасить и новую.
            armLife(0);

            if (!el.hidden && el.classList.contains('is-show')) {
                el.classList.remove('is-show');
                swapTimer = setTimeout(function () {
                    swapTimer = null;
                    build(t, message);
                    armLife(ms);
                }, LOG_SWAP_MS);
            } else {
                build(t, message);
                armLife(ms);
            }
        }

        /**
         * Итог прогона. Раньше его показывал бейдж статуса в шапке
         * (RUNNING -> COMPLETE -> IDLE), а строка молчала намеренно: бейдж был
         * вторым источником правды об одном и том же событии. Индикатор убран,
         * поэтому итог пишем здесь — и не «Готово», а реальным сообщением
         * демона из last_message («Готово: обработано 3 из 3 файлов.»),
         * иначе прогон сообщал бы о себе одной обезличенной подписью.
         *
         * Срок задаётся СРАЗУ в append(), а не отдельным expire() после неё:
         * append() при подмене видимой строки строит новую через LOG_SWAP_MS и
         * только там обнуляет срок, так что expire() поверх был бы стёрт
         * через 200 мс и строка не погасла бы никогда.
         *
         * @param {{message?: string, type?: string}|null} entry last_message
         * @param {string} fallback если демон не оставил сообщения
         */
        function final(entry, fallback) {
            if (!el) return;
            var e = entry || {};
            var text = e.message || fallback || '';
            if (!text) return;
            append(e.type || 'success', text, { expire: true, expireMs: finalMs });
        }

        return { append: append, hide: hide, final: final };
    }

    // ------------------------------------------------------------ навигация

    /**
     * Блокировка одной ссылки.
     *
     * ВАЖНО: href не удаляется и pointer-events не снимается. Раньше
     * здесь было наоборот, и ссылка становилась «мёртвой»: <a> без href
     * не кликается, а pointer-events:none отключает для неё ещё и
     * :hover. Пользователь видел живую подсветку, нажимал - и ничего
     * не происходило. Настоящая защита всё равно серверная
     * (core/PageGuard.php отдаёт 302), поэтому клик должен работать
     * всегда: либо переход, либо объяснение, почему нельзя.
     *
     * @param {HTMLAnchorElement|null} link
     * @param {boolean} locked
     * @param {string} reason
     * @param {(reason: string, link: HTMLAnchorElement) => void} [onBlocked]
     */
    function lockNav(link, locked, reason, onBlocked) {
        if (!link) return;

        if (!link.__stemuiNavBound) {
            link.__stemuiNavBound = true;
            link.addEventListener('click', function (ev) {
                if (link.classList.contains('is-locked')) {
                    ev.preventDefault();
                    if (typeof onBlocked === 'function') {
                        onBlocked(link.title || 'Сейчас недоступно', link);
                    }
                }
            });
        }

        link.classList.toggle('is-locked', !!locked);
        link.setAttribute('aria-disabled', locked ? 'true' : 'false');

        if (locked) {
            link.title = reason || '';
        } else {
            link.title = '';
        }
    }

    /**
     * Навигация-контроллер: одна реализация «какие ссылки сейчас
     * неактивны» на сколько угодно страниц.
     *
     * Страница описывает только правила (busy/reason) - когда блокировать
     * и почему, - а механика (класс, aria, подсказка, отчёт о клике)
     * остаётся здесь.
     *
     * @param {{
     *   onBlocked?: (reason: string, link: HTMLAnchorElement) => void,
     *   links: Array<{el: HTMLAnchorElement|null, busy: () => boolean, reason: () => string}>
     * }} config
     * @returns {() => void} update
     */
    function createNav(config) {
        var cfg = config || {};
        var links = cfg.links || [];

        return function updateNav() {
            links.forEach(function (link) {
                var busy = false;
                try {
                    busy = !!link.busy();
                } catch (e) {
                    busy = false;
                }
                lockNav(link.el, busy, busy ? link.reason() : '', cfg.onBlocked);
            });
        };
    }

    /**
     * Подпись этапа для шкалы: по индексу этапа и числу сегментов.
     * Возвращает процент заполнения сегментированной шкалы.
     *
     * @param {number} index - индекс этапа (0-based)
     * @param {number} total - сколько сегментов у шкалы
     * @returns {number} 0..100
     */
    function stagePercent(index, total) {
        if (!total || total < 1) return 0;
        var i = Number(index);
        if (!isFinite(i) || i < 0) return 0;
        return Math.min(100, Math.round(((i + 1) / total) * 100));
    }

    return {
        LOG_LIFE_MS: LOG_LIFE_MS,
        LOG_FINAL_MS: LOG_FINAL_MS,
        createLogLine: createLogLine,
        lockNav: lockNav,
        createNav: createNav,
        stagePercent: stagePercent,
    };
})();
