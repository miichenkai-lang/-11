const http = require('http');
const crypto = require('crypto');

const MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const PORT = process.env.PORT || 8080;

const clients = new Map();
const queue = [];
let idc = 1;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('飛行航天 對戰伺服器 OK');
});

server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { sock.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + MAGIC).digest('base64');
  sock.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  const c = { id: idc++, sock, peer: null, inQueue: false };
  clients.set(c.id, c);
  sock.on('data', d => handleData(c, d));
  sock.on('error', () => onClose(c));
  sock.on('close', () => onClose(c));
});

function send(c, obj) {
  if (!c || !c.sock || c.sock.destroyed) return;
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  let hdrLen = 2;
  if (buf.length >= 126) hdrLen = buf.length < 65536 ? 4 : 10;
  const hdr = Buffer.alloc(hdrLen);
  hdr[0] = 0x81;
  if (buf.length < 126) {
    hdr[1] = buf.length;
  } else if (buf.length < 65536) {
    hdr[1] = 126; hdr.writeUInt16BE(buf.length, 2);
  } else {
    hdr[1] = 127; hdr.writeBigUInt64BE(BigInt(buf.length), 2);
  }
  c.sock.write(Buffer.concat([hdr, buf]));
}

function handleData(c, d) {
  c.buf = c.buf ? Buffer.concat([c.buf, d]) : d;
  while (c.buf && c.buf.length >= 2) {
    const b = c.buf;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < off + 2) return;
      len = b.readUInt16BE(off); off += 2;
    } else if (len === 127) {
      if (b.length < off + 8) return;
      len = Number(b.readBigUInt64BE(off)); off += 8;
    }
    if (masked) {
      if (b.length < off + 4) return;
      off += 4;
    }
    if (b.length < off + len) return;
    let payload;
    if (masked) {
      const key = b.slice(off - 4, off);
      payload = Buffer.alloc(len);
      for (let i = 0; i < len; i++) payload[i] = b[off + i] ^ key[i % 4];
    } else {
      payload = b.slice(off, off + len);
    }
    c.buf = b.slice(off + len);
    if (opcode === 1) {
      try { onMsg(c, JSON.parse(payload.toString('utf8'))); } catch (e) { }
    } else if (opcode === 8) {
      onClose(c);
      c.sock.end();
      return;
    }
  }
}

function onMsg(c, m) {
  if (!m || !m.t) return;
  if (m.t === 'join') {
    c.vehicle = m.vehicle || 'jet';
    if (!c.inQueue && !c.peer) {
      c.inQueue = true;
      queue.push(c);
      tryMatch();
    }
  } else if (c.peer) {
    if (m.t === 'state' || m.t === 'fire' || m.t === 'hit' || m.t === 'dead') {
      send(c.peer, m);
    }
  }
}

function tryMatch() {
  while (queue.length >= 2) {
    const a = queue.shift();
    const b = queue.shift();
    if (!a || !b || a.sock.destroyed || b.sock.destroyed) continue;
    a.inQueue = false; b.inQueue = false;
    a.peer = b; b.peer = a;
    send(a, { t: 'match', role: 1, opponent: b.vehicle || 'jet' });
    send(b, { t: 'match', role: 2, opponent: a.vehicle || 'jet' });
  }
}

function onClose(c) {
  if (!clients.has(c.id)) return;
  clients.delete(c.id);
  const i = queue.indexOf(c);
  if (i >= 0) queue.splice(i, 1);
  if (c.peer) {
    const opp = c.peer;
    c.peer = null;
    opp.peer = null;
    send(opp, { t: 'bye' });
  }
}

server.listen(PORT, () => {
  console.log('飛行航天 對戰伺服器已啟動 -> ws://127.0.0.1:' + PORT);
  console.log('瀏覽器填寫此位址並選「真人對戰」即可配對（同電腦開兩個分頁就能互相對戰）');
});