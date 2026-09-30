'use strict';
(function (G) {
    // Движок воспроизведения (чистый, без DOM).
    // Стем декодируется в AudioBuffer и проигрывается BufferSource-ом.
    // Состояния стема: 'absent' (файла нет), 'muted' (приглушён),
    // 'active' (звучит, когда трек играет). 'off' — признак воспроизведения,
    // живёт в Channel (трек не играет).

    // Громкость при включении нового стема.
    const DEFAULT_VOLUME = 0.8;

    class Stem {
        constructor(kind, url, rev) {
            this.kind = kind;
            this.url = url;
            // mtime файла (сервер, StemRegistry::stemRevs). Ключ кеша
            // волновой формы: перегенерировали стем — форма пересчитается.
            this.rev = rev || 0;
            this.volume = DEFAULT_VOLUME;
            // enabled — производная от громкости: канал слышен ровно пока
            // громкость > 0. Галка в интерфейсе — это «канал включён».
            this.enabled = true;
            // Последняя ненулевая громкость: чтобы приглушение галкой не
            // теряло настройку — снял галку (тихо), вернул -> звук как было.
            this.lastVolume = DEFAULT_VOLUME;
            this.onMix = null;
            this.ctx = null;
            this.buffer = null;
            this.gain = null;
            this.analyser = null;
            this.source = null;
            this.startAt = 0;
            // Смещение внутри буфера, с которого запущен источник (перемотка).
            // В currentTime оно обязательно: ctx.currentTime - startAt даёт
            // время от старта ИСТОЧНИКА, а не от начала трека.
            this.offset = 0;
        }

        get duration() { return this.buffer ? this.buffer.duration : 0; }

        get hasAudio() { return !!this.url; }

        get state() {
            if (!this.hasAudio) return 'absent';
            return this.enabled ? 'active' : 'muted';
        }

        get currentTime() {
            if (!this.source || !this.ctx) return 0;
            const t = this.ctx.currentTime - this.startAt + this.offset;
            return Math.max(0, Math.min(t, this.duration));
        }

        async load(ctx) {
            if (this.buffer || !this.url) return;
            const res = await fetch(this.url);
            if (!res.ok) throw new Error(`${this.kind}: HTTP ${res.status}`);
            const data = await res.arrayBuffer();
            this.buffer = await ctx.decodeAudioData(data);
            this.ctx = ctx;
        }

        attach(master) {
            if (this.gain || !this.ctx) return;
            const g = this.ctx.createGain();
            g.gain.value = this.enabled ? this.volume : 0;
            // Свой анализатор уровня: источник питает его, а он — мастер.
            const an = this.ctx.createAnalyser();
            an.fftSize = 64;
            an.smoothingTimeConstant = 0;
            g.connect(an);
            an.connect(master);
            this.gain = g;
            this.analyser = an;
        }

        applyMix() {
            if (this.gain) this.gain.gain.value = this.enabled ? this.volume : 0;
        }

        // Единая точка смены громкости: сама решает вопрос мута.
        // 0 -> канал глушится (галка снимется), >0 -> галка возвращается.
        setVolume(value) {
            const v = Math.max(0, Math.min(1, Number(value) || 0));

            this.volume = v;
            this.enabled = v > 0;

            if (v > 0) {
                this.lastVolume = v;
            }

            this.applyMix();

            if (this.onMix) this.onMix();
        }

        // Включение/выключение канала галкой. Выключение не стирает громкость:
        // она запоминается и возвращается при следующем включении.
        setEnabled(on) {
            if (!this.hasAudio) return;

            if (on) {
                this.volume = this.lastVolume > 0 ? this.lastVolume : DEFAULT_VOLUME;
                this.enabled = true;
            } else {
                if (this.volume > 0) {
                    this.lastVolume = this.volume;
                }
                this.volume = 0;
                this.enabled = false;
            }

            this.applyMix();

            if (this.onMix) this.onMix();
        }

        // offset — с какого места буфера играть (перемотка). Без него start
        // идёт с нуля, и после стоп/переключения трек всегда начинался заново.
        // offset >= duration Chrome считает RangeError, поэтому уходим на
        // последние 20 мс: трек доиграет и сам выключится, как и должен.
        play(when, onEnd, offset) {
            this.stop();
            if (!this.ctx || !this.buffer || !this.gain) return;
            const dur = this.buffer.duration;
            const off = Math.max(0, Math.min(Number(offset) || 0, Math.max(0, dur - 0.02)));
            const src = this.ctx.createBufferSource();
            src.buffer = this.buffer;
            src.connect(this.gain);
            src.onended = () => { if (onEnd) onEnd(this); };
            src.start(when, off);
            this.source = src;
            this.startAt = when;
            this.offset = off;
        }

        stop() {
            if (this.source) {
                try { this.source.stop(); } catch (e) { /* уже завершён */ }
                try { this.source.disconnect(); } catch (e) { /* ignore */ }
                this.source.onended = null;
                this.source = null;
            }
            this.offset = 0;
        }
    }

    G.Stem = Stem;
})(window.StemGen);