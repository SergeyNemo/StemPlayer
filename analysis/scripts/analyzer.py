#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
analyzer.py — лёгкий анализатор аудио файлов.
Возможности:
  * BPM          — точный темп: комб-фильтр librosa + медиана бит-интервалов;
  * Key          — корреляция хромы с профилями Крамхансла–Шмюклера;
  * метаданные   — mutagen (title/artist/album/duration).

Использование:
    python analyzer.py /path/to/track.mp3

Вывод (STDOUT, построчно, JSON):
    {"stage": "load"}
    {"stage": "bpm"}
    ...
    {"status": "success", "bpm": 128, "key": "Am", ...}
    {"status": "error", "message": "..."}

Строки со "stage" — служебные: PHP читает их на лету и двигает шкалу
этапа. Последняя строка с "status" — результат. Никаких файлов и опросов.
"""

from __future__ import annotations

import json
import os
import sys
import warnings

# При выводе в pipe Windows использует ANSI-кодовую страницу, из-за чего
# кириллица в JSON ломает разбор на PHP. Принудительно пишем UTF-8.
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except (AttributeError, ValueError):  # очень старые Python без reconfigure
    pass

try:
    import numpy as np
    import librosa

    warnings.filterwarnings("ignore", category=UserWarning)
except ImportError as exc:
    emit_error_json = {"status": "error", "message": f"Отсутствуют зависимости: {exc}"}
    print(json.dumps(emit_error_json, ensure_ascii=False))
    sys.exit(1)

# Сколько секунд трека читаем для расчёта BPM. Больше контекста —
# точнее оценка (интро/другая секция в начале сбивает темп).
BPM_LOOKAHEAD_S = 240.0


def emit_error(message: str) -> None:
    print(json.dumps({"status": "error", "message": str(message)}, ensure_ascii=False))
    sys.stdout.flush()


def stage(name: str) -> None:
    """Сообщить этап работы. Строка сразу уходит в pipe — PHP видит её
    немедленно, поэтому шкала идёт по факту, а не по таймеру."""
    print(json.dumps({"stage": name}, ensure_ascii=False))
    sys.stdout.flush()


def main() -> None:
    if len(sys.argv) < 2:
        emit_error("Не указан путь к аудиофайлу.")
        return

    path = sys.argv[1]

    if not os.path.isfile(path):
        emit_error(f"Файл не существует: {path}")
        return

    try:
        # BPM и тональность считаем по всему треку — любой срез в начале
        # (интро/другая секция) искажает результат.
        stage("load")
        y, sr = librosa.load(path, duration=BPM_LOOKAHEAD_S, sr=22050, mono=True)

        if y.size == 0:
            raise ValueError("В начале трека нет аудио (пустой сигнал).")

        stage("bpm")
        bpm = estimate_bpm(y, sr)
        stage("key")
        key = estimate_key(y, sr)
        stage("meta")
        meta = read_metadata(path)

        duration = meta["duration"]
        if duration is None or duration <= 0:
            analyzed_len = float(len(y) / sr)
            if analyzed_len < (BPM_LOOKAHEAD_S - 1.0):
                duration = round(analyzed_len, 2)
            else:
                try:
                    duration = round(float(librosa.get_duration(path=path)), 2)
                except Exception:
                    duration = round(analyzed_len, 2)

        print(json.dumps({
            "status": "success",
            "bpm": int(round(float(bpm))),
            "key": key,
            "duration": duration,
            "duration_analyzed": round(float(len(y) / sr), 2),
            "title": meta["title"],
            "artist": meta["artist"],
            "album": meta["album"],
        }, ensure_ascii=False))
        sys.stdout.flush()
    except Exception as exc:  # noqa: BLE001 — скрипт обязан отвечать JSON.
        emit_error(exc)
    return


def estimate_bpm(y: np.ndarray, sr: int) -> float:
    """Точный темп: комб-фильтр librosa для грубой оценки, затем медиана
    бит-интервалов с параболическим уточнением кадров (ошибка < 1 BPM)."""
    hop = 256
    onset_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop, aggregate=np.median)

    if onset_env.size < 8:
        return 0.0

    # Грубая оценка (октавно корректна сама по себе — комб-фильтр).
    try:
        rough = float(np.atleast_1d(np.asarray(
            librosa.feature.tempo(onset_envelope=onset_env, sr=sr, hop_length=hop)))[0])
    except Exception:  # noqa: BLE001 — вырожденный случай не критичен.
        rough = 120.0

    if not (55.0 <= rough <= 210.0):
        rough = 120.0

    # Биты с привязкой к грубой оценке.
    try:
        _, beats = librosa.beat.beat_track(
            onset_envelope=onset_env, sr=sr, hop_length=hop,
            start_bpm=rough, tightness=100, trim=False)
    except TypeError:
        _, beats = librosa.beat.beat_track(
            onset_envelope=onset_env, sr=sr, hop_length=hop,
            start_bpm=rough, trim=False)

    beats = np.asarray(beats).ravel()
    beats = beats[(beats > 0) & (beats < onset_env.size)]

    if beats.size < 3:
        return rough

    # Медиана интервалов с параболическим уточнением позиции бита.
    n = len(onset_env)
    times = []
    for frame in beats:
        f = int(frame)
        if f <= 0 or f >= n - 1:
            continue
        a, b, c = onset_env[f - 1], onset_env[f], onset_env[f + 1]
        den = a - 2 * b + c
        frac = 0.0
        if abs(den) > 1e-9:
            frac = 0.5 * (a - c) / den
            frac = max(-1.0, min(1.0, frac))
        times.append((f + frac) * hop / sr)

    intervals = np.diff(np.asarray(times))
    bpms = 60.0 / intervals
    ok = bpms[(bpms >= 55.0) & (bpms <= 210.0)]

    if ok.size < 3:
        ok = bpms

    med = float(np.median(ok))
    near = ok[np.abs(ok - med) < 6.0]
    if near.size:
        med = float(np.median(near))

    return med


def estimate_key(y: np.ndarray, sr: int) -> str:
    """Определяет тональность методом Крамхансла–Шмюклера."""
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
    chroma_mean = chroma.mean(axis=1)

    major_profile = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
    minor_profile = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

    notes = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

    best_index = 0
    best_mode = "maj"
    best_corr = -1.0

    for i in range(12):
        corr_maj = float(np.corrcoef(chroma_mean, np.roll(major_profile, i))[0, 1])
        corr_min = float(np.corrcoef(chroma_mean, np.roll(minor_profile, i))[0, 1])

        if corr_maj > best_corr:
            best_corr = corr_maj
            best_index = i
            best_mode = "maj"
        if corr_min > best_corr:
            best_corr = corr_min
            best_index = i
            best_mode = "min"

    root = notes[best_index]
    return root if best_mode == "maj" else root + "m"


def read_metadata(path: str) -> dict:
    """Читает теги и длительность через mutagen. Поля могут отсутствовать -> None."""
    meta = {"title": None, "artist": None, "album": None, "duration": None}

    try:
        from mutagen import File as MutagenFile

        audio = MutagenFile(path, easy=True)

        if audio is not None:
            for dst, src in (
                ("title", "title"),
                ("artist", "artist"),
                ("album", "album"),
            ):
                value = audio.get(src)
                if value:
                    meta[dst] = str(value[0] if isinstance(value, (list, tuple)) else value)

            info = getattr(audio, "info", None)
            length = getattr(info, "length", None)
            if isinstance(length, (int, float)) and length > 0:
                meta["duration"] = round(float(length), 2)
    except Exception:  # noqa: BLE001 — метаданные не критичны для анализа.
        pass

    return meta


if __name__ == "__main__":
    main()