#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Каскадное разделение стема (Music/other) на guitar и piano через Demucs.

Вход — уже готовый стем {ID}_other.mp3 (в интерфейсе подписан как Music).
Запускается python'ом из venv_demucs (torch+CUDA и demucs), модель 6s.

В отличие от stem_splitter.py, который режет оригинал на 4 базовых стема,
здесь идёт ВТОРОЙ проход модели: берём other и достаём из него guitar/piano.

Usage:
  python split_instrument.py <input_mp3> <output_dir> <track_id> <model> <bitrate> <shifts> <overlap>

- <input_mp3>: абсолютный путь к {ID}_other.mp3.
- <output_dir>: абсолютный путь к папке {ID}/ (куда класть guitar/piano).
- <shifts>: TTA-усреднение Demucs (--shifts): больше — чище, но кратно дольше.
- <overlap>: перекрытие сегментов (--overlap): больше — меньше «швов».
- Результат: <output_dir>/{ID}_guitar.mp3 и <output_dir>/{ID}_piano.mp3.
- В stdout — построчно JSON, тот же протокол, что у analyzer.py/stem_splitter.py:
    {"stage": "load"} | {"stage": "demucs"} | {"stage": "save"} | {"stage": "done"}
    {"status": "done", "id": ..., "stems": [...]}
    {"status": "error", "message": "..."}
  PHP различает их по наличию ключа "stage": этапы — прогресс (сегментированная
  шкала в карточке трека), status — итог.
"""

import glob
import json
import os
import shutil
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8")

# Что достаём из стема other. Порядок — как в ProgressStore::STEMGEN_CASCADE_STEMS.
CASCADE_STEMS = ("guitar", "piano")

# Временный подкаталог внутри {ID}/: сюда Demucs складывает сырые выходы
# (включая лишние для нас vocals/drums/bass/other), отсюда переносим нужное.
TEMP_DIRNAME = "_temp_cascade"


def stage(name):
    """Сообщить текущий этап. Та же строка, что в analyzer.py/stem_splitter.py."""
    print(json.dumps({"stage": name}, ensure_ascii=False), flush=True)


def ensure_ffmpeg():
    """Demucs'у нужен ffmpeg (декод mp3 на входе + mp3-кодирование стемов).

    Apache-сервис может работать под системной учёткой, чей PATH не содержит
    установленный для пользователя ffmpeg. Ищем ffmpeg.exe напрямую в типовых
    местах установки и вставляем его каталог в PATH дочернего процесса demucs.
    Копия из stem_splitter.py — функция маленькая и намеренно одинаковая.
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


def find_stem(output_dir, stem_name):
    """Абсолютный путь к <stem_name>.mp3 в выходах Demucs (рекурсивно) или None."""
    for root, _, files in os.walk(output_dir):
        for f in files:
            if f == stem_name + ".mp3":
                return os.path.join(root, f)

    return None


def main(argv):
    if len(argv) < 5:
        print(json.dumps({
            "status": "error",
            "message": "Мало аргументов: <input_mp3> <output_dir> <track_id> <model> <bitrate> [shifts] [overlap]",
        }, ensure_ascii=False))
        return 2

    input_file, output_dir, track_id, model, bitrate = argv[:5]
    # П.1 качества: TTA-усреднение и перекрытие. По умолчанию — как в config.php.
    shifts = argv[5] if len(argv) > 5 else "3"
    overlap = argv[6] if len(argv) > 6 else "0.5"

    temp_dir = os.path.join(output_dir, TEMP_DIRNAME)

    stage("load")

    ensure_ffmpeg()

    if not os.path.isfile(input_file):
        print(json.dumps({"status": "error", "message": "Файл не найден: " + input_file}, ensure_ascii=False))
        return 1

    if not os.path.isdir(output_dir):
        print(json.dumps({"status": "error", "message": "Каталог не найден: " + output_dir}, ensure_ascii=False))
        return 1

    # Чистим возможный остаток от прошлого прерванного прогона.
    if os.path.isdir(temp_dir):
        shutil.rmtree(temp_dir, ignore_errors=True)

    try:
        os.makedirs(temp_dir, exist_ok=True)
    except OSError as e:
        print(json.dumps({"status": "error", "message": "Не создать временный каталог: " + str(e)}, ensure_ascii=False))
        return 1

    cmd = [
        sys.executable, "-m", "demucs",
        "-n", model,
        "--mp3", "--mp3-bitrate", bitrate,
        "--shifts", shifts,
        "--overlap", overlap,
        "-o", temp_dir,
        input_file,
    ]

    # Разделение — это 90% времени.
    stage("demucs")

    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    except FileNotFoundError:
        shutil.rmtree(temp_dir, ignore_errors=True)
        print(json.dumps({
            "status": "error",
            "message": "Не удалось запустить demucs. Проверьте venv_demucs (demucs+torch).",
        }, ensure_ascii=False))
        return 1

    if proc.returncode != 0:
        shutil.rmtree(temp_dir, ignore_errors=True)
        err = (proc.stderr or "").strip()
        text = (err[-2000:] if err else (proc.stdout or "").strip()[-1000:])
        print(json.dumps({"status": "error", "message": text or "Demucs завершился с ошибкой"}, ensure_ascii=False))
        return 1

    stage("save")

    produced = []

    try:
        for stem_name in CASCADE_STEMS:
            src = find_stem(temp_dir, stem_name)

            if src is None:
                print(json.dumps({
                    "status": "error",
                    "message": "Demucs не оставил стем «" + stem_name + "» в " + temp_dir,
                }, ensure_ascii=False))
                return 1

            dst = os.path.join(output_dir, "{}_{}.mp3".format(track_id, stem_name))
            shutil.move(src, dst)
            produced.append(stem_name)
    except OSError as e:
        print(json.dumps({"status": "error", "message": "Ошибка переименования: " + str(e)}, ensure_ascii=False))
        return 1
    finally:
        # Мусор Demucs (<temp_dir>/<model>/<basename>/…) больше не нужен.
        shutil.rmtree(temp_dir, ignore_errors=True)

    stage("done")
    print(json.dumps({"status": "done", "id": track_id, "stems": produced}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
