<?php

declare(strict_types=1);

require_once __DIR__ . '/TracksIndex.php';
require_once __DIR__ . '/../../core/ProgressStore.php';

/**
 * Полное удаление трека со страницы «Обработка».
 *
 * Трек живёт сразу в нескольких местах, и удаление одного файла из inbox/
 * оставило бы за собой мусор: копию в music/sorted/BPM…_Key…/, каталог стемов
 * {id}/ (meta.json + *_vocals/drums/bass/other.mp3) и записи в storage/
 * (tracks.json — кэш BPM/Key, progress.json — состояние прогона). Класс убирает
 * трек отовсюду и возвращает отчёт: что именно снесено.
 *
 * Почему это отдельный класс, а не функция в API: правила удаления должны
 * быть одними и для веб-запроса, и для тестов (правила проверяются на
 * временном дереве music/ без риска для настоящих треков).
 *
 * Безопасность — главное здесь, поэтому:
 *  - имя приводится к basename(), поэтому «../../config.php» превращается в
 *    «config.php»: удалить можно ровно один файл из inbox/, и только его;
 *  - каталог стемов опознаётся по имени оригинала в его meta.json, а не по
 *    догадке «mp3 с таким же именем рядом» — чужие стемы невозможно снести;
 *  - rmrf() отказывается выходить за пределы music/sorted/ и по симлинкам
 *    не идёт (ссылку удаляет, содержимое по ней — нет).
 */
final class TrackCleaner
{
    private string $inboxDir;
    private string $sortedDir;
    private TracksIndex $index;
    private ProgressStore $store;

    public function __construct(
        ?string $inboxDir = null,
        ?string $sortedDir = null,
        ?TracksIndex $index = null,
        ?ProgressStore $store = null,
    ) {
        $this->inboxDir  = $inboxDir ?? __DIR__ . '/../../music/inbox';
        $this->sortedDir = $sortedDir ?? __DIR__ . '/../../music/sorted';
        $this->index     = $index ?? new TracksIndex();
        $this->store     = $store ?? new ProgressStore();
    }

    /**
     * Удаляет трек из inbox/, music/sorted/ и storage/.
     *
     * Порядок не важен для результата, но отчёт собирается по факту: если
     * файла в inbox/ уже нет (удалён вручную), очистка
     * хранилища всё равно выполняется — иначе трек «залипает» в таблице
     * как призрак до конца кэша.
     *
     * @return array{
     *   name: string,
     *   inbox: bool,
     *   copies: int,
     *   stems: int,
     *   folders: int,
     *   tracks_index: bool,
     *   progress: array{done: bool, error: bool, current: bool, folders: int, message: bool}
     * } Отчёт: что именно удалено.
     */
    public function delete(string $name): array
    {
        $name = self::safeName($name);

        $sorted = $this->removeSorted($name);

        return [
            'name'         => $name,
            'inbox'        => $this->removeInbox($name),
            'copies'       => $sorted['copies'],
            'stems'        => $sorted['stems'],
            'folders'      => $sorted['folders'],
            'tracks_index' => $this->index->forget($name),
            'progress'     => $this->store->forgetEverywhere($name),
        ];
    }

    /**
     * Имя файла, безопасное для склейки с путём.
     *
     * basename() срезает и разделители, и «..»: имя вида «../../x.mp3»
     * становится «x.mp3», то есть под удар попадает только файл из inbox/.
     */
    public static function safeName(string $name): string
    {
        $safe = basename(str_replace('\\', '/', trim($name)));

        if ($safe === '' || $safe === '.' || $safe === '..' || str_contains($safe, "\0")) {
            throw new InvalidArgumentException('Некорректное имя трека: ' . $name);
        }

        return $safe;
    }

    /**
     * Исходник из inbox/.
     */
    private function removeInbox(string $name): bool
    {
        $path = $this->inboxDir . '/' . $name;

        if (!is_file($path)) {
            return false;
        }

        $root = realpath($this->inboxDir);
        $real = realpath($path);

        if ($root === false || $real === false) {
            return false;
        }

        if (!str_starts_with($real . DIRECTORY_SEPARATOR, $root . DIRECTORY_SEPARATOR)) {
            return false;
        }

        return @unlink($real);
    }

    /**
     * Копия в music/sorted/ и каталог стемов {id}/.
     *
     * @return array{copies: int, stems: int, folders: int}
     */
    private function removeSorted(string $name): array
    {
        $out = ['copies' => 0, 'stems' => 0, 'folders' => 0];

        foreach (glob($this->sortedDir . '/BPM*_Key*', GLOB_ONLYDIR) ?: [] as $dir) {
            $copy = $dir . '/' . $name;

            if (is_file($copy) && @unlink($copy)) {
                $out['copies']++;
            }

            foreach ($this->stemDirs($dir) as $stemDir) {
                if (self::metaBelongsTo($stemDir . '/meta.json', $name) && self::rmrf($stemDir, $this->sortedDir)) {
                    $out['stems']++;
                }
            }

            // Папка BPM…_Key… без файлов и каталогов стемов — пустая оболочка.
            // Оставлять её нельзя: в дереве папок «Стемов» и в списке
            // get_folders она выглядела бы как музыка, которой больше нет.
            if (self::isEmptyDir($dir) && @rmdir($dir)) {
                $out['folders']++;
            }
        }

        return $out;
    }

    /**
     * Каталоги стемов {8 hex}/ внутри папки BPM…_Key….
     *
     * @return list<string>
     */
    private function stemDirs(string $dir): array
    {
        $pattern = $dir . '/' . str_repeat('[0-9a-f]', 8);

        return glob($pattern, GLOB_ONLYDIR) ?: [];
    }

    /**
     * Чей это каталог стемов: сверяем имя оригинала в его meta.json.
     *
     * Без meta.json доказать принадлежность нечем, поэтому такой каталог
     * не трогаем — «на всякий случай снести» здесь недопустимо.
     */
    private static function metaBelongsTo(string $metaFile, string $name): bool
    {
        if (!is_file($metaFile)) {
            return false;
        }

        $meta = json_decode((string) @file_get_contents($metaFile), true);

        if (!is_array($meta) || !isset($meta['original_name'])) {
            return false;
        }

        return mb_strtolower(basename((string) $meta['original_name']), 'UTF-8') === mb_strtolower($name, 'UTF-8');
    }

    private static function isEmptyDir(string $dir): bool
    {
        foreach (scandir($dir) ?: [] as $item) {
            if ($item !== '.' && $item !== '..') {
                return false;
            }
        }

        return true;
    }

    /**
     * Рекурсивное удаление внутри music/sorted/ (см. докблок класса).
     */
    private static function rmrf(string $path, string $root): bool
    {
        $realRoot = realpath($root);
        $real     = realpath($path);

        if ($realRoot === false || $real === false) {
            return false;
        }

        if (!str_starts_with($real . DIRECTORY_SEPARATOR, $realRoot . DIRECTORY_SEPARATOR)) {
            return false;
        }

        if (is_link($path) || !is_dir($real)) {
            return @unlink($path);
        }

        foreach (scandir($real) ?: [] as $item) {
            if ($item === '.' || $item === '..') {
                continue;
            }

            self::rmrf($real . DIRECTORY_SEPARATOR . $item, $realRoot);
        }

        return @rmdir($real);
    }
}
