<?php

declare(strict_types=1);

/**
 * Кэш результатов анализа по именам файлов (storage/tracks.json).
 * Нужен, чтобы таблица на странице «Обработка» показывала BPM/Key/длительность,
 * не требуя повторного анализа после перезагрузки страницы.
 */
final class TracksIndex
{
    private string $file;

    public function __construct(?string $file = null)
    {
        $this->file = $file ?? (__DIR__ . '/../../storage/tracks.json');
    }

    /**
     * @return array<string, array<string, mixed>> Ключ — нижний регистр имени файла.
     */
    public function read(): array
    {
        if (!is_file($this->file)) {
            return [];
        }

        $raw = @file_get_contents($this->file);

        if ($raw === false) {
            return [];
        }

        $data = json_decode($raw, true);

        return is_array($data) ? $data : [];
    }

    /**
     * Убирает запись трека из кэша (откат прерванного анализа).
     *
     * @return bool true — запись была и удалена.
     */
    public function forget(string $fileName): bool
    {
        $key = strtolower($fileName);
        $data = $this->read();

        if (!array_key_exists($key, $data)) {
            return false;
        }

        unset($data[$key]);
        $this->write($data);

        return true;
    }

    private function write(array $data): void
    {
        $dir = dirname($this->file);

        if (!is_dir($dir) && !mkdir($dir, 0777, true) && !is_dir($dir)) {
            return;
        }

        $fp = fopen($this->file, 'w');

        if ($fp === false) {
            return;
        }

        flock($fp, LOCK_EX);
        fwrite($fp, json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));
        fflush($fp);
        flock($fp, LOCK_UN);
        fclose($fp);
    }

    /**
     * @param array<string, mixed> $entry
     */
    public function save(string $fileName, array $entry): void
    {
        $data = $this->read();
        $data[strtolower($fileName)] = $entry;

        $this->write($data);
    }

    /**
     * Собирает строки таблицы: соединяет файлы inbox/ с кэшем результатов.
     *
     * @param list<string> $inboxFiles Абсолютные пути файлов.
     *
     * @return list<array{
     *   name: string,
     *   title: string,
     *   artist: string,
     *   bpm: int|null,
     *   key: string|null,
     *   duration: float|null,
     *   status: 'pending'|'done'|'error',
     *   message: string|null
     * }>
     */
    public function buildRows(array $inboxFiles): array
    {
        $cache = $this->read();
        $rows  = [];

        foreach ($inboxFiles as $file) {
            $name = basename($file);
            [$title, $artist] = self::parseTrackName($name);

            $slug  = strtolower($name);
            $entry = $cache[$slug] ?? [];

            $rows[] = [
                'name'     => $name,
                'title'    => $title,
                'artist'   => $artist,
                'bpm'      => isset($entry['bpm']) ? (int) $entry['bpm'] : null,
                'key'      => isset($entry['key']) ? (string) $entry['key'] : null,
                'duration' => isset($entry['duration']) && $entry['duration'] !== null ? (float) $entry['duration'] : null,
                'status'   => (string) ($entry['status'] ?? 'pending'),
                'message'  => isset($entry['message']) ? (string) $entry['message'] : null,
            ];
        }

        return $rows;
    }

    /**
     * Пытается вытащить из имени файла «Исполнитель — Название».
     *
     * @return array{0: string, 1: string}
     */
    public static function parseTrackName(string $fileName): array
    {
        $name = pathinfo($fileName, PATHINFO_FILENAME);

        // Убираем ведущий числовой префикс ди-джеевской разметки: "01 - ", "10 -_".
        $name = preg_replace('/^\s*\d{1,3}\s*[-_]\s*/u', '', $name) ?? $name;

        $separator = '';

        if (preg_match('/\s+-\s+/u', $name)) {
            $separator = '/\s+-\s+/u';
        } elseif (preg_match('/_\s*-\s*/u', $name) || preg_match('/\s*_-_\s*/u', $name)) {
            $separator = '/\s*_-_\s*|\s*-\s*/u';
        }

        if ($separator === '') {
            return [self::prettify($name), 'Неизвестен'];
        }

        $parts = preg_split($separator, $name);

        if ($parts === false || count($parts) < 2) {
            return [self::prettify($name), 'Неизвестен'];
        }

        $artist = trim((string) array_shift($parts));
        $title  = trim(implode(' - ', $parts));

        if ($artist === '' || $title === '') {
            return [self::prettify($name), 'Неизвестен'];
        }

        return [self::prettify($title), self::prettify($artist)];
    }

    /**
     * DJ-имена файлов часто пишутся через подчёркивания — приводим к пробелам.
     */
    private static function prettify(string $value): string
    {
        $value = str_replace('_', ' ', $value);
        $value = preg_replace('/\s{2,}/u', ' ', $value) ?? $value;

        return trim($value);
    }
}