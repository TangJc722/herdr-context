#!/usr/bin/env node
// Stand-in for `codex -s read-only -a never app-server` in tests.
// FAKE_CODEX_MODE: ok (default) | signed_out | silent | crash | bad_args_check
// Speaks the app-server wire format: one JSON object per line, no "jsonrpc" field.
const mode = process.env.FAKE_CODEX_MODE || 'ok';
const args = process.argv.slice(2).join(' ');
if (args !== '-s read-only -a never app-server') {
  process.stderr.write(`unexpected args: ${args}\n`);
  process.exit(3);
}
if (mode === 'crash') {
  process.stderr.write('boom\n');
  process.exit(1);
}
const out = (m) => process.stdout.write(JSON.stringify(m) + '\n');
let buf = '';
let initialized = false;
process.stdin.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const msg = JSON.parse(buf.slice(0, nl));
    buf = buf.slice(nl + 1);
    if (mode === 'silent') continue;
    if (msg.method === 'initialize') {
      if (!msg.params?.clientInfo?.name) return out({ id: msg.id, error: { code: -32602, message: 'clientInfo required' } });
      out({ method: 'account/updated', params: { reason: null } }); // unrelated notification first
      out({ id: msg.id, result: { userAgent: 'codex/fake' } });
    } else if (msg.method === 'initialized') {
      initialized = true;
    } else if (msg.method === 'account/rateLimits/read') {
      if (!initialized) return out({ id: msg.id, error: { code: -32600, message: 'not initialized' } });
      if (mode === 'signed_out') return out({ id: msg.id, error: { code: -32600, message: 'codex account authentication required to read rate limits' } });
      const now = Math.floor(Date.now() / 1000);
      out({
        id: msg.id,
        result: {
          ordinaryUsageAllowed: true,
          rateLimits: { limitId: 'codex', primary: { usedPercent: 18, windowDurationMins: 300, resetsAt: now + 3600 } },
          rateLimitsByLimitId: {
            codex: {
              limitId: 'codex', planType: 'plus',
              primary: { usedPercent: 18, windowDurationMins: 300, resetsAt: now + 3600 },
              secondary: { usedPercent: 47, windowDurationMins: 10080, resetsAt: now + 86400 },
              credits: { hasCredits: false, unlimited: false, balance: null },
            },
            codex_other: { limitId: 'codex_other', limitName: 'GPT-5.5-Codex', primary: { usedPercent: 60, windowDurationMins: 10080, resetsAt: now + 86400 } },
          },
        },
      });
    }
  }
});
