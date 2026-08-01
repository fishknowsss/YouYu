import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { readFetchTextBounded, readIncomingMessageTextBounded } from '../../src/main/http/boundedBody';

describe('bounded response bodies', () => {
  it('reads a fetch response whose byte length exactly matches the limit', async () => {
    const response = new Response('test', { headers: { 'content-length': '4' } });

    await expect(readFetchTextBounded(response, { maxBytes: 4, scope: 'test' })).resolves.toBe('test');
  });

  it('decodes UTF-8 characters split across many response chunks', async () => {
    const bytes = new TextEncoder().encode('测速完成');
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
          controller.close();
        }
      })
    );

    await expect(readFetchTextBounded(response, { maxBytes: bytes.length, scope: 'test' })).resolves.toBe('测速完成');
  });

  it('rejects an oversized fetch Content-Length before consuming and cancels the body', async () => {
    let canceledWith: unknown;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('hello'));
          controller.close();
        },
        cancel(reason) {
          canceledWith = reason;
        }
      }),
      { headers: { 'content-length': '5' } }
    );

    await expect(readFetchTextBounded(response, { maxBytes: 4, scope: 'test' })).rejects.toMatchObject({
      code: 'RESPONSE_BODY_TOO_LARGE'
    });
    expect(canceledWith).toMatchObject({ code: 'RESPONSE_BODY_TOO_LARGE' });
  });

  it('rejects a chunked fetch body as soon as its accumulated bytes exceed the limit', async () => {
    let canceledWith: unknown;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2]));
          controller.enqueue(new Uint8Array([3, 4, 5]));
        },
        cancel(reason) {
          canceledWith = reason;
        }
      })
    );

    await expect(readFetchTextBounded(response, { maxBytes: 4, scope: 'test' })).rejects.toMatchObject({
      code: 'RESPONSE_BODY_TOO_LARGE'
    });
    expect(canceledWith).toMatchObject({ code: 'RESPONSE_BODY_TOO_LARGE' });
  });

  it('cancels an in-flight fetch body and rejects with the abort reason', async () => {
    let canceledWith: unknown;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          closeTimer = setTimeout(() => controller.close(), 25);
        },
        cancel(reason) {
          if (closeTimer) clearTimeout(closeTimer);
          canceledWith = reason;
        }
      })
    );
    const controller = new AbortController();
    const reason = new Error('test canceled');

    const reading = readFetchTextBounded(response, { maxBytes: 4, scope: 'test', signal: controller.signal });
    controller.abort(reason);

    await expect(reading).rejects.toBe(reason);
    expect(canceledWith).toBe(reason);
  });

  it('reads an IncomingMessage whose byte length exactly matches the limit', async () => {
    const origin = await getIncomingResponse((_request, response) => {
      response.writeHead(200, { 'content-length': '4' });
      response.end('test');
    });

    try {
      await expect(readIncomingMessageTextBounded(origin.response, { maxBytes: 4, scope: 'test' })).resolves.toBe(
        'test'
      );
    } finally {
      await origin.close();
    }
  });

  it('rejects an oversized IncomingMessage Content-Length and destroys the response', async () => {
    const origin = await getIncomingResponse((_request, response) => {
      response.writeHead(200, { 'content-length': '5' });
      response.end('hello');
    });

    try {
      await expect(
        readIncomingMessageTextBounded(origin.response, { maxBytes: 4, scope: 'test' })
      ).rejects.toMatchObject({ code: 'RESPONSE_BODY_TOO_LARGE' });
      expect(origin.response.destroyed).toBe(true);
    } finally {
      await origin.close();
    }
  });

  it('rejects a chunked IncomingMessage once accumulated bytes exceed the limit', async () => {
    const origin = await getIncomingResponse((_request, response) => {
      response.writeHead(200);
      response.write(Buffer.from([1, 2]));
      setImmediate(() => response.write(Buffer.from([3, 4, 5])));
      setTimeout(() => response.end(), 25);
    });

    try {
      await expect(
        readIncomingMessageTextBounded(origin.response, { maxBytes: 4, scope: 'test' })
      ).rejects.toMatchObject({ code: 'RESPONSE_BODY_TOO_LARGE' });
      expect(origin.response.destroyed).toBe(true);
    } finally {
      await origin.close();
    }
  });

  it('destroys an in-flight IncomingMessage and rejects with the abort reason', async () => {
    const origin = await getIncomingResponse((_request, response) => {
      response.writeHead(200);
      response.write('a');
      setTimeout(() => response.end(), 25);
    });
    const controller = new AbortController();
    const reason = new Error('test canceled');

    try {
      const reading = readIncomingMessageTextBounded(origin.response, {
        maxBytes: 4,
        scope: 'test',
        signal: controller.signal
      });
      controller.abort(reason);

      await expect(reading).rejects.toBe(reason);
      expect(origin.response.destroyed).toBe(true);
    } finally {
      await origin.close();
    }
  });
});

async function getIncomingResponse(
  handler: (request: IncomingMessage, response: ServerResponse) => void
): Promise<{ response: IncomingMessage; close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server failed to listen');
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port: address.port }, resolve);
    request.once('error', reject);
    request.end();
  });
  return {
    response,
    close: async () => {
      response.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}
