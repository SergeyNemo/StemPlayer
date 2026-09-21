#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const JS_DIR = path.join(__dirname, '..', 'assets', 'js');
const OUTPUT = path.join(JS_DIR, 'sorter.min.js');

// Порядок важен: сначала модули без зависимостей.
const FILES_IN_ORDER = [
    'store.js',
    'utils.js',
    'player.js',
    'table.js',
    'sort.js',
    'views.js',
    'upload.js',
    'analysis.js',
    'main.js',
];

function stripModuleSyntax(code) {
    return code
        .replace(/^import\s.*from\s+['"][^'"]+['"];\s*$/gm, '')
        .replace(/^export\s+(function|const|let|var|class)\s/gm, '$1 ')
        .replace(/^export\s*\{[^}]*\};\s*$/gm, '')
        .trim();
}

const parts = FILES_IN_ORDER.map((f) => {
    const file = path.join(JS_DIR, f);
    if (!fs.existsSync(file)) {
        console.error(`Не найден модуль: ${file}`);
        process.exit(1);
    }
    return stripModuleSyntax(fs.readFileSync(file, 'utf8'));
});

const bundled = `(() => {\n'use strict';\n\n${parts.join('\n\n')}\n})();\n`;

fs.writeFileSync(OUTPUT, bundled, 'utf8');
console.log(`Built ${path.relative(process.cwd(), OUTPUT)} (${FILES_IN_ORDER.length} modules)`);