'use strict';

/**
 * Общее UI-ядро StemPlayer. Один файл на оба модуля.
 *
 * Зачем он общий: «Обработка» и «Стемы» — это разные страницы одного
 * приложения, и поведение верхней панели у них обязано совпадать
 * (блокировка ссылок, статус-бейдж, лента прогресса). Раньше это было
 * написано дважды, и правки разъезжались: на «Стемах» ссылка
 * «Обработка» оставалась активной во время генерации, а на «Обработке»
 * кнопка «Стемы» не блокировалась по «нет готовых треков».
 *
 * Подключается обычным <script> (не модуль) — модульные системы у
 * страниц разные (analysis на ES-модулях, stemgen на window.StemGen),
 * а этот код нужен обеим. Классический скрипт грузится раньше
 * отложенных модулей, поэтому window.StemUI уже готов к моменту
 * их запуска.
 */
window.StemUI = (function () {
    'use strict';

    /** Сколько живёт терминальный статус в бейдже, потом тихо гаснет в idle. */
    var BADGE_HOLD_MS = 3000;

    /** Статусы, которые показываем ненадолго и потом возвращаем в idle. */
    var HOLD_STATES = ['complete', 'error'];

    // ---------------------------------------------------------------- бейдж

    /**
     * Бейдж статуса в шапке.
     *
     * Идея: после завершения прогона бейдж не должен навсегда висеть
     * надписью COMPLETE - прогон давно закончился, и следующий щелчок
     * «Обработать» всё равно начинает с чистого листа. Поэтому
     * complete/error показываем 3 секунды, потом тихо гасим в idle.
     *
     * @param {HTMLElement|null} el
     * @param {{holdMs?: number}} [opts]
     * @returns {(status: string) => void}
     */
    function createBadge(el, opts) {
        var holdMs = (opts && opts.holdMs) || BADGE_HOLD_MS;
        var timer = null;
        var shown = false;

        function paint(status) {
            if (!el) return;
            var value = status === 'stopped' ? 'idle' : (status || 'idle');
            el.dataset.state = value;
            el.textContent = value.replace('_', ' ');
        }

        function clear() {
            if (timer !== null) {
                clearTimeout(timer);
                timer = null;
            }
        }

        return function setBadge(status) {
            var value = status === 'stopped' ? 'idle' : (status || 'idle');

            if (HOLD_STATES.indexOf(value) === -1) {
                clear();
                shown = false;
                paint(value);
                return;
            }

            // Пока держим терминальный статус - повторные опросы (каждые
            // 2 с) не должны перезапускать 3-секундный отсчёт заново.
            if (shown) return;

            shown = true;
            paint(value);

            timer = setTimeout(function () {
                timer = null;
                shown = false;
                paint('idle');
            }, holdMs);
        };
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
        BADGE_HOLD_MS: BADGE_HOLD_MS,
        HOLD_STATES: HOLD_STATES,
        createBadge: createBadge,
        lockNav: lockNav,
        createNav: createNav,
        stagePercent: stagePercent,
    };
})();
