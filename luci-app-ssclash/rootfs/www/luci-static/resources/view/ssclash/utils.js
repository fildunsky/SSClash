'use strict';
'require fs';
'require rpc';

const RPC_TIMEOUT_SEC = 60;
const SERVICE_POLL_TIMEOUT_MS = 60000;
const SERVICE_POLL_INTERVAL_MS = 500;
const WRITE_CHUNK_SIZE = 8000;
const WRITE_INLINE_MAX = 32768;
const MAX_CLASH_TEST_ERROR_LEN = 8000;

function unescapeLogString(s) {
    return String(s)
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
}

function stripClashLogPrefix(line) {
    return String(line)
        .replace(/^time="[^"]+"\s+level=\w+\s+/, '')
        .replace(/^ERRO\[[^\]]+\]\s*/, '')
        .replace(/^WARN\[[^\]]+\]\s*/, '')
        .trim();
}

function formatClashTestError(stdout, stderr) {
    const raw = [stderr, stdout]
        .filter(function(s) { return s && String(s).trim(); })
        .join('\n')
        .trim();
    if (!raw) return '';

    const lines = [];
    const seen = new Set();

    function addLine(line) {
        if (line == null) return;
        line = String(line).replace(/\r/g, '').trim();
        if (!line || seen.has(line)) return;
        seen.add(line);
        lines.push(line);
    }

    function addBlock(text) {
        unescapeLogString(text).split('\n').forEach(function(l) {
            l = l.trim();
            if (l) addLine(l);
        });
    }

    let m;
    const msgRe = /msg="((?:\\.|[^"\\])*)"/g;
    while ((m = msgRe.exec(raw)) !== null) {
        addBlock(m[1]);
    }

    raw.split('\n').forEach(function(line) {
        const t = line.trim();
        if (!t || /level=(info|debug)\b/i.test(t)) return;

        const erro = t.match(/^ERRO\[[^\]]+\]\s*(.+)$/);
        if (erro) {
            addLine(erro[1]);
            return;
        }

        if (/^time="[^"]+"\s+level=(fatal|error)\b/i.test(t) && !/msg="/.test(t)) {
            addLine(stripClashLogPrefix(t));
            return;
        }

        if (/^(Error:|Parse config error:|panic:)/i.test(t)) {
            addLine(t);
            return;
        }
        if (/^Profile Check Failed/i.test(t)) {
            addLine(t);
            return;
        }
        if (/^yaml:/i.test(t) || /^line \d+:/i.test(t)) {
            addLine(t);
            return;
        }
        if (/configuration file .+ test failed/i.test(t)) {
            addLine(t);
            return;
        }
    });

    let out = lines.join('\n');
    if (!out) {
        out = raw.split('\n')
            .map(stripClashLogPrefix)
            .filter(function(l) { return l && !/level=(info|debug)\b/i.test(l); })
            .join('\n');
    }

    if (out.length > MAX_CLASH_TEST_ERROR_LEN) {
        out = out.slice(0, MAX_CLASH_TEST_ERROR_LEN) + '\n…';
    }
    return out;
}

function formatClashLogMessage(raw) {
    if (raw == null) return '';
    const m = String(raw).trim();
    if (!m) return '';

    const nested = m.match(/^time="[^"]+"\s+level=\w+\s+msg="((?:\\.|[^"\\])*)"$/);
    if (nested) {
        return unescapeLogString(nested[1]);
    }

    const msgOnly = m.match(/^msg="((?:\\.|[^"\\])*)"$/);
    if (msgOnly) {
        return unescapeLogString(msgOnly[1]);
    }

    return m;
}

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
    formatClashTestError: formatClashTestError,
    formatClashLogMessage: formatClashLogMessage,
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
