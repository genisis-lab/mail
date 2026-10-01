import { connect, type Socket } from 'cloudflare:sockets';
import type { TcpConnector, TcpSocket } from '../server/platform.js';

/** Outbound TCP on Workers. Cloudflare blocks port 25; submission ports 587 and 465 work. */
function wrap(sock: Socket): TcpSocket {
  const reader = sock.readable.getReader();
  const writer = sock.writable.getWriter();
  return {
    async read() {
      const { value, done } = await reader.read();
      return done ? null : value;
    },
    write: (data) => writer.write(data),
    async startTls() {
      reader.releaseLock();
      writer.releaseLock();
      const secure = sock.startTls();
      await secure.opened;
      return wrap(secure);
    },
    async close() {
      await sock.close().catch(() => {});
    },
  };
}

export const workersTcp: TcpConnector = {
  async connect({ host, port, tls, starttls }) {
    if (Number(port) === 25) {
      throw new Error('Cloudflare Workers blocks outbound connections to port 25. Use the submission port 587 (STARTTLS) or 465 (TLS).');
    }
    const sock = connect({ hostname: host, port: Number(port) }, { secureTransport: tls ? 'on' : starttls ? 'starttls' : 'off', allowHalfOpen: false });
    await sock.opened;
    return wrap(sock);
  },
};
