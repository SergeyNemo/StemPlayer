'use strict';
(function (G) {
    // Управляет AudioContext, мастер-гейном и спектром.
    // Активный трек — один; play переключает, повторный клик — стоп.
    class Player {
        constructor() {
            this.ctx = null;
            this.master = null;
            this.analyser = null;
            this.activeTrack = null;
            this.onChange = null;
            // Метка «клика по волне»: пока грузились буферы, клик мог
            // устареть (новый клик, play, стоп) — и его надо отбросить.
            this.seekToken = 0;
        }

        ensureCtx() {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return null;
            if (!this.ctx) {
                const ctx = new AC();
                const master = ctx.createGain();
                master.gain.value = 1;
                const an = ctx.createAnalyser();
                an.fftSize = 512;
                an.smoothingTimeConstant = 0.82;
                master.connect(an);
                an.connect(ctx.destination);
                this.ctx = ctx;
                this.master = master;
                this.analyser = an;
            }
            if (this.ctx.state === 'suspended') this.ctx.resume();
            return this.ctx;
        }

        // offset — с какого места трека стартовать (0 = с начала, как раньше).
        async play(track, offset) {
            const ctx = this.ensureCtx();
            if (!ctx) return;
            if (this.activeTrack && this.activeTrack !== track) this.activeTrack.stop();
            this.activeTrack = track;
            this.notify();
            try {
                await track.prepare(ctx);
            } catch (e) {
                this.activeTrack = null;
                this.notify();
                if (window.StereoEq) window.StereoEq.detach();
                return;
            }
            if (this.activeTrack !== track) return; // пока декодировали — уже переключили
            track.stems.forEach((s) => { s.attach(this.master); s.applyMix(); });
            track.play(ctx.currentTime + 0.05, () => {
                // Доиграл до конца — активный трек исчезает.
                if (this.activeTrack === track) this.stop();
            }, offset);
            this.notify();
            // Эквалайзер тулбара: зеркалим спектр мастера на обе стороны.
            if (window.StereoEq) window.StereoEq.attachAnalyser(this.analyser);
        }

        toggle(track) {
            if (this.activeTrack === track) this.stop();
            else this.play(track, 0);
        }

        // Клик/перетаскивание по волне стема. frac — доля 0..1, а не секунды:
        // у ещё не декодированного трека длительности нет, и по числу секунд
        // клик пришлось бы просто проигнорировать. Играет этот трек —
        // перематываем на месте (звук не прерывается); не играет — стартуем
        // с этого места, как будто play нажали в этой точке.
        async seekTo(track, frac) {
            if (!track) return;
            const ctx = this.ensureCtx();
            if (!ctx) return;

            const ratio = Math.max(0, Math.min(1, Number(frac) || 0));
            const token = ++this.seekToken;
            const wasActive = this.activeTrack;

            if (!track.stems.some((s) => s.buffer)) {
                try {
                    await track.prepare(ctx);
                } catch (e) {
                    return;
                }
                // Если во время асинхронной подготовки состояние изменилось (seek/стоп), отменяем операцию.
                if (token !== this.seekToken || this.activeTrack !== wasActive) return;
            }

            const dur = track.duration;
            if (!dur || !isFinite(dur)) return;
            const time = ratio * dur;

            if (this.activeTrack === track) {
                // Перезапуск источников на новом месте. Гейны и анализаторы
                // стемов переиспользуются (attach — no-op, если gain уже есть),
                // поэтому уровнемеры и EQ продолжают работать без пересоздания.
                track.stems.forEach((s) => { s.attach(this.master); s.applyMix(); });
                track.play(ctx.currentTime + 0.02, () => {
                    if (this.activeTrack === track) this.stop();
                }, time);
                this.notify();
            } else {
                this.play(track, time);
            }
        }

        stop() {
            if (this.activeTrack) this.activeTrack.stop();
            this.activeTrack = null;
            this.notify();
            if (window.StereoEq) window.StereoEq.detach();
        }

        notify() {
            if (this.onChange) this.onChange(this.activeTrack);
        }
    }

    G.Player = Player;
    G.player = new Player();
})(window.StemGen);