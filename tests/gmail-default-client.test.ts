import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";

import {
  createDefaultGmailApiClient,
  GoogleapisGmailClientAdapter,
  NativeGmailDataTransport,
  type RawGmailHttp2Session,
  type RawGmailApi,
} from "../src/gmail/default-client.js";

type RawCall = {
  method: string;
  params: Record<string, unknown>;
  options: Record<string, unknown>;
};

type RawHandlers = {
  profile?: () => Promise<unknown>;
  list?: () => Promise<unknown>;
  message?: (format: "full" | "raw") => Promise<unknown>;
  attachment?: () => Promise<unknown>;
};

class FakeHttp2Stream extends EventEmitter {
  readonly headers: Record<string, string>;
  ended = false;
  closedWith: number | undefined;

  constructor(headers: Record<string, string>) {
    super();
    this.headers = headers;
  }

  end(): void {
    this.ended = true;
  }

  close(code?: number): void {
    this.closedWith = code;
    this.emit("close");
  }

  respond(
    data: unknown,
    status = 200,
    headers: Record<string, string | number> = {},
  ): void {
    const body = typeof data === "string" ? data : JSON.stringify(data);
    this.emit("response", { ":status": status, ...headers });
    this.emit("data", Buffer.from(body));
    this.emit("end");
    this.emit("close");
  }
}

class FakeHttp2Session extends EventEmitter {
  readonly streams: FakeHttp2Stream[] = [];
  refCalls = 0;
  unrefCalls = 0;
  closeCalls = 0;
  destroyCalls = 0;
  closed = false;
  destroyed = false;

  request(headers: Record<string, string>): FakeHttp2Stream {
    const stream = new FakeHttp2Stream(headers);
    this.streams.push(stream);
    return stream;
  }

  ref(): this {
    this.refCalls += 1;
    return this;
  }

  unref(): this {
    this.unrefCalls += 1;
    return this;
  }

  close(): void {
    this.closeCalls += 1;
    this.closed = true;
    this.emit("close");
  }

  destroy(): void {
    this.destroyCalls += 1;
    this.destroyed = true;
    this.emit("close");
  }
}

function fakeRaw(
  handlers: RawHandlers = {},
): { client: RawGmailApi; calls: RawCall[] } {
  const calls: RawCall[] = [];
  const record = async (
    method: string,
    params: Record<string, unknown>,
    options: Record<string, unknown>,
    handler: () => Promise<unknown>,
  ) => {
    calls.push({ method, params, options });
    return { data: await handler() };
  };
  const client: RawGmailApi = {
    users: {
      getProfile: (params, options) =>
        record("profile", params, options, handlers.profile ?? (async () => ({
          emailAddress: "pierre@example.com",
        }))),
      messages: {
        list: (params, options) =>
          record("list", params, options, handlers.list ?? (async () => ({ messages: [] }))),
        get: (params, options) =>
          record(
            `message:${params.format}`,
            params,
            options,
            () => handlers.message?.(params.format) ?? Promise.resolve(
              params.format === "raw" ? { id: params.id, raw: "cmF3" } : { id: params.id },
            ),
          ),
        attachments: {
          get: (params, options) =>
            record(
              "attachment",
              params,
              options,
              handlers.attachment ?? (async () => ({ data: "YXR0YWNobWVudA", size: 10 })),
            ),
        },
      },
    },
  };
  return { client, calls };
}

describe("NativeGmailDataTransport", () => {
  it("multiplexes raw and attachment requests over one identity-encoded session", async () => {
    const session = new FakeHttp2Session();
    let connections = 0;
    const transport = new NativeGmailDataTransport("memory-token", {
      connect: (origin) => {
        assert.equal(origin, "https://gmail.googleapis.com");
        connections += 1;
        return session as unknown as RawGmailHttp2Session;
      },
      idleMilliseconds: 60_000,
    });
    try {
      const raw = transport.getRawMessage("message/id");
      const attachment = transport.getAttachment("message/id", "attachment+id");
      assert.equal(connections, 1);
      assert.equal(session.streams.length, 2);

      for (const stream of session.streams) {
        assert.equal(stream.headers[":method"], "GET");
        assert.equal(stream.headers.authorization, "Bearer memory-token");
        assert.equal(stream.headers.accept, "application/json");
        assert.equal(stream.headers["accept-encoding"], "identity");
        assert.equal(stream.ended, true);
      }
      assert.equal(
        session.streams[0]?.headers[":path"],
        "/gmail/v1/users/me/messages/message%2Fid?format=raw&fields=id%2Craw",
      );
      assert.equal(
        session.streams[1]?.headers[":path"],
        "/gmail/v1/users/me/messages/message%2Fid/attachments/attachment%2Bid?fields=data%2Csize",
      );

      session.streams[1]?.respond({ data: "YXR0YWNobWVudA", size: 10 });
      session.streams[0]?.respond({ id: "message/id", raw: "cmF3" });
      assert.deepEqual(await attachment, { data: "YXR0YWNobWVudA", size: 10 });
      assert.deepEqual(await raw, { id: "message/id", raw: "cmF3" });
      assert.equal(session.refCalls, 2);
      assert.equal(session.unrefCalls, 1);
    } finally {
      transport.close();
    }
    assert.equal(session.destroyCalls, 1);
  });

  it("normalizes HTTP errors and bounds response bodies", async () => {
    const session = new FakeHttp2Session();
    const transport = new NativeGmailDataTransport("token", {
      connect: () => session as unknown as RawGmailHttp2Session,
      maximumBodyBytes: 64,
      idleMilliseconds: 60_000,
    });
    try {
      const unavailable = transport.getAttachment("m1", "a1");
      session.streams[0]?.respond(
        { error: { message: "try later" } },
        503,
        { "retry-after": "2" },
      );
      await assert.rejects(unavailable, (error: unknown) => {
        const value = error as {
          message?: string;
          status?: number;
          response?: { headers?: Record<string, unknown> };
        };
        assert.equal(value.message, "try later");
        assert.equal(value.status, 503);
        assert.equal(value.response?.headers?.["retry-after"], "2");
        return true;
      });

      const oversized = transport.getRawMessage("m2");
      session.streams[1]?.emit("response", { ":status": 200, "content-length": "65" });
      await assert.rejects(oversized, (error: unknown) => {
        assert.equal((error as { code?: string }).code, "ERR_GMAIL_RESPONSE_TOO_LARGE");
        return true;
      });
      assert.notEqual(session.streams[1]?.closedWith, undefined);
    } finally {
      transport.close();
    }
  });

  it("aborts a vanished stream after the native timeout", async () => {
    const session = new FakeHttp2Session();
    const transport = new NativeGmailDataTransport("token", {
      connect: () => session as unknown as RawGmailHttp2Session,
      timeoutMilliseconds: 5,
      idleMilliseconds: 60_000,
    });
    try {
      const pending = transport.getRawMessage("m1");
      await assert.rejects(pending, (error: unknown) => {
        assert.equal((error as { code?: string }).code, "ETIMEDOUT");
        return true;
      });
      assert.notEqual(session.streams[0]?.closedWith, undefined);
      assert.equal(session.unrefCalls, 1);
    } finally {
      transport.close();
    }
  });
});

describe("GoogleapisGmailClientAdapter", () => {
  it("normalizes Gmail responses and sends HTTP/2 partial-field requests", async () => {
    const { client, calls } = fakeRaw({
      list: async () => ({
        messages: [{ id: "m1" }, { id: "m2" }],
        nextPageToken: "next",
      }),
      message: async (format) => format === "raw"
        ? { id: "m1", raw: "UmF3IG1lc3NhZ2U" }
        : {
            id: "m1",
            labelIds: ["INBOX", "IMPORTANT"],
            internalDate: "1785542400000",
            payload: {
              partId: "",
              mimeType: "multipart/mixed",
              filename: "",
              headers: [{ name: "Subject", value: "Invoice" }],
              body: { size: 0 },
              parts: [{
                partId: "1",
                mimeType: "application/pdf",
                filename: "invoice.pdf",
                headers: [],
                body: { attachmentId: "a1", size: 42 },
              }],
            },
          },
    });
    const adapter = new GoogleapisGmailClientAdapter(client);

    assert.deepEqual(await adapter.getProfile(), { emailAddress: "pierre@example.com" });
    assert.deepEqual(
      await adapter.listMessages({ query: "after:2026/07/01", maxResults: 500, pageToken: "p2" }),
      { messageIds: ["m1", "m2"], nextPageToken: "next" },
    );
    assert.deepEqual(await adapter.getMessage("m1"), {
      id: "m1",
      labelIds: ["INBOX", "IMPORTANT"],
      internalDate: "1785542400000",
      payload: {
        partId: "",
        mimeType: "multipart/mixed",
        filename: "",
        headers: [{ name: "Subject", value: "Invoice" }],
        body: { size: 0 },
        parts: [{
          partId: "1",
          mimeType: "application/pdf",
          filename: "invoice.pdf",
          headers: [],
          body: { attachmentId: "a1", size: 42 },
          parts: [],
        }],
      },
    });
    assert.equal(await adapter.getRawMessage("m1"), "UmF3IG1lc3NhZ2U");
    assert.deepEqual(await adapter.getAttachment("m1", "a1"), {
      data: "YXR0YWNobWVudA",
      size: 10,
    });

    assert.deepEqual(calls.map((call) => call.method), [
      "profile",
      "list",
      "message:full",
      "message:raw",
      "attachment",
    ]);
    for (const call of calls) {
      assert.deepEqual(call.options, {
        http2: true,
        timeout: 15_000,
        retry: false,
        retryConfig: { retry: 0 },
        headers: { "Accept-Encoding": "identity" },
      });
    }
    assert.deepEqual(calls[1]?.params, {
      userId: "me",
      q: "after:2026/07/01",
      maxResults: 500,
      includeSpamTrash: false,
      fields: "messages/id,nextPageToken",
      pageToken: "p2",
    });
    assert.equal(calls[2]?.params.format, "full");
    assert.equal(calls[2]?.params.fields, "id,labelIds,internalDate,payload");
    assert.equal(calls[3]?.params.format, "raw");
  });

  it("limits all concurrent Gmail calls to ten", async () => {
    let active = 0;
    let maximum = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { client, calls } = fakeRaw({
      message: async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await gate;
        active -= 1;
        return { raw: "cmF3" };
      },
    });
    const adapter = new GoogleapisGmailClientAdapter(client);
    const running = Array.from({ length: 12 }, (_, index) =>
      adapter.getRawMessage(`m${index}`),
    );

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 10);
    assert.equal(maximum, 10);
    release();
    await Promise.all(running);
    assert.equal(calls.length, 12);
    assert.equal(maximum, 10);
  });

  it("keeps a ref'ed deadline, releases the limiter, retries, and consumes late rejection", async () => {
    let attempts = 0;
    let rejectVanished!: (error: Error) => void;
    const sleeps: number[] = [];
    const { client } = fakeRaw({
      message: async () => {
        attempts += 1;
        if (attempts === 1) {
          return await new Promise<never>((_resolve, reject) => {
            rejectVanished = reject;
          });
        }
        return { raw: "cmV0cmllZA" };
      },
    });
    const adapter = new GoogleapisGmailClientAdapter(client, {
      requestConcurrency: 1,
      deadlineMilliseconds: 5,
      sleep: async (milliseconds) => { sleeps.push(milliseconds); },
      random: () => 0,
    });

    assert.equal(await adapter.getRawMessage("m1"), "cmV0cmllZA");
    assert.equal(attempts, 2);
    assert.deepEqual(sleeps, [1_000]);

    // The first operation's socket-level failure can arrive after the adapter
    // has timed out and retried. Its rejection must already have a consumer.
    rejectVanished(new Error("late vanished-stream rejection"));
    await new Promise((resolve) => setImmediate(resolve));
  });

  it("runs injected native data transport calls through the existing limiter and retries", async () => {
    const { client, calls } = fakeRaw();
    let attempts = 0;
    const sleeps: number[] = [];
    const adapter = new GoogleapisGmailClientAdapter(client, {
      dataTransport: {
        getRawMessage: async () => ({ raw: "cmF3" }),
        getAttachment: async () => {
          attempts += 1;
          if (attempts === 1) {
            throw Object.assign(new Error("temporarily unavailable"), { status: 503 });
          }
          return { data: "YXR0YWNobWVudA", size: 10 };
        },
      },
      sleep: async (milliseconds) => { sleeps.push(milliseconds); },
      random: () => 0,
    });

    assert.deepEqual(await adapter.getAttachment("m1", "a1"), {
      data: "YXR0YWNobWVudA",
      size: 10,
    });
    assert.equal(attempts, 2);
    assert.deepEqual(sleeps, [1_000]);
    assert.deepEqual(calls, []);
  });

  it("retries 429, 5xx, and transport failures three times with backoff", async () => {
    const errors = [
      Object.assign(new Error("quota"), {
        response: { status: 429, headers: { "Retry-After": "3" } },
      }),
      Object.assign(new Error("server"), { response: { status: 503 } }),
      Object.assign(new Error("socket"), { code: "ECONNRESET" }),
    ];
    let attempts = 0;
    const sleeps: number[] = [];
    const { client } = fakeRaw({
      profile: async () => {
        const error = errors[attempts++];
        if (error) throw error;
        return { emailAddress: "pierre@example.com" };
      },
    });
    const adapter = new GoogleapisGmailClientAdapter(client, {
      sleep: async (milliseconds) => { sleeps.push(milliseconds); },
      random: () => 0.5,
    });

    assert.deepEqual(await adapter.getProfile(), { emailAddress: "pierre@example.com" });
    assert.equal(attempts, 4);
    assert.deepEqual(sleeps, [3_000, 2_125, 4_125]);
  });

  it("retries direct and wrapped zlib response failures even with HTTP status 200", async () => {
    let attachmentAttempts = 0;
    let rawAttempts = 0;
    const sleeps: number[] = [];
    const { client } = fakeRaw({
      attachment: async () => {
        attachmentAttempts += 1;
        if (attachmentAttempts === 1) {
          throw Object.assign(new Error("unexpected end of file"), {
            code: "Z_BUF_ERROR",
            response: { status: 200 },
          });
        }
        return { data: "YXR0YWNobWVudA", size: 10 };
      },
      message: async (format) => {
        assert.equal(format, "raw");
        rawAttempts += 1;
        if (rawAttempts === 1) {
          throw Object.assign(new Error("response decompression failed"), {
            response: { status: 200 },
            cause: Object.assign(new Error("invalid compressed data"), {
              code: "Z_DATA_ERROR",
            }),
          });
        }
        return { raw: "cmF3" };
      },
    });
    const adapter = new GoogleapisGmailClientAdapter(client, {
      sleep: async (milliseconds) => { sleeps.push(milliseconds); },
      random: () => 0,
    });

    assert.deepEqual(await adapter.getAttachment("m1", "a1"), {
      data: "YXR0YWNobWVudA",
      size: 10,
    });
    assert.equal(await adapter.getRawMessage("m1"), "cmF3");
    assert.equal(attachmentAttempts, 2);
    assert.equal(rawAttempts, 2);
    assert.deepEqual(sleeps, [1_000, 1_000]);
  });

  it("does not treat an unrelated HTTP 200 application error as a zlib failure", async () => {
    let attempts = 0;
    const expected = Object.assign(new Error("unexpected end of file"), {
      response: { status: 200 },
    });
    const { client } = fakeRaw({
      attachment: async () => {
        attempts += 1;
        throw expected;
      },
    });
    const adapter = new GoogleapisGmailClientAdapter(client, {
      sleep: async () => assert.fail("must not retry without a zlib code"),
    });

    await assert.rejects(adapter.getAttachment("m1", "a1"), (error) => error === expected);
    assert.equal(attempts, 1);
  });

  it("normalizes an absent message-list response body to an empty page", async () => {
    for (const emptyData of [undefined, null]) {
      const { client } = fakeRaw({ list: async () => emptyData });
      const adapter = new GoogleapisGmailClientAdapter(client);
      assert.deepEqual(
        await adapter.listMessages({ query: "has:attachment", maxResults: 500 }),
        { messageIds: [] },
      );
    }
  });

  it("does not retry authentication or permission errors", async () => {
    for (const status of [401, 403]) {
      let attempts = 0;
      const expected = Object.assign(new Error(`status ${status}`), { status });
      const { client } = fakeRaw({
        profile: async () => {
          attempts += 1;
          throw expected;
        },
      });
      const adapter = new GoogleapisGmailClientAdapter(client, {
        sleep: async () => assert.fail("must not sleep"),
      });
      await assert.rejects(adapter.getProfile(), (error: unknown) => error === expected);
      assert.equal(attempts, 1);
    }
  });

  it("rejects malformed API responses without retrying", async () => {
    const malformedCases: Array<{
      run(adapter: GoogleapisGmailClientAdapter): Promise<unknown>;
      handlers: RawHandlers;
      match: RegExp;
    }> = [
      {
        handlers: { profile: async () => ({}) },
        run: (adapter) => adapter.getProfile(),
        match: /profile emailAddress is malformed/u,
      },
      {
        handlers: { list: async () => ({ messages: [{ threadId: "t1" }] }) },
        run: (adapter) => adapter.listMessages({ query: "x", maxResults: 500 }),
        match: /list item 1 id is malformed/u,
      },
      {
        handlers: { message: async () => ({ id: "m1", payload: { parts: {} } }) },
        run: (adapter) => adapter.getMessage("m1"),
        match: /payload parts is malformed/u,
      },
      {
        handlers: { attachment: async () => ({ size: 10 }) },
        run: (adapter) => adapter.getAttachment("m1", "a1"),
        match: /attachment data is malformed/u,
      },
    ];

    for (const testCase of malformedCases) {
      const { client, calls } = fakeRaw(testCase.handlers);
      const adapter = new GoogleapisGmailClientAdapter(client, {
        sleep: async () => assert.fail("malformed data must not retry"),
      });
      await assert.rejects(testCase.run(adapter), testCase.match);
      assert.equal(calls.length, 1);
    }
  });
});

describe("createDefaultGmailApiClient", () => {
  it("sets only the refreshed in-memory credentials and enables service HTTP/2", async () => {
    const credentialCalls: unknown[] = [];
    const constructorCalls: unknown[] = [];
    const gmailCalls: unknown[] = [];
    const { client } = fakeRaw();
    class FakeOAuth2 {
      constructor(clientId: string, clientSecret?: string) {
        constructorCalls.push({ clientId, clientSecret });
      }

      setCredentials(credentials: unknown): void {
        credentialCalls.push(credentials);
      }
    }

    const adapter = await createDefaultGmailApiClient(
      {
        email: "pierre@example.com",
        accessToken: "access-only",
        expiresAt: new Date("2026-08-26T12:00:00.000Z"),
        tokenType: "Bearer",
        scope: "https://www.googleapis.com/auth/gmail.readonly",
        oauthClient: { clientId: "client-id", clientSecret: "client-secret" },
      },
      {
        loadGoogleapis: async () => ({
          google: {
            auth: { OAuth2: FakeOAuth2 },
            gmail: (options) => {
              gmailCalls.push(options);
              return client;
            },
          },
        }),
      },
    );

    assert.ok(adapter instanceof GoogleapisGmailClientAdapter);
    assert.deepEqual(constructorCalls, [{
      clientId: "client-id",
      clientSecret: "client-secret",
    }]);
    assert.deepEqual(credentialCalls, [{
      access_token: "access-only",
      token_type: "Bearer",
      scope: "https://www.googleapis.com/auth/gmail.readonly",
      expiry_date: Date.parse("2026-08-26T12:00:00.000Z"),
    }]);
    assert.equal(gmailCalls.length, 1);
    assert.deepEqual(
      gmailCalls[0],
      { version: "v1", auth: (gmailCalls[0] as { auth: unknown }).auth, http2: true },
    );
  });
});
