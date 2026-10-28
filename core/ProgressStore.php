<?php

declare(strict_types=1);

/**
 * Хранение состояния фонового процесса в storage/progress.json.
 *
 * Только необходимая координация демона и страницы: статус, счётчики,
 * текущий трек, флаг остановки, сердцебиение (last_ping) и одна строка
 * журнала (last_message).
 *
 * Прогресс внутри трека — дискретный этап (current_stage), а не гладкий
 * процент: этапы соответствуют реальным шагам пайтона, поэтому шкала на
 * странице не может «заполниться дважды» и не врёт о проценте.
 */
final class ProgressStore
{
    /**
     * Реальные этапы обработки одного трека по порядку.
     *
     * load/bpm/key/meta приходят из analyzer.py построчно в stdout,
     * start/save/done ставит PHP. Ключ = идентификатор этапа, значение =
     * подпись для страницы. Порядок массива задаёт позицию на шкале,
     * поэтому новый этап добавляется только сюда.
     *
     * @var array<string, string>
     */
    public const STAGES = [
        'start' => 'запуск',
        'load'  => 'декодирование аудио',
        'bpm'   => 'определение темпа',
        'key'   => 'определение тональности',
        'meta'  => 'чтение тегов',
        'save'  => 'сохранение в библиотеку',
        'done'  => 'готово',
    ];

    /**
     * Этапы одного трека при разделении на стемы — StemRunner::STAGES.
     *
     * Отдельная карта, потому что шаги другие: анализ мерит BPM/Key, а
     * Demucs считает моделью, раскладывает результат по каталогам и
     * проверяет выход. Порядок в карте задаёт позицию на сегментированной
     * шкале в карточке трека, поэтому новый этап добавляется только сюда.
     *
     * @var array<string, string>
     */
    public const STEMGEN_STAGES = [
        'load'    => 'подготовка',
        'demucs'  => 'разделение моделью',
        'collect' => 'сборка стемов',
        'save'    => 'сохранение и проверка',
        'done'    => 'готово',
    ];

    /**
     * Этапы каскадного разделения стема (other → guitar/piano) — split_instrument.py.
     *
     * Отдельная карта: у второго прохода нет этапа «сборка стемов» (collect) —
     * Demucs сразу кладёт guitar/piano, их только переносят. Порядок задаёт
     * позицию на шкале, поэтому новый этап добавляется только сюда.
     *
     * @var array<string, string>
     */
    public const STEMGEN_CASCADE_STAGES = [
        'load'   => 'подготовка',
        'demucs' => 'разделение моделью',
        'save'   => 'сохранение и проверка',
        'done'   => 'готово',
    ];

    private string $file;

    /** Состояние в памяти демона (после первого чтения/сброса). */
    private ?array $cache = null;

    /** Время последней фактической записи на диск (anchor для keepAlive). */
    private float $lastWriteAt = 0.0;

    /** Кэш флага остановки с TTL ~250 мс: стоп пишет веб, читает демон. */
    private float $stopReadAt = 0.0;
    private bool $stopCache = false;

    /**
     * Сохранить прежний last_ping при следующей записи.
     *
     * Файл состояния пишется не только демоном: forgetEverywhere() правит его
     * из веб-запроса. Без этого флага такая запись обновила бы last_ping на
     * «сейчас», и опрос страницы снова счёл бы давно мёртвый прогон живым —
     * детект смерти демона построен именно на last_ping.
     */
    private bool $keepLastPing = false;

    /**
     * Значение stop_requested, которое следующая запись обязана поставить
     * буквально, минуя подстановку из файла. null = взять значение из файла.
     *
     * Суть: флаг остановки ставит веб-процесс, а демон держит состояние
     * в памяти. Без этого демон затирал бы флаг своим устаревшим кэшем при
     * первой же записи (update/keepAlive/смена этапа) — кнопка «Стоп» так
     * выглядела рабочей, а обработка продолжалась (проверено: терялось
     * обновление между двумя процессами). Теперь поле имеет одного хозяина —
     * того, кто его явно менял.
     */
    private ?bool $pendingStopFlag = null;

    public function __construct(?string $file = null)
    {
        $this->file = $file ?? (__DIR__ . '/../storage/progress.json');
    }

    /**
     * @return array<string, mixed>
     */
    public function read(): array
    {
        if ($this->cache !== null) {
            return $this->cache;
        }

        if (!is_file($this->file)) {
            return $this->blank();
        }

        $raw = file_get_contents($this->file);

        if ($raw === false) {
            return $this->blank();
        }

        $data = json_decode($raw, true);

        $this->cache = is_array($data) ? $data : $this->blank();

        return $this->cache;
    }

    /**
     * Чтение «в обход кэша»: демон пишет файл из другого процесса, поэтому
     * веб-запрос, который ждёт признаков жизни, должен перечитывать файл заново.
     *
     * @return array<string, mixed>
     */
    public function readFresh(): array
    {
        $this->cache = null;

        return $this->read();
    }

    public function reset(string $runId): void
    {
        $blank = $this->blank();
        $blank['run_id']   = $runId;
        $blank['status']   = 'running';
        $blank['started_at'] = date('c');

        // Новый прогон снимает флаг остановки, даже если на диске остался
        // true от прошлого прогона: иначе демон остановился бы сразу.
        $this->pendingStopFlag = false;

        $this->cache = $blank;
        $this->write($this->cache);
    }

    /**
     * Применяет частичное обновление поверх текущего состояния (редкие события:
     * смена трека, статуса, тотал). Пишет сразу, но из кэша — без перечитывания.
     *
     * Исключение — патч с stop_requested: он ставится другим процессом, поэтому
     * базу берём свежей с диска, иначе можно затереть результаты, появившиеся
     * между нашим чтением и записью.
     *
     * @param array<string, mixed> $patch
     */
    public function update(array $patch): void
    {
        unset($patch['log']);

        $touchesStop = array_key_exists('stop_requested', $patch);

        if ($touchesStop) {
            $this->pendingStopFlag = (bool) $patch['stop_requested'];
            $this->cache = array_merge($this->readFresh(), $patch);
        } else {
            $this->cache = array_merge($this->read(), $patch);
        }

        $this->write($this->cache);
    }

    /**
     * Запрос остановки прогона (кнопка «Стоп»).
     *
     * Отдельный метод вместо update(): вызывающая сторона меняет флаг,
     * принадлежащий демону, поэтому читаем состояние свежим и записываем
     * флаг явно — иначе гонка двух процессов съедала бы остановку.
     */
    public function requestStop(): void
    {
        $this->update(['stop_requested' => true]);
    }

    /**
     * Сердцебиение демона: процесс жив, пока идёт работа. Прогресс этапный,
     * поэтому между записями могут быть длинные паузы (демucs на трек — минуты),
     * и наивный детект «мёртвого по last_ping» дал бы ложный сброс живого
     * процесса. Пишем сюда не чаще 1 раза в 10 секунд — диск почти не трогаем.
     * Вызывается из цикла ожидания демона каждый тик (200 мс) — дешёвая проверка.
     */
    public function keepAlive(int $everySeconds = 10): void
    {
        if (microtime(true) - $this->lastWriteAt >= $everySeconds) {
            $this->write($this->read());
        }
    }

    /**
     * Этап обработки текущего трека.
     *
     * Пишем один раз на смену этапа (и сравнивая с предыдущим), а не по
     * таймеру: 7 записей на трек вместо потока, плюс строка журнала
     * обновляется в том же write — то есть платы за «подробность» нет.
     * Неизвестный этап игнорируем, чтобы не засорять состояние.
     *
     * $stages — карта этапов модуля: по умолчанию STAGES (анализ), модуль
     * «Стемы» передаёт свою (STEMGEN_STAGES), потому что шаги там другие.
     * Номер этапа в карте и есть позиция на сегментированной шкале.
     *
     * @param array<string, string>|null $stages
     */
    public function markStage(string $stage, ?array $stages = null): void
    {
        $map = $stages ?? self::STAGES;

        if (!isset($map[$stage])) {
            return;
        }

        $state = $this->read();

        if (($state['current_stage'] ?? '') === $stage) {
            return;
        }

        $index = array_search($stage, array_keys($map), true);

        $this->update([
            'current_stage'        => $stage,
            'current_stage_label'  => $map[$stage],
            'current_stage_index'  => $index === false ? 0 : (int) $index,
            'last_message'         => [
                'time'    => date('H:i:s'),
                'type'    => 'info',
                'message' => 'Этап: ' . $map[$stage],
            ],
        ]);
    }

    /**
     * Трек успешно разобран — запоминаем его результат в состоянии прогона.
     *
     * Без этого страница узнавала о готовности только из tracks.json, который
     * опрашивался в финале: все уже обработанные треки до этого момента
     * выглядели как «в очереди». Список сбрасывается в reset() на каждый прогон.
     *
     * @param array{bpm?: int|null, key?: string, duration?: float|null} $data
     */
    public function markDone(string $name, array $data = []): void
    {
        $state = $this->read();
        $done  = is_array($state['done_files'] ?? null) ? $state['done_files'] : [];

        $done[$name] = [
            'bpm'      => $data['bpm'] ?? null,
            'key'      => (string) ($data['key'] ?? ''),
            'duration' => $data['duration'] ?? null,
        ];

        $this->update(['done_files' => $done]);
    }

    /**
     * Трек не разобран (ошибка PHP, анализа, перекладывания или пустые
     * BPM/Key) — сообщаем странице, чтобы строка не висела «в очереди».
     */
    public function markError(string $name, string $message = ''): void
    {
        $state = $this->read();
        $errs  = is_array($state['error_files'] ?? null) ? $state['error_files'] : [];

        $errs[$name] = $message;

        $this->update(['error_files' => $errs]);
    }

    /**
     * Забывает трек прогона: убирает его из готовых и из ошибочных.
     *
     * Нужно откату прерванного трека — иначе страница до следующего прогона
     * показывала бы его как «Обработано» или «ошибка», хотя демон его откатил.
     */
    public function forget(string $name): void
    {
        $state = $this->read();
        $done  = is_array($state['done_files'] ?? null) ? $state['done_files'] : [];
        $errs  = is_array($state['error_files'] ?? null) ? $state['error_files'] : [];

        $hadDone = array_key_exists($name, $done);
        $hadErr  = array_key_exists($name, $errs);

        unset($done[$name], $errs[$name]);

        if (!$hadDone && !$hadErr) {
            return;
        }

        $this->update(['done_files' => $done, 'error_files' => $errs]);
    }

    /**
     * Чистит состояние прогона от всех следов трека: done_files, error_files,
     * current_file, снимок folders и строка журнала, если в ней есть имя.
     *
     * Отдельный метод от forget(): там убирались только два списка, а при
     * удалении трека со страницы progress.json не должен продолжать называть
     * уже несуществующий файл. Если упоминаний не нашлось — файл вообще не
     * трогаем (запись ради записи обновила бы last_ping, см. $keepLastPing).
     *
     * @return array{done: bool, error: bool, current: bool, folders: int, message: bool} Что вычищено.
     */
    public function forgetEverywhere(string $name): array
    {
        $state = $this->read();
        $done  = is_array($state['done_files'] ?? null) ? $state['done_files'] : [];
        $errs  = is_array($state['error_files'] ?? null) ? $state['error_files'] : [];

        $touched = [
            'done'    => array_key_exists($name, $done),
            'error'   => array_key_exists($name, $errs),
            'current' => (string) ($state['current_file'] ?? '') === $name,
            'folders' => 0,
            'message' => $this->mentionsName($state['last_message'] ?? null, $name),
        ];

        $folders = $state['folders'] ?? null;

        if (is_array($folders)) {
            foreach ($folders as $i => $folder) {
                if (!is_array($folder) || !is_array($folder['files'] ?? null)) {
                    continue;
                }

                $files = array_values(array_filter(
                    $folder['files'],
                    static fn ($file): bool => mb_strtolower(basename((string) $file), 'UTF-8') !== mb_strtolower($name, 'UTF-8'),
                ));

                $removed = count($folder['files']) - count($files);

                if ($removed > 0) {
                    $folders[$i]['files'] = $files;
                    $touched['folders']   += $removed;
                }
            }
        }

        if (!$touched['done'] && !$touched['error'] && !$touched['current']
            && $touched['folders'] === 0 && !$touched['message']) {
            return $touched;
        }

        unset($done[$name], $errs[$name]);

        $patch = ['done_files' => $done, 'error_files' => $errs];

        if ($touched['current']) {
            $patch['current_file'] = '';
        }

        if ($touched['folders'] > 0) {
            $patch['folders'] = $folders;
        }

        if ($touched['message']) {
            $patch['last_message'] = null;
        }

        $this->keepLastPing = true;
        $this->update($patch);

        return $touched;
    }

    /**
     * Есть ли имя трека в тексте записи журнала.
     */
    private function mentionsName(mixed $entry, string $name): bool
    {
        if (!is_array($entry)) {
            return false;
        }

        $text = (string) ($entry['message'] ?? '');

        return $text !== '' && stripos($text, $name) !== false;
    }

    /**
     * Журнал — одна текущая строка вместо растущего массива: полоска/строка
     * журнала на фронте и так показывает только последнее сообщение.
     */
    public function log(string $type, string $message): void
    {
        $this->cache = $this->read();
        $this->cache['last_message'] = [
            'time'    => date('H:i:s'),
            'type'    => $type,
            'message' => $message,
        ];

        $this->write($this->cache);
    }

    /**
     * Флаг остановки ставит веб-процесс (stop_*) — демон обязан его увидеть,
     * поэтому читаем файл напрямую, но не чаще ~250 мс (дешёвый маленький файл).
     */
    public function isStopRequested(): bool
    {
        $now = microtime(true);

        if ($now - $this->stopReadAt >= 0.25) {
            $this->stopCache = $this->stopFlagFromDisk() === true;
            $this->stopReadAt = $now;
        }

        return $this->stopCache;
    }

    /**
     * @param array<string, mixed> $state
     */
    private function write(array $state): void
    {
        $dir = dirname($this->file);

        if (!is_dir($dir) && !mkdir($dir, 0777, true) && !is_dir($dir)) {
            return;
        }

        // done_files/error_files — словари «имя файла => результат». Имена
        // необработаны на стороне JSON: PHP-массив с числовым ключом ("123.mp3"
        // не считается, а вот "1234" — да)encode'нулся бы как [], и клиент
        // получил бы вместо объекта массив. Приводим к объекту явно.
        foreach (['done_files', 'error_files'] as $key) {
            if (isset($state[$key]) && is_array($state[$key])) {
                $state[$key] = (object) $state[$key];
            }
        }

        // Сердцебиение: каждая запись в progress.json помечает процесс живым.
        // Привязка любого обновления к времени — основа детекта «мёртвого running».
        // Исключение — forgetEverywhere(): там last_ping переносится из прежнего
        // состояния, иначе удаление трека со страницы «воскресило» бы прогон,
        // который демон не подтверждает уже давно.
        if (!$this->keepLastPing) {
            $state['last_ping'] = time();
        }

        $this->keepLastPing = false;

        // Флаг остановки: если его никто не менял явно в этой записи — берём
        // значение с диска. Демон пишет из своего кэша в памяти, и его
        // stop_requested всегда был бы false, то есть любая запись демона
        // стирала бы остановку, запрошенную кнопкой «Стоп».
        if ($this->pendingStopFlag !== null) {
            $state['stop_requested'] = $this->pendingStopFlag;
            $this->pendingStopFlag = null;
        } else {
            $onDisk = $this->stopFlagFromDisk();

            if ($onDisk !== null) {
                $state['stop_requested'] = $onDisk;
            }
        }

        $this->stopCache = (bool) ($state['stop_requested'] ?? false);

        // Пишем во временный файл и атомарно переименовываем: читатели никогда
        // не увидят "обрезанный" JSON в момент записи (гандикап flock на чтение).
        // Имя tmp уникально для каждого файла и процесса, чтобы избежать коллизий
        // между прогрессом анализа, стемов и параллельными вызовами.
        $tmp = $this->file . '.' . getmypid() . '.' . bin2hex(random_bytes(4)) . '.tmp';

        if (@file_put_contents($tmp, json_encode($state, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE)) === false) {
            return;
        }

        if (!@rename($tmp, $this->file)) {
            @unlink($tmp);
            return;
        }

        $this->lastWriteAt = microtime(true);
    }

    /**
     * Текущее значение stop_requested с диска (null — файла нет/не разобрали).
     */
    private function stopFlagFromDisk(): ?bool
    {
        if (!is_file($this->file)) {
            return null;
        }

        $raw = @file_get_contents($this->file);
        $data = json_decode($raw ?: '', true);

        if (!is_array($data)) {
            return null;
        }

        return ($data['stop_requested'] ?? false) === true;
    }

    /**
     * @return array<string, mixed>
     */
    private function blank(): array
    {
        return [
            'run_id'         => '',
            'status'         => 'idle',
            'total'          => 0,
            'processed'      => 0,
            'current_file'   => '',
            // Этап обработки текущего трека: идентификатор, подпись и позиция
            // на шкале (current_stage_index — порядковый номер в ProgressStore::STAGES).
            'current_stage'        => '',
            'current_stage_label'  => '',
            'current_stage_index'  => -1,
            // Что уже разобрано и что упало — заполняется по ходу прогона
            // (markDone/markError), чтобы страница не ждала финала.
            'done_files'     => [],
            'error_files'    => [],
            'stop_requested' => false,
            'last_ping'      => null,
            'last_message'   => null,
            'folders'        => [],
            'started_at'     => null,
            'finished_at'    => null,
        ];
    }
}