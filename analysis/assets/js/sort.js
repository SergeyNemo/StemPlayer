import { state } from './store.js?v=48';
import { renderTable } from './table.js?v=48';

// ---------- Сортировка по заголовкам колонок ----------

function sortBy(key) {
    if (state.mode === 'processing' || state.mode === 'poll') return;

    if (key === 'track') {
        state.rows = shuffle(state.rows);
        state.sort = { key: 'track', dir: 0 };
        renderTable(state.rows);
        return;
    }

    if (state.sort.key === key) {
        state.sort.dir = state.sort.dir === 1 ? -1 : 1;
    } else {
        state.sort = { key, dir: 1 };
    }

    const dir = state.sort.dir;
    const rows = [...state.rows].sort((a, b) => {
        let v = 0;
        switch (key) {
            case 'num':
                v = String(a.name).localeCompare(String(b.name), 'ru');
                break;
            case 'bpm':
                v = (a.bpm ?? -1) - (b.bpm ?? -1);
                break;
            case 'key':
                v = String(a.key || '').localeCompare(String(b.key || ''), 'ru');
                break;
            case 'duration':
                v = (a.duration ?? -1) - (b.duration ?? -1);
                break;
        }
        return v * dir;
    });

    state.rows = rows;
    renderTable(rows);
}

function shuffle(items) {
    const arr = [...items];
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

export { sortBy, shuffle };