'use strict';
(function (G) {
    const { player, ui } = G;
    const EQ_SEGS = 10;

    // Активный EQ-уровнемер: показывает уровень стема, а тянуть его — менять
    // громкость. Заполнение снизу = нижняя «ручка». Мут — галкой под EQ.
    class LevelMeter {
        constructor(stem) {
            this.stem = stem;
            this.data = null;

            this.el = document.createElement('div');
            this.el.className = 'chan-eq';
            this.el.title = 'Громкость: тянуть вверх-вниз или колесо мыши. Внизу — включение канала';

            this.fill = document.createElement('div');
            this.fill.className = 'eq-fill';
            this.el.appendChild(this.fill);

            this.pct = document.createElement('span');
            this.pct.className = 'chan-eq-pct';

            this.segs = [];
            for (let i = 0; i < EQ_SEGS; i++) {
                const s = document.createElement('i');
                this.segs.push(s);
                this.el.appendChild(s);
            }

            this.el.addEventListener('pointerdown', (e) => {
                e.preventDefault();
                this.el.setPointerCapture(e.pointerId);
                this.setFromEvent(e);
            });
            this.el.addEventListener('pointermove', (e) => {
                if (e.buttons & 1) this.setFromEvent(e);
            });
            this.el.addEventListener('wheel', (e) => {
                e.preventDefault();
                // Шаг 5% — и ровно настолько же должен вырасти «ручка»: height
                // заливки идёт в % без пиксельного потолка (см. stemgen.css).
                this.setVolume(this.stem.volume + (e.deltaY < 0 ? 0.05 : -0.05));
            });

            this.update();
        }

        setFromEvent(e) {
            const rect = this.el.getBoundingClientRect();
            if (!rect.height) return;
            const y = rect.height - (e.clientY - rect.top);
            const ratio = Math.max(0, Math.min(1, (y / rect.height) / 0.95));
            this.setVolume(Math.round(ratio * 100) / 100);
        }

        // Любое изменение громкости идёт через Stem.setVolume: он же решает,
        // глушить ли канал (громкость 0 -> авто-мут), и зовёт onMix, который
        // обновляет и подпись, и галку. Дублировать логику здесь нельзя.
        setVolume(value) {
            this.stem.setVolume(value);
            this.update();
        }

        // «Ручка» громкости (нижняя заливка) + проценты над EQ.
        // Высота — scaleY с масштабом 0.95: при 100% громкости верхний отступ
        // равен положению на 95% и идеально гармонирует с рамкой элемента.
        update() {
            const v = this.stem.volume;
            const fillScale = v * 0.95;
            this.fill.style.transform = `translateX(-50%) scaleY(${fillScale})`;
            this.pct.textContent = `${Math.round(v * 100)}%`;
        }

        // Прыгающие линии уровня. null — спрятать.
        setLevel(value) {
            if (value == null) {
                this.segs.forEach((s) => s.style.setProperty('--high', '0'));
                this.data = null;
                return;
            }
            this.segs.forEach((s, i) => {
                s.style.setProperty('--high', i >= EQ_SEGS - value ? '1' : '0.12');
            });
        }
    }

    G.LevelMeter = LevelMeter;

    // Обновление уровнемеров: берём уровень из анализатора стема.
    G.updateEqUi = function updateEqUi() {
        ui.forEach((r) => {
            const meter = r.ch.meter;
            const an = r.stem.analyser;
            if (!an || player.activeTrack !== r.track) {
                meter.setLevel(null);
                return;
            }
            if (!meter.data || meter.data.length !== an.frequencyBinCount) {
                meter.data = new Uint8Array(an.frequencyBinCount);
            }
            an.getByteFrequencyData(meter.data);
            if (!r.stem.enabled) {
                meter.setLevel(null);
                return;
            }
            let sum = 0;
            for (let i = 0; i < meter.data.length; i++) sum += meter.data[i];
            const raw = Math.min(1, (sum / (meter.data.length * 255)) * 3.2);
            // Полоски не заходят за «ручку» громкости: потолок = громкость канала.
            const level = Math.min(raw, r.stem.volume);
            meter.setLevel(Math.ceil(level * EQ_SEGS));
        });
    };
})(window.StemGen);