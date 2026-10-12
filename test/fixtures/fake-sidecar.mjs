// A stand-in sidecar speaking Quill's protocol, for LineProcess tests.
let buf = Buffer.alloc(0);
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
out({ event: 'ready', version: 'test', platform: 'test' });
process.stdout.write('this line is not json\n');
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const nl = buf.indexOf(10);
    if (nl < 0) return;
    const req = JSON.parse(buf.subarray(0, nl).toString());
    const need = req.bytes ?? 0;
    if (buf.length < nl + 1 + need) return; // wait for the whole payload
    const payload = buf.subarray(nl + 1, nl + 1 + need);
    buf = buf.subarray(nl + 1 + need);
    if (req.cmd === 'sum') {
      const f = new Float32Array(payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.length));
      out({ id: req.id, ok: true, n: f.length, sum: f.reduce((a, b) => a + b, 0) });
    } else if (req.cmd === 'ping') {
      out({ event: 'hotkey', state: 'down' });
      out({ id: req.id, ok: true, pong: true });
    } else if (req.cmd === 'crash') {
      process.exit(3);
    } else if (req.cmd === 'shutdown') {
      out({ id: req.id, ok: true });
      process.exit(0);
    } else {
      out({ id: req.id, ok: false, error: `unknown command ${req.cmd}` });
    }
  }
});
