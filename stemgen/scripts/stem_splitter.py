#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Разделение одного трека на 4 стема (vocals/drums/bass/other) через Demucs.

Запускается python'ом из venv_demucs (там установлены torch+CUDA и demucs).

Примечание: в ТЗ была команда "--two-stems vocals" — она даёт только 2 файла
(vocals + no_vocals). Цель модуля — 4 стема, поэтому по умолчанию гоняем
полный htdemucs без --two-stems.

Usage:
  python stem_splitter.py <input> <output_dir> <id> <bpm> <key> <model> <bitrate> <two_stems:0|1>

- <output_dir>: каталог BPM…_Key… (родитель для {id}/).
- Результат: <output_dir>/<id>/{id}_{stem}.mp3 + meta.json.
- В stdout — построчно JSON, тот же протокол, что у analyzer.py:
    {"stage": "load"} | {"stage": "demucs"} | {"stage": "collect"} | {"stage": "save"}
    ...
    {"status": "done", "id": ..., "stems": [...]}
    {"status": "error", "message": "..."}
  PHP различает их по наличию ключа "stage": этапы — это прогресс (ими
  заполняется сегментированная шкала в карточке трека), status — итог.
"""

import glob
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone

sys.stdout.reconfigure(encoding="utf-8")

STEMS = ("vocals", "drums", "bass", "other")
TWO_STEMS_MAP = {"vocals": "vocals", "no_vocals": "other"}


def stage(name):
    """Сообщить текущий этап. Та же строка, что в analyzer.py.

    Demucs молчит всё время счёта (его stdout мы перехватываем), поэтому без
    таких сообщений карточка трека весь прогон показывала бы «генерация…» с
    пустой шкалой.
    """
    print(json.dumps({"stage": name}, ensure_ascii=False), flush=True)


def ensure_ffmpeg():
    """Demucs'у нужен ffmpeg (декод mp3 на входе + mp3-кодирование стемов).

    Apache-сервис может работать под системной учёткой, чей PATH не содержит
    установленный для пользователя ffmpeg. Ищем ffmpeg.exe напрямую в типовых
    местах установки и вставляем его каталог в PATH дочернего процесса demucs.
    """
    if shutil.which("ffmpeg"):
        return

    candidates = [
        os.path.join(os.environ.get("LOCALAPPDATA", ""), "Microsoft", "WinGet", "Packages"),
        "C:/ProgramData/chocolatey/bin",
        "C:/ffmpeg/bin",
        "C:/Program Files/ffmpeg/bin",
    ]

    hits = []
    for base in candidates:
        hits += glob.glob(os.path.join(base, "**", "ffmpeg.exe"), recursive=True)

    if hits:
        os.environ["PATH"] = os.path.dirname(hits[0]) + os.pathsep + os.environ.get("PATH", "")


def find_stems(output_dir):
    """{stem name -> абсолютный путь} : находит выходы Demucs рекурсивно."""
    found = {}

    for root, _, files in os.walk(output_dir):
        for f in files:
            stem_name = None
            stem = os.path.splitext(f)[0]
            if stem in STEMS:
                stem_name = stem
            elif f == "no_vocals.mp3":
                stem_name = "other"
            if stem_name and stem_name not in found:
                found[stem_name] = os.path.join(root, f)

    return found


def main(argv):
    if len(argv) < 8:
        result = {"status": "error",
                  "message": "Мало аргументов: <input> <output_dir> <id> <bpm> <key> <model> <bitrate> <two_stems>"}
        print(json.dumps(result, ensure_ascii=False))
        return 2

    input_file, output_dir, track_id, bpm, key, model, bitrate, two_stems = argv[:8]

    stage("load")

    ensure_ffmpeg()

    if not os.path.isfile(input_file):
        print(json.dumps({"status": "error", "message": "Файл не найден: " + input_file}, ensure_ascii=False))
        return 1

    if not os.path.isdir(output_dir):
        try:
            os.makedirs(output_dir, exist_ok=True)
        except OSError as e:
            print(json.dumps({"status": "error", "message": "Не создать каталог: " + str(e)}, ensure_ascii=False))
            return 1

    cmd = [
        sys.executable, "-m", "demucs",
        "-n", model,
        "--mp3", "--mp3-bitrate", bitrate,
        "-o", output_dir,
        input_file,
    ]

    if two_stems == "1":
        cmd[4:4] = ["--two-stems", "vocals"]

    # Дальше идёт собственно разделение - это 90% времени на трек.
    stage("demucs")

    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    except FileNotFoundError:
        print(json.dumps({"status": "error",
                          "message": "Не удалось запустить demucs. Проверьте venv_demucs (demucs+torch)."},
                         ensure_ascii=False))
        return 1

    if proc.returncode != 0:
        err = (proc.stderr or "").strip()
        text = (err[-2000:] if err else (proc.stdout or "").strip()[-1000:])
        print(json.dumps({"status": "error", "message": text or "Demucs завершился с ошибкой"}, ensure_ascii=False))
        return 1

    stage("collect")

    found = find_stems(output_dir)

    if not found:
        print(json.dumps({"status": "error",
                          "message": "Demucs не оставил стемов в " + output_dir}, ensure_ascii=False))
        return 1

    target_dir = os.path.join(output_dir, track_id)
    os.makedirs(target_dir, exist_ok=True)

    produced = []
    for stem_name, src in found.items():
        dst = os.path.join(target_dir, "{}_{}.mp3".format(track_id, stem_name))
        try:
            shutil.move(src, dst)
            produced.append(stem_name)
        except OSError as e:
            print(json.dumps({"status": "error", "message": "Ошибка переименования: " + str(e)}, ensure_ascii=False))
            return 1

    stage("save")

    # Мерджимся с уже существующим meta.json: его мог создать анализатор
    # (схема AnalysisRunner::writeStemMeta) — сохраняем что записано.
    meta_path = os.path.join(target_dir, "meta.json")
    existing = {}
    if os.path.isfile(meta_path):
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                existing = json.load(f)
        except (OSError, ValueError):
            existing = {}

    meta = dict(existing)
    meta["original_name"] = os.path.basename(input_file)
    if bpm.isdigit():
        meta["bpm"] = int(bpm)
    meta["key"] = key
    meta["updated_at"] = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")

    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    # Зачистка мусора Demucs (<output_dir>/<model>/<track>/...): файлы уже переехали.
    model_dir = os.path.join(output_dir, model)
    if os.path.isdir(model_dir):
        shutil.rmtree(model_dir, ignore_errors=True)

    stage("done")
    print(json.dumps({"status": "done", "id": track_id, "stems": produced}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))