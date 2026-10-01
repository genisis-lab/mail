import net from 'node:net';
import tls from 'node:tls';
import type { TcpConnector, TcpSocket } from '../src/server/platform';

/** Wrap a Node socket in the pull-based TcpSocket interface. */
function wrap(sock: net.Socket, host: string, allowSelfSigned: boolean): TcpSocket {
  const chunks: Uint8Array[] = [];
  let ended = false;
  let failure: Error | null = null;
  let waiter: (() => void) | null = null;
  const wake = () => {
    waiter?.();
    waiter = null;
  };
  const onData = (d: Buffer) => {
    chunks.push(new Uint8Array(d));
    wake();
  };
  const onEnd = () => {
    ended = true;
    wake();
  };
  const onError = (e: Error) => {
    failure = e;
    wake();
  };
  sock.on('data', onData).on('end', onEnd).on('close', onEnd).on('error', onError);

  return {
    async read() {
      while (!chunks.length && !ended && !failure) await new Promise<void>((r) => (waiter = r));
      if (chunks.length) return chunks.shift()!;
      if (failure) throw failure;
      return null;
    },
    write: (data) => new Promise((resolve, reject) => sock.write(data, (err) => (err ? reject(err) : resolve()))),
    async startTls() {
      sock.off('data', onData).off('end', onEnd).off('close', onEnd).off('error', onError);
      const secure = tls.connect({ socket: sock, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: !allowSelfSigned });
      await new Promise<void>((resolve, reject) => secure.once('secureConnect', resolve).once('error', reject));
      return wrap(secure, host, allowSelfSigned);
    },
    async close() {
      sock.end();
      sock.destroy();
    },
  };
}

export const nodeTcp: TcpConnector = {
  async connect({ host, port, tls: implicitTls, allowSelfSigned }) {
    const sock = implicitTls
      ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: !allowSelfSigned })
      : net.connect({ host, port });
    await new Promise<void>((resolve, reject) => {
      sock.once(implicitTls ? 'secureConnect' : 'connect', () => resolve()).once('error', reject);
    });
    return wrap(sock, host, allowSelfSigned);
  },
};
