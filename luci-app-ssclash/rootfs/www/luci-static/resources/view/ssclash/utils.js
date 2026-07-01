'use strict';
'require fs';
'require rpc';

const RPC_TIMEOUT_SEC = 60;
const SERVICE_POLL_TIMEOUT_MS = 60000;
const SERVICE_POLL_INTERVAL_MS = 500;
const WRITE_CHUNK_SIZE = 8000;
const WRITE_INLINE_MAX = 32768;

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

function shellQuote(s) {
    return '\'' + String(s).replace(/'/g, "'\\''") + '\'';
}

function encodeBase64Utf8(str) {
    const bytes = new TextEncoder().encode(str);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

async function writeFile(path, content) {
    if (content.length <= WRITE_INLINE_MAX) {
        return fs.write(path, content);
    }

    const tmpB64 = '/tmp/ssclash-write.b64';
    const b64 = encodeBase64Utf8(content);

    await fs.exec('/bin/sh', ['-c', 'rm -f ' + shellQuote(tmpB64)]);

    for (let offset = 0; offset < b64.length; offset += WRITE_CHUNK_SIZE) {
        const chunk = b64.slice(offset, offset + WRITE_CHUNK_SIZE);
        const op = offset === 0 ? '>' : '>>';
        const res = await fs.exec('/bin/sh', ['-c',
            'printf %s ' + shellQuote(chunk) + ' ' + op + ' ' + shellQuote(tmpB64)
        ]);
        if (res.code !== 0) {
            throw new Error((res.stderr || res.stdout || '').trim() || 'chunk write failed');
        }
    }

    const res = await fs.exec('/bin/sh', ['-c',
        'base64 -d ' + shellQuote(tmpB64) + ' > ' + shellQuote(path) +
        ' && rm -f ' + shellQuote(tmpB64)
    ]);
    if (res.code !== 0) {
        throw new Error((res.stderr || res.stdout || '').trim() || 'decode write failed');
    }
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
    writeFile: writeFile,
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
