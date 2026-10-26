// Service worker: mantém a conexão WebSocket com o VS Code.
// Fica fora da página do chat, então não sofre bloqueios de rede local/CSP do site.
const WS_URL = 'ws://127.0.0.1:8765';

chrome.runtime.onConnect.addListener(port => {
    if (port.name !== 'vscode-bridge') return;

    const safePost = msg => { try { port.postMessage(msg); } catch { /* aba fechada */ } };
    let sock;
    let keepAlive = null;

    try {
        sock = new WebSocket(WS_URL);
    } catch {
        safePost({ t: 'close' });
        return;
    }

    sock.onopen = () => {
        safePost({ t: 'open' });
        // Evita o service worker ser suspenso enquanto há conexão aberta
        keepAlive = setInterval(() => {
            if (sock.readyState === WebSocket.OPEN) sock.send('{"type":"ping"}');
        }, 20000);
    };
    sock.onmessage = e => safePost({ t: 'msg', data: e.data });
    sock.onerror = () => { /* onclose cuida do resto */ };
    sock.onclose = () => {
        clearInterval(keepAlive);
        safePost({ t: 'close' });
    };

    port.onMessage.addListener(m => {
        if (m && m.t === 'send' && sock.readyState === WebSocket.OPEN) sock.send(m.data);
    });
    port.onDisconnect.addListener(() => {
        clearInterval(keepAlive);
        try { sock.close(); } catch { /* ignore */ }
    });
});
