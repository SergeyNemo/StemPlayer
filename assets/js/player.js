import { state, els } from './store.js';
import { appendLog } from './utils.js';

// ---------- Плеер ----------

function fmtMinSec(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function initPlayer() {
    const audio = new Audio();
    audio.preload = 'metadata';
    state.play.audio = audio;

    audio.addEventListener('play', () => setPlayGlyph(state.play.name, 'pause'));
    audio.addEventListener('pause', () => setPlayGlyph(state.play.name, 'play'));
    audio.addEventListener('loadedmetadata', () => updatePlayBar());
    audio.addEventListener('ended', () => {
        if (els.queueCheck.checked && playNextInQueue()) {
            return;
        }
        setPlayGlyph(state.play.name, 'play');
        resetPlayBar(state.play.name);
        state.play.name = null;
    });
    audio.addEventListener('error', () => {
        setPlayGlyph(state.play.name, 'play');
        state.play.name = null;
    });
    audio.addEventListener('timeupdate', () => updatePlayBar());
}

function buildPlayButton(name) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'play-btn';
    btn.dataset.name = name;
    btn.title = 'Прослушать';

    const glyph = document.createElement('span');
    glyph.className = 'play-glyph';
    const pause = document.createElement('span');
    pause.className = 'play-pause';
    pause.append(document.createElement('span'), document.createElement('span'));
    btn.append(glyph, pause);

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        togglePlay(name);
    });
    return btn;
}

function togglePlay(name) {
    const audio = state.play.audio;
    if (!audio) return;

    if (state.play.name === name && audio.src !== '') {
        if (audio.paused) audio.play().catch(() => {});
        else audio.pause();
        return;
    }

    if (state.play.name && state.play.name !== name) {
        setPlayGlyph(state.play.name, 'play');
        resetPlayBar(state.play.name);
    }

    const url = `music/inbox/${encodeURIComponent(name)}`;
    state.play.name = name;
    audio.src = url;
    audio.play().catch((err) => {
        appendLog({ time: '--:--:--', type: 'error', message: `Не удалось проиграть «${name}»: ${err.message || 'ошибка источника'}` });
        setPlayGlyph(name, 'play');
    });
}

function setPlayGlyph(name, mode) {
    const ref = state.rowRefs.get(name);
    if (!ref || !ref.playBtn) return;
    ref.playBtn.classList.toggle('is-playing', mode === 'pause');
    ref.playBtn.title = mode === 'pause' ? 'Пауза' : 'Прослушать';
}

function resetPlayBar(name) {
    const ref = state.rowRefs.get(name);
    if (!ref || !ref.playFill) return;
    ref.playFill.style.width = '0%';
    ref.playTime.textContent = '';
}

function updatePlayBar() {
    const audio = state.play.audio;
    const name = state.play.name;
    const ref = audio && state.rowRefs.get(name);
    if (!ref || !ref.playFill) return;

    const dur = audio.duration;
    const cur = audio.currentTime || 0;
    if (dur && Number.isFinite(Number(dur))) {
        ref.playFill.style.width = `${Math.min(100, (cur / dur) * 100)}%`;
        ref.playTime.textContent = `${fmtMinSec(cur)} / ${fmtMinSec(dur)}`;
    } else {
        ref.playFill.style.width = '0%';
        ref.playTime.textContent = `${fmtMinSec(cur)}`;
    }
}

function bindSeek(bar, name) {
    let seeking = false;
    const seekTo = (e) => {
        const audio = state.play.audio;
        if (!audio || state.play.name !== name) return;
        const dur = audio.duration;
        if (!dur || !Number.isFinite(Number(dur))) return;
        const rect = bar.getBoundingClientRect();
        const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
        audio.currentTime = frac * dur;
        const ref = state.rowRefs.get(name);
        if (ref) {
            ref.playFill.style.width = `${frac * 100}%`;
            ref.playTime.textContent = `${fmtMinSec(frac * dur)} / ${fmtMinSec(dur)}`;
        }
    };
    bar.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        seeking = true;
        bar.setPointerCapture(e.pointerId);
        seekTo(e);
    });
    bar.addEventListener('pointermove', (e) => {
        if (seeking) seekTo(e);
    });
    const stop = () => { seeking = false; };
    bar.addEventListener('pointerup', stop);
    bar.addEventListener('pointercancel', stop);
}

function applyPlaybackState() {
    if (!state.play.name) return;
    const audio = state.play.audio;
    if (!audio || audio.paused) return;
    const ref = state.rowRefs.get(state.play.name);
    if (!ref) return;
    setPlayGlyph(state.play.name, 'pause');
    updatePlayBar();
}

// «Подряд»: по окончании трека включаем следующий из текущего порядка списка.
function playNextInQueue() {
    const list = state.rows.map((r) => r.name);
    if (list.length === 0) return false;
    const cur = list.indexOf(state.play.name);
    const next = cur >= 0 ? list[(cur + 1) % list.length] : list[0];
    togglePlay(next);
    return true;
}

export { initPlayer, buildPlayButton, bindSeek, applyPlaybackState };