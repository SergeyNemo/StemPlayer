'use strict';
(function (G) {
    const { API } = G;

    G.fetchJson = async function fetchJson(actionOrQuery, options) {
        let url;
        if (actionOrQuery.startsWith('?') || actionOrQuery.includes('=')) {
            const qs = actionOrQuery.startsWith('?') ? actionOrQuery.slice(1) : actionOrQuery;
            url = qs.startsWith('action=') ? `${API}?${qs}` : `${API}?action=${qs}`;
        } else {
            url = `${API}?action=${encodeURIComponent(actionOrQuery)}`;
        }
        const res = await fetch(url, { cache: 'no-store', ...(options || {}) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
    };
})(window.StemGen);