#Requires -Version 5.1
<#
.SYNOPSIS
    Автоматическая установка окружения StemPlayer под Windows.

.DESCRIPTION
    Скрипт выполняет:
      1. проверку Python 3.9+, ffmpeg и NVIDIA GPU (обязательно, минимум 6 ГБ VRAM);
      2. создание venv_demucs с torch (CUDA 12.1) и demucs;
      3. установку зависимостей анализатора (numpy, librosa, mutagen) в системный Python;
      4. предварительную загрузку весов модели htdemucs;
      5. создание рабочих каталогов music/ storage/ logs/.

    Требуется: Python 3.9+, ffmpeg, драйвер NVIDIA с рабочим nvidia-smi,
    видеокарта от GTX 1060 6 ГБ. Интернет нужен для скачивания зависимостей
    (~5 ГБ) и весов модели.

.PARAMETER Python
    Полный путь к python.exe. По умолчанию берётся из PATH (py -3 / python).

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File setup.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File setup.ps1 -Python C:\Python312\python.exe
#>
[CmdletBinding()]
param(
    [string]$Python = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location -LiteralPath $root

function Write-Step($m) { Write-Host "  $m" -ForegroundColor Cyan }
function Write-Ok($m)   { Write-Host "  [ok] $m" -ForegroundColor Green }
function Write-Warn2($m){ Write-Host "  [!]  $m" -ForegroundColor Yellow }
function Write-Err2($m) { Write-Host "  [x]  $m" -ForegroundColor Red }

function Assert-LastExit([string]$what) {
    if ($LASTEXITCODE -ne 0) {
        throw "$what завершилось с кодом $LASTEXITCODE."
    }
}

Write-Host ''
Write-Host '=== StemPlayer: установка окружения ===' -ForegroundColor White
Write-Host "Каталог проекта: $root"
Write-Host ''

try {

    # --- 1. Python -------------------------------------------------------
    Write-Step 'Поиск Python...'
    $pythonExe = ''
    if ($Python) {
        $pythonExe = $Python
    } elseif (Get-Command py -ErrorAction SilentlyContinue) {
        $pythonExe = (& py -3 -c "import sys; print(sys.executable)").Trim()
    } elseif (Get-Command python -ErrorAction SilentlyContinue) {
        $pythonExe = (& python -c "import sys; print(sys.executable)").Trim()
    }
    if (-not $pythonExe -or -not (Test-Path -LiteralPath $pythonExe)) {
        throw 'Python не найден. Установите Python 3.9+ (python.org) и включите опцию "Add python.exe to PATH".'
    }
    $pyVer = (& $pythonExe -c "import sys; print('%d.%d' % sys.version_info[:2])").Trim()
    $pyParts = $pyVer.Split('.')
    if ([int]$pyParts[0] -lt 3 -or ([int]$pyParts[0] -eq 3 -and [int]$pyParts[1] -lt 9)) {
        throw "Нужен Python 3.9+, найден $pyVer."
    }
    Write-Ok "Python $pyVer ($pythonExe)"

    # --- 2. GPU (обязательно) -------------------------------------------
    Write-Step 'Проверка NVIDIA GPU...'
    $nvidiaSmi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
    if (-not $nvidiaSmi) {
        throw 'nvidia-smi не найден. Модуль «Стемы» требует NVIDIA GPU и драйвер CUDA. Установите драйвер NVIDIA и перезагрузись.'
    }
    $gpuInfo = (& nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>$null) | Select-Object -First 1
    if (-not $gpuInfo) {
        throw 'nvidia-smi не вернул данные. Проверьте драйвер NVIDIA.'
    }
    Write-Ok "GPU: $gpuInfo"
    if ($gpuInfo -match '(\d+)\s*MiB') {
        $vramMb = [int]$Matches[1]
        if ($vramMb -lt 6000) {
            Write-Warn2 "У GPU меньше 6 ГБ VRAM ($vramMb MiB). Рекомендуется от GTX 1060 6 ГБ — разделение может не уложиться в память."
        }
    }

    # --- 3. ffmpeg -------------------------------------------------------
    Write-Step 'Поиск ffmpeg...'
    $ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
    if ($ffmpeg) {
        Write-Ok "ffmpeg: $($ffmpeg.Source)"
    } else {
        $found = @(
            'C:\ffmpeg\bin\ffmpeg.exe',
            'C:\Program Files\ffmpeg\bin\ffmpeg.exe'
        ) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
        if ($found) {
            Write-Ok "ffmpeg: $found"
        } else {
            Write-Warn2 'ffmpeg не найден в PATH и типовых местах. Demucs нужен ffmpeg для mp3.'
            Write-Warn2 'Установите: winget install Gyan.FFmpeg  (или choco install ffmpeg) и перезапустите установку.'
        }
    }

    # --- 4. venv_demucs --------------------------------------------------
    Write-Step 'Подготовка venv_demucs...'
    $venvDir = Join-Path $root 'venv_demucs'
    $venvPy  = Join-Path $venvDir 'Scripts\python.exe'
    if (-not (Test-Path -LiteralPath $venvPy)) {
        & $pythonExe -m venv $venvDir
        Assert-LastExit 'Создание venv_demucs'
    }
    if (-not (Test-Path -LiteralPath $venvPy)) {
        throw 'Не удалось создать venv_demucs.'
    }
    Write-Ok 'venv_demucs готов.'

    Write-Step 'Обновление pip в venv...'
    & $venvPy -m pip install --upgrade pip wheel --quiet
    Assert-LastExit 'Обновление pip'

    # --- 5. torch + demucs ----------------------------------------------
    Write-Step 'Установка torch/torchvision (CUDA 12.1) — это несколько ГБ, может занять время...'
    & $venvPy -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cu121
    Assert-LastExit 'Установка torch'

    Write-Step 'Установка demucs...'
    & $venvPy -m pip install -r (Join-Path $root 'requirements-demucs.txt')
    Assert-LastExit 'Установка demucs'

    # --- 6. Веса модели --------------------------------------------------
    Write-Step 'Загрузка весов модели htdemucs (может занять минуту)...'
    & $venvPy -c "from demucs.pretrained import get_model; get_model('htdemucs'); print('htdemucs ready')"
    Assert-LastExit 'Загрузка модели htdemucs'

    # --- 7. Зависимости анализатора -------------------------------------
    Write-Step 'Установка зависимостей анализатора в системный Python (numpy, librosa, mutagen)...'
    & $pythonExe -m pip install -r (Join-Path $root 'requirements-analysis.txt')
    Assert-LastExit 'Установка зависимостей анализатора'

    # --- 8. Рабочие каталоги --------------------------------------------
    Write-Step 'Создание рабочих каталогов...'
    foreach ($d in @('music\inbox', 'music\sorted', 'music\stems', 'storage', 'logs')) {
        New-Item -ItemType Directory -Force -Path (Join-Path $root $d) | Out-Null
    }
    Write-Ok 'Каталоги music/, storage/, logs/ готовы.'

    # --- 9. PHP (информационно) -----------------------------------------
    $php = 'C:\xampp\php\php.exe'
    if (Test-Path -LiteralPath $php) {
        Write-Ok "PHP: $php"
    } else {
        Write-Warn2 "php.exe не найден в $php — поправьте константу STEMPLAYER_PHP в config.php."
    }

    # --- Итог ------------------------------------------------------------
    $folder = Split-Path $root -Leaf
    Write-Host ''
    Write-Host '=== Готово ===' -ForegroundColor Green
    Write-Host "1. Запустите Apache в панели XAMPP."
    Write-Host "2. Откройте: http://127.0.0.1/$folder/"
    Write-Host ''
}
catch {
    Write-Host ''
    Write-Err2 $_.Exception.Message
    Write-Host ''
    exit 1
}
