'use strict';
'require fs';
'require rpc';

const RPC_TIMEOUT_SEC = 60;
const SERVICE_POLL_TIMEOUT_MS = 60000;
const SERVICE_POLL_INTERVAL_MS = 500;

const callServiceList = rpc.declare({
    object: 'service',
    method: 'list',
    params: ['name'],
    expect: { '': {} }
});

function bumpRpcTimeout() {
    try {
        if (typeof L !== 'undefined' && L.env &&
            (!(L.env.rpctimeout > 0) || L.env.rpctimeout < RPC_TIMEOUT_SEC)) {
            L.env.rpctimeout = RPC_TIMEOUT_SEC;
        }
    } catch (e) {}
}

function execDetached(script) {
    const quoted = '\'' + script.replace(/'/g, "'\\''") + '\'';
    const wrapped = 'if command -v setsid >/dev/null 2>&1; then setsid /bin/sh -c ' + quoted +
        '; else /bin/sh -c ' + quoted + '; fi >/dev/null 2>&1 </dev/null &';
    return fs.exec('/bin/sh', ['-c', wrapped]);
}

async function getClashRunning() {
    try {
        const instances = (await callServiceList('clash'))['clash']?.instances;
        return Object.values(instances || {})[0]?.running || false;
    } catch (e) {
        return false;
    }
}

async function waitForServiceStatus(getStatusFn, targetStatus, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || SERVICE_POLL_TIMEOUT_MS);
    while (Date.now() < deadline) {
        if (await getStatusFn() === targetStatus) {
            return true;
        }
        await new Promise(function(resolve) {
            setTimeout(resolve, SERVICE_POLL_INTERVAL_MS);
        });
    }
    return false;
}

return L.Class.extend({
    bumpRpcTimeout: bumpRpcTimeout,
    execDetached: execDetached,
    getClashRunning: getClashRunning,
    waitForServiceStatus: waitForServiceStatus,
    SERVICE_POLL_TIMEOUT_MS: SERVICE_POLL_TIMEOUT_MS,

    isLightTheme: function() {
        if (document.documentElement.dataset.bsTheme === 'dark') return false;
        if (document.documentElement.dataset.bsTheme === 'light') return true;
        const bg = window.getComputedStyle(document.body).backgroundColor;
        const m = bg.match(/\d+/g);
        if (m && m.length >= 3)
            return (0.299 * +m[0] + 0.587 * +m[1] + 0.114 * +m[2]) / 255 > 0.5;
        return true;
    }
});
