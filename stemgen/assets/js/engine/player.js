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

        async play(track) {
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
            });
            this.notify();
            // Эквалайзер тулбара: зеркалим спектр мастера на обе стороны.
            if (window.StereoEq) window.StereoEq.attachAnalyser(this.analyser);
        }

        toggle(track) {
            if (this.activeTrack === track) this.stop();
            else this.play(track);
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