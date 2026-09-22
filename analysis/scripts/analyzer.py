#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
analyzer.py — лёгкий анализатор аудио файлов.
Возможности:
  * BPM  — librosa.beat.beat_track по первым 30 секундам трека;
  * Key  — корреляция хромы с профилями Крамхансла–Шмюклера;
  * метаданные — mutagen (title/artist/album/duration).

Использование:
    python analyzer.py /path/to/track.mp3

Вывод (STDOUT, JSON):
    {"status": "success", "bpm": 128, "key": "Am", ...}
    {"status": "error", "message": "..."}
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
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


def emit_error(message: str) -> None:
    print(json.dumps({"status": "error", "message": str(message)}, ensure_ascii=False))
    sys.stdout.flush()


class ProgressReporter:
    """
    Пишет живой прогресс в JSON-файл {"fraction": 0..1, "phase": "..."},
    который PHP опрашивает в цикле (stream-вывод на Windows блокируется).

    Главный поток ставит target (0..1) на каждом этапе, а фоновый поток
    плавно подтягивает текущее значение к нему и обновляет файл каждые 150 мс.
    """

    def __init__(self, progress_file: str | None = None) -> None:
        self._lock = threading.Lock()
        self._value = 0.0
        self._target = 0.0
        self._phase = "начало"
        self._stop = threading.Event()
        self._progress_file = progress_file
        self._emit_file(0.0, "старт")
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def target(self, value: float, phase: str) -> None:
        with self._lock:
            self._target = min(1.0, max(0.0, value))
            self._phase = phase

    def _loop(self) -> None:
        while not self._stop.is_set():
            with self._lock:
                self._value += (self._target - self._value) * 0.35
                value, phase = self._value, self._phase

            if abs(self._target - value) < 0.01:
                value = self._target

            self._emit_file(value, phase)
            self._stop.wait(0.15)

    def _emit_file(self, value: float, phase: str) -> None:
        if not self._progress_file:
            return
        try:
            tmp = self._progress_file + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump({"fraction": round(value, 3), "phase": phase}, fh, ensure_ascii=False)
            os.replace(tmp, self._progress_file)
        except OSError:
            pass

    def stop(self) -> None:
        if not self._stop.is_set():
            self._stop.set()
            self._thread.join(timeout=0.5)


def main() -> None:
    if len(sys.argv) < 2:
        emit_error("Не указан путь к аудиофайлу.")
        return

    path = sys.argv[1]
    progress_file = sys.argv[2] if len(sys.argv) > 2 else None

    if not os.path.isfile(path):
        emit_error(f"Файл не существует: {path}")
        return

    reporter = ProgressReporter(progress_file)

    try:
        reporter.target(0.04, "инициализация")
        y, sr = librosa.load(path, duration=30, sr=22050, mono=True)

        if y.size == 0:
            raise ValueError("В первых 30 секундах трека нет аудио (пустой сигнал).")

        reporter.target(0.55, "загрузка аудио")
        bpm = estimate_bpm(y, sr)

        reporter.target(0.80, "определение BPM")
        key = estimate_key(y, sr)

        reporter.target(0.93, "определение тональности")
        meta = read_metadata(path)

        reporter.target(0.97, "метаданные")

        print(json.dumps({
            "status": "success",
            "bpm": int(round(float(bpm))),
            "key": key,
            "duration": meta["duration"],
            "duration_analyzed": round(float(len(y) / sr), 2),
            "title": meta["title"],
            "artist": meta["artist"],
            "album": meta["album"],
        }, ensure_ascii=False))
        sys.stdout.flush()

        reporter.target(1.0, "готово")
        time.sleep(0.2)
    except Exception as exc:  # noqa: BLE001 — скрипт обязан отвечать JSON.
        emit_error(exc)
    finally:
        reporter.stop()


def estimate_bpm(y: np.ndarray, sr: int) -> float:
    """Определяет темп. Совместим с librosa >= 0.10 (возвращает кортеж)."""
    try:
        tempo, _beats = librosa.beat.beat_track(y=y, sr=sr, hop_length=256)
    except (TypeError, ValueError):
        tempo = librosa.beat.beat_track(y=y, sr=sr, hop_length=256)[0]

    return float(np.atleast_1d(np.asarray(tempo))[0])


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