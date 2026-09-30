import { state } from './store.js?v=80';
import { appendLog } from './utils.js?v=80';

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
    audio.addEventListener('pause', () => {
        setPlayGlyph(state.play.name, 'play');
        // Эквалайзер тулбара оживает только пока звучит музыка.
        if (window.StereoEq) window.StereoEq.detach();
    });
    audio.addEventListener('loadedmetadata', () => updatePlayBar());
    audio.addEventListener('ended', () => {
        setPlayGlyph(state.play.name, 'play');
        resetPlayBar(state.play.name);
        state.play.name = null;
        playNextInQueue();
    });
    audio.addEventListener('error', () => {
        setPlayGlyph(state.play.name, 'play');
        state.play.name = null;
        if (window.StereoEq) window.StereoEq.detach();
    });
    audio.addEventListener('timeupdate', () => updatePlayBar());

    // Стерео-эквалайзер: честное L/R через WebAudio-граф этого элемента.
    audio.addEventListener('play', () => {
        if (window.StereoEq) window.StereoEq.attachMedia(audio);
    });
}

// Значок play: inline-SVG. Раньше был «треугольник из бордеров» на боксе 0x0,
// который схлопывался под глобальным box-sizing:border-box — кнопка выглядела
// пустой. SVG рисуется всегда и наследует цвет кнопки через currentColor.
const SVG_NS = 'http://www.w3.org/2000/svg';

function playIcon() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'stem-glyph');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', 'M8 5.5v13l11-6.5z');
    svg.appendChild(path);
    return svg;
}

function buildPlayButton(name, done) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chan-play card-play';
    btn.dataset.name = name;
    btn.disabled = !done;

    const pPlay = document.createElement('span');
    pPlay.className = 'stem-pause';
    pPlay.append(document.createElement('i'), document.createElement('i'));
    btn.append(playIcon(), pPlay);

    btn.title = done ? 'Играть / пауза' : 'Не обработан';
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        togglePlay(name);
    });
    return btn;
}

function togglePlay(name) {
    const audio = state.play.audio;
    if (!audio) return;

    const row = state.rowRefs.get(name);
    if (!row || row.row.status !== 'done' || state.mode === 'processing' || state.mode === 'poll') return;

    if (state.play.name === name && audio.src !== '') {
        if (audio.paused) audio.play().catch(() => {});
        else audio.pause();
        return;
    }

    if (state.play.name && state.play.name !== name) {
        setPlayGlyph(state.play.name, 'play');
        resetPlayBar(state.play.name);
    }

    const url = `../music/inbox/${encodeURIComponent(name)}`;
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
    ref.playBtn.classList.toggle('is-active', mode === 'pause');
    ref.playBtn.title = mode === 'pause' ? 'Пауза' : 'Играть / пауза';
}

function resetPlayBar(name) {
    const ref = state.rowRefs.get(name);
    if (!ref || !ref.playFill) return;
    ref.playFill.style.width = '0%';
    // Не обнуляем время: оно должно быть видно и в покое (иначе в момент
    // остановки строка снова «съёживалась»), а длительность известна из списка.
    const d = ref.row && ref.row.duration;
    ref.playTime.textContent = (d != null && Number.isFinite(Number(d))) ? `0:00 / ${fmtMinSec(d)}` : '';
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

// «Подряд»: по окончании трека включаем следующий из текущего порядка списка,
// по кругу. Перескакиваем необработанные треки, у них play заблокирован.
function playNextInQueue() {
    const playable = state.rows.filter((r) => r.status === 'done').map((r) => r.name);
    if (playable.length === 0) return false;
    const cur = state.play.name;
    const idx = cur ? playable.indexOf(cur) : -1;
    const next = idx >= 0 ? playable[(idx + 1) % playable.length] : playable[0];
    togglePlay(next);
    return true;
}

// Кнопки play: заблокированы, пока идёт обработка (текущее окно или другое).
function syncPlayButtons() {
    const running = state.mode === 'processing' || state.mode === 'poll';
    state.rowRefs.forEach((ref) => {
        const done = ref.row.status === 'done';
        ref.playBtn.disabled = running || !done;
        ref.playBtn.title = running ? 'Обработка идёт' : done ? 'Играть / пауза' : 'Не обработан';
    });
}

export { initPlayer, buildPlayButton, bindSeek, applyPlaybackState, syncPlayButtons, fmtMinSec };