'use strict';
(function (G) {
    const { API } = G;

    G.fetchJson = async function fetchJson(action) {
        const res = await fetch(`${API}?action=${action}`, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
    };
})(window.StemGen);