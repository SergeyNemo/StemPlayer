<?php

declare(strict_types=1);

/**
 * HTTP-ответы: JSON с безопасной кодировкой.
 */
final class Http
{
    /**
     * @param array<string, mixed> $payload
     */
    public static function jsonResponse(array $payload): never
    {
        header('Content-Type: application/json; charset=utf-8');
        // API-опросы ходят на один и тот же URL (get_progress раз в 2 с).
        // Без явного запрета браузер может отдать закешированный ответ со
        // старым last_ping — страница решает, что процесс завис, хотя тот
        // жив. Запрещаем кэширование навсегда.
        header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
        header('Pragma: no-cache');
        echo self::encode($payload);
        exit;
    }

    /**
     * @param array<string, mixed> $payload
     */
    private static function encode(array $payload): string
    {
        $json = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

        if ($json !== false) {
            return $json;
        }

        // В payload попала битая кодировка (например, вывод внешней программы):
        // чистим не-UTF8 и пробуем ещё раз, чтобы не отдавать 500-фатал.
        $clean = self::toUtf8($payload);
        $json = json_encode($clean, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);

        return $json !== false ? $json : '{"status":"error","message":"encoding failed"}';
    }

    /**
     * Рекурсивно приводит строки к валидному UTF-8.
     *
     * @param mixed $value
     * @return mixed
     */
    private static function toUtf8($value)
    {
        if (is_array($value)) {
            $out = [];

            foreach ($value as $key => $item) {
                $out[is_string($key) ? self::toUtf8($key) : $key] = self::toUtf8($item);
            }

            return $out;
        }

        if (!is_string($value)) {
            return $value;
        }

        if (function_exists('mb_check_encoding') && mb_check_encoding($value, 'UTF-8')) {
            return $value;
        }

        if (function_exists('mb_convert_encoding')) {
            $converted = @mb_convert_encoding($value, 'UTF-8', 'Windows-1251');

            if (is_string($converted)) {
                return $converted;
            }
        }

        return preg_replace('/[^\x09\x0A\x0D\x20-\x7E]/', '?', $value) ?? '';
    }
}