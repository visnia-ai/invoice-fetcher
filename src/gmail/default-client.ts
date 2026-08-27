import {
  connect as connectHttp2,
  constants as http2Constants,
} from "node:http2";

import type {
  GmailApiAttachment,
  GmailApiClient,
  GmailApiConnectionProfile,
  GmailApiListPage,
  GmailApiMessage,
  GmailApiMessagePart,
} from "./types.js";

interface RawResponse<T> {
  data: T;
}

interface RawMessagePart {
  partId?: unknown;
  mimeType?: unknown;
  filename?: unknown;
  headers?: unknown;
  body?: unknown;
  parts?: unknown;
}

interface RawMessage {
  id?: unknown;
  labelIds?: unknown;
  internalDate?: unknown;
  payload?: unknown;
  raw?: unknown;
}

interface RawRequestOptions {
  http2: true;
  timeout: 15_000;
  retry: false;
  retryConfig: { retry: 0 };
  headers: { "Accept-Encoding": "identity" };
}

export interface RawGmailApi {
  users: {
    getProfile(
      params: { userId: "me"; fields: string },
      options: RawRequestOptions,
    ): Promise<RawResponse<unknown>>;
    messages: {
      list(
        params: {
          userId: "me";
          q: string;
          maxResults: number;
          includeSpamTrash: false;
          fields: string;
          pageToken?: string;
        },
        options: RawRequestOptions,
      ): Promise<RawResponse<unknown>>;
      get(
        params: {
          userId: "me";
          id: string;
          format: "full" | "raw";
          fields: string;
        },
        options: RawRequestOptions,
      ): Promise<RawResponse<unknown>>;
      attachments: {
        get(
          params: { userId: "me"; messageId: string; id: string; fields: string },
          options: RawRequestOptions,
        ): Promise<RawResponse<unknown>>;
      };
    };
  };
}

interface RawOAuth2Client {
  setCredentials(credentials: {
    access_token: string;
    token_type: string;
    scope: string;
    expiry_date: number;
  }): void;
}

interface GoogleapisModule {
  google: {
    auth: {
      OAuth2: new (clientId: string, clientSecret?: string) => RawOAuth2Client;
    };
    gmail(options: {
      version: "v1";
      auth: RawOAuth2Client;
      http2: true;
    }): RawGmailApi;
  };
}

export interface GmailApiAdapterOptions {
  requestConcurrency?: number;
  deadlineMilliseconds?: number;
  dataTransport?: GmailDataTransport;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

export interface DefaultGmailApiClientDependencies {
  loadGoogleapis?: () => Promise<GoogleapisModule>;
  adapterOptions?: GmailApiAdapterOptions;
}

export interface GmailDataTransport {
  getRawMessage(messageId: string): Promise<unknown>;
  getAttachment(messageId: string, attachmentId: string): Promise<unknown>;
}

type RawHttp2Headers = Record<string, string | string[] | number | undefined>;

export interface RawGmailHttp2Stream {
  on(event: "response", listener: (headers: RawHttp2Headers) => void): this;
  on(event: "data", listener: (chunk: Buffer | Uint8Array | string) => void): this;
  on(event: "end", listener: () => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "aborted" | "close", listener: () => void): this;
  end(): void;
  close(code?: number): void;
}

export interface RawGmailHttp2Session {
  readonly closed?: boolean;
  readonly destroyed?: boolean;
  request(headers: Record<string, string>): RawGmailHttp2Stream;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "close" | "goaway", listener: (...arguments_: unknown[]) => void): this;
  ref(): this;
  unref(): this;
  close(): void;
  destroy(error?: Error): void;
}

export interface NativeGmailDataTransportOptions {
  connect?: (origin: string) => RawGmailHttp2Session;
  timeoutMilliseconds?: number;
  idleMilliseconds?: number;
  maximumBodyBytes?: number;
}

interface NativeSessionState {
  session: RawGmailHttp2Session;
  active: number;
  reusable: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
}

const REQUEST_OPTIONS: RawRequestOptions = {
  http2: true,
  // Abort vanished multiplexed streams while still allowing large attachment
  // bodies enough time per attempt. Gaxios implements this with
  // AbortSignal.timeout(), so it does not introduce our own ref'ed timer.
  timeout: 15_000,
  retry: false,
  retryConfig: { retry: 0 },
  // Large HTTP/2 Gmail payloads intermittently arrived truncated during zlib
  // decompression. Request the original representation and retain zlib retries
  // as defense for proxies or servers that ignore this preference.
  headers: { "Accept-Encoding": "identity" },
};

const FULL_MESSAGE_FIELDS = "id,labelIds,internalDate,payload";

async function loadGoogleapis(): Promise<GoogleapisModule> {
  // A non-literal import keeps this adapter easy to test without loading the
  // comparatively large googleapis package.
  const moduleName: string = "googleapis";
  return (await import(moduleName)) as GoogleapisModule;
}

/** Production Gmail API factory using the already-refreshed in-memory token. */
export async function createDefaultGmailApiClient(
  profile: GmailApiConnectionProfile,
  dependencies: DefaultGmailApiClientDependencies = {},
): Promise<GmailApiClient> {
  const imported = await (dependencies.loadGoogleapis ?? loadGoogleapis)();
  const oauth = new imported.google.auth.OAuth2(
    profile.oauthClient.clientId,
    profile.oauthClient.clientSecret,
  );
  oauth.setCredentials({
    access_token: profile.accessToken,
    token_type: profile.tokenType,
    scope: profile.scope,
    expiry_date: profile.expiresAt.getTime(),
  });
  const gmail = imported.google.gmail({ version: "v1", auth: oauth, http2: true });
  return new GoogleapisGmailClientAdapter(gmail, {
    ...dependencies.adapterOptions,
    dataTransport: dependencies.adapterOptions?.dataTransport ??
      new NativeGmailDataTransport(profile.accessToken),
  });
}

/** Native transport for Gmail's large raw and attachment response bodies. */
export class NativeGmailDataTransport implements GmailDataTransport {
  private readonly connect: (origin: string) => RawGmailHttp2Session;
  private readonly timeoutMilliseconds: number;
  private readonly idleMilliseconds: number;
  private readonly maximumBodyBytes: number;
  private readonly states = new Set<NativeSessionState>();
  private current: NativeSessionState | undefined;

  constructor(
    private readonly accessToken: string,
    options: NativeGmailDataTransportOptions = {},
  ) {
    this.connect = options.connect ?? ((origin) =>
      connectHttp2(origin) as unknown as RawGmailHttp2Session);
    this.timeoutMilliseconds = options.timeoutMilliseconds ?? 15_000;
    this.idleMilliseconds = options.idleMilliseconds ?? 30_000;
    this.maximumBodyBytes = options.maximumBodyBytes ?? 64 * 1024 * 1024;
    for (const [description, value] of [
      ["timeout", this.timeoutMilliseconds],
      ["idle timeout", this.idleMilliseconds],
      ["maximum body size", this.maximumBodyBytes],
    ] as const) {
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`Gmail native transport ${description} must be a positive number.`);
      }
    }
  }

  async getRawMessage(messageId: string): Promise<unknown> {
    const id = encodeURIComponent(messageId);
    return await this.requestJson(
      `/gmail/v1/users/me/messages/${id}?format=raw&fields=id%2Craw`,
    );
  }

  async getAttachment(messageId: string, attachmentId: string): Promise<unknown> {
    const message = encodeURIComponent(messageId);
    const attachment = encodeURIComponent(attachmentId);
    return await this.requestJson(
      `/gmail/v1/users/me/messages/${message}/attachments/${attachment}?fields=data%2Csize`,
    );
  }

  /** Immediately tears down any session when an owner explicitly disposes it. */
  close(): void {
    for (const state of [...this.states]) this.destroyState(state);
  }

  private requestJson(path: string): Promise<unknown> {
    const state = this.sessionState();
    this.beginRequest(state);
    let stream: RawGmailHttp2Stream;
    try {
      stream = state.session.request({
        ":method": "GET",
        ":path": path,
        authorization: `Bearer ${this.accessToken}`,
        accept: "application/json",
        "accept-encoding": "identity",
      });
    } catch (error) {
      this.finishRequest(state);
      return Promise.reject(error);
    }

    return new Promise<unknown>((resolve, reject) => {
      let completed = false;
      let status: number | undefined;
      let responseHeaders: RawHttp2Headers = {};
      let size = 0;
      const chunks: Buffer[] = [];
      const timer = setTimeout(() => {
        const error = Object.assign(
          new Error(`Gmail native data request exceeded ${this.timeoutMilliseconds}ms.`),
          { code: "ETIMEDOUT" },
        );
        fail(error);
        stream.close(http2Constants.NGHTTP2_CANCEL);
      }, this.timeoutMilliseconds);

      const finish = (callback: () => void): void => {
        if (completed) return;
        completed = true;
        clearTimeout(timer);
        this.finishRequest(state);
        callback();
      };
      const fail = (error: unknown): void => finish(() => reject(error));

      stream.on("response", (headers) => {
        responseHeaders = headers;
        const rawStatus = headers[":status"];
        status = typeof rawStatus === "number"
          ? rawStatus
          : typeof rawStatus === "string" && /^\d{3}$/u.test(rawStatus)
            ? Number(rawStatus)
            : undefined;
        const contentLength = headerNumber(headers["content-length"]);
        if (contentLength !== undefined && contentLength > this.maximumBodyBytes) {
          fail(responseTooLarge(this.maximumBodyBytes));
          stream.close(http2Constants.NGHTTP2_CANCEL);
        }
      });
      stream.on("data", (chunk) => {
        if (completed) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > this.maximumBodyBytes) {
          fail(responseTooLarge(this.maximumBodyBytes));
          stream.close(http2Constants.NGHTTP2_CANCEL);
          return;
        }
        chunks.push(buffer);
      });
      stream.on("end", () => {
        if (completed) return;
        if (status === undefined) {
          fail(Object.assign(new Error("Gmail native data response had no HTTP status."), {
            code: "EPROTO",
          }));
          return;
        }
        const body = Buffer.concat(chunks).toString("utf8");
        if (status < 200 || status >= 300) {
          fail(httpStatusError(status, responseHeaders, body));
          return;
        }
        try {
          const data = JSON.parse(body) as unknown;
          finish(() => resolve(data));
        } catch (error) {
          fail(new Error("Gmail native data response was not valid JSON.", { cause: error }));
        }
      });
      stream.on("error", fail);
      stream.on("aborted", () => fail(Object.assign(
        new Error("Gmail native data response was aborted."),
        { code: "ECONNRESET" },
      )));
      stream.on("close", () => {
        if (!completed) fail(Object.assign(
          new Error("Gmail native data stream closed before completion."),
          { code: "ECONNRESET" },
        ));
      });
      stream.end();
    });
  }

  private sessionState(): NativeSessionState {
    if (
      this.current?.reusable &&
      !this.current.session.closed &&
      !this.current.session.destroyed
    ) {
      return this.current;
    }
    const session = this.connect("https://gmail.googleapis.com");
    const state: NativeSessionState = { session, active: 0, reusable: true };
    this.states.add(state);
    this.current = state;
    session.on("error", () => this.retireState(state));
    session.on("goaway", () => this.retireState(state));
    session.on("close", () => this.closedState(state));
    return state;
  }

  private beginRequest(state: NativeSessionState): void {
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      delete state.idleTimer;
    }
    state.active += 1;
    state.session.ref();
  }

  private finishRequest(state: NativeSessionState): void {
    state.active = Math.max(0, state.active - 1);
    if (state.active !== 0) return;
    state.session.unref();
    if (!state.reusable) {
      this.closeState(state);
      return;
    }
    state.idleTimer = setTimeout(() => this.closeState(state), this.idleMilliseconds);
    state.idleTimer.unref();
  }

  private retireState(state: NativeSessionState): void {
    state.reusable = false;
    if (this.current === state) this.current = undefined;
    if (state.active === 0) this.closeState(state);
  }

  private closedState(state: NativeSessionState): void {
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.reusable = false;
    if (this.current === state) this.current = undefined;
    this.states.delete(state);
  }

  private closeState(state: NativeSessionState): void {
    this.closedState(state);
    try {
      state.session.close();
    } catch {
      state.session.destroy();
    }
  }

  private destroyState(state: NativeSessionState): void {
    this.closedState(state);
    try {
      state.session.destroy();
    } catch {
      // The session is already gone.
    }
  }
}

export class GoogleapisGmailClientAdapter implements GmailApiClient {
  private readonly limiter: RequestLimiter;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly deadlineMilliseconds: number;
  private readonly dataTransport: GmailDataTransport | undefined;

  constructor(
    private readonly client: RawGmailApi,
    options: GmailApiAdapterOptions = {},
  ) {
    this.limiter = new RequestLimiter(options.requestConcurrency ?? 10);
    this.deadlineMilliseconds = options.deadlineMilliseconds ?? 16_000;
    if (!Number.isFinite(this.deadlineMilliseconds) || this.deadlineMilliseconds <= 0) {
      throw new Error("Gmail API request deadline must be a positive number.");
    }
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
    this.dataTransport = options.dataTransport;
  }

  async getProfile(): Promise<{ emailAddress: string }> {
    const response = await this.request(() =>
      this.client.users.getProfile(
        { userId: "me", fields: "emailAddress" },
        REQUEST_OPTIONS,
      ),
    );
    const data = asRecord(response.data, "Gmail profile");
    return { emailAddress: requiredString(data.emailAddress, "Gmail profile emailAddress") };
  }

  async listMessages(input: {
    query: string;
    maxResults: number;
    pageToken?: string;
  }): Promise<GmailApiListPage> {
    const response = await this.request(() =>
      this.client.users.messages.list(
        {
          userId: "me",
          q: input.query,
          maxResults: input.maxResults,
          includeSpamTrash: false,
          fields: "messages/id,nextPageToken",
          ...(input.pageToken === undefined ? {} : { pageToken: input.pageToken }),
        },
        REQUEST_OPTIONS,
      ),
    );
    // googleapis can surface an absent response body for a valid empty list.
    // Keep this exception local to messages.list; other endpoints remain strict.
    const data = response.data === undefined || response.data === null
      ? {}
      : asRecord(response.data, "Gmail message list");
    const rawMessages = data.messages;
    if (rawMessages !== undefined && !Array.isArray(rawMessages)) {
      throw malformed("Gmail message list messages");
    }
    const messageIds = (rawMessages ?? []).map((message, index) => {
      const record = asRecord(message, `Gmail message list item ${index + 1}`);
      return requiredString(record.id, `Gmail message list item ${index + 1} id`);
    });
    const nextPageToken = optionalString(data.nextPageToken, "Gmail nextPageToken");
    return {
      messageIds,
      ...(nextPageToken === undefined ? {} : { nextPageToken }),
    };
  }

  async getMessage(messageId: string): Promise<GmailApiMessage> {
    const response = await this.request(() =>
      this.client.users.messages.get(
        {
          userId: "me",
          id: messageId,
          format: "full",
          fields: FULL_MESSAGE_FIELDS,
        },
        REQUEST_OPTIONS,
      ),
    );
    return normalizeMessage(response.data);
  }

  async getRawMessage(messageId: string): Promise<string> {
    const responseData = await this.request(async () =>
      this.dataTransport
        ? await this.dataTransport.getRawMessage(messageId)
        : (await this.client.users.messages.get(
            { userId: "me", id: messageId, format: "raw", fields: "id,raw" },
            REQUEST_OPTIONS,
          )).data,
    );
    const data = asRecord(responseData, "Gmail raw message");
    return requiredString(data.raw, "Gmail raw message data");
  }

  async getAttachment(
    messageId: string,
    attachmentId: string,
  ): Promise<GmailApiAttachment> {
    const responseData = await this.request(async () =>
      this.dataTransport
        ? await this.dataTransport.getAttachment(messageId, attachmentId)
        : (await this.client.users.messages.attachments.get(
            {
              userId: "me",
              messageId,
              id: attachmentId,
              fields: "data,size",
            },
            REQUEST_OPTIONS,
          )).data,
    );
    const data = asRecord(responseData, "Gmail attachment");
    const size = optionalNonNegativeNumber(data.size, "Gmail attachment size");
    return {
      data: requiredText(data.data, "Gmail attachment data"),
      ...(size === undefined ? {} : { size }),
    };
  }

  private async request<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.limiter.run(() =>
          withRefedDeadline(operation, this.deadlineMilliseconds),
        );
      } catch (error) {
        if (attempt >= 3 || !isRetryable(error)) throw error;
        await this.sleep(retryDelay(error, attempt, this.random, this.now));
      }
    }
  }
}

function withRefedDeadline<T>(
  operation: () => Promise<T>,
  milliseconds: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    // Unlike AbortSignal.timeout(), a normal Node timer is ref'ed. Keeping this
    // timer alive prevents Node's unsettled-top-level-await exit while an HTTP/2
    // stream has silently disappeared.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const error = Object.assign(
        new Error(`Gmail API request exceeded its ${milliseconds}ms deadline.`),
        { code: "ETIMEDOUT" },
      );
      reject(error);
    }, milliseconds);
    timer.ref();

    let pending: Promise<T>;
    try {
      pending = Promise.resolve(operation());
    } catch (error) {
      pending = Promise.reject(error);
    }
    // Both callbacks remain attached after the deadline wins. A late operation
    // rejection is therefore consumed instead of becoming unhandled.
    pending.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function headerNumber(value: string | string[] | number | undefined): number | undefined {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  if (typeof candidate === "string" && /^\d+$/u.test(candidate)) return Number(candidate);
  return undefined;
}

function responseTooLarge(maximumBodyBytes: number): Error {
  return Object.assign(
    new Error(`Gmail native data response exceeded ${maximumBodyBytes} bytes.`),
    { code: "ERR_GMAIL_RESPONSE_TOO_LARGE", status: 413 },
  );
}

function httpStatusError(
  status: number,
  headers: RawHttp2Headers,
  body: string,
): Error {
  let detail: string | undefined;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      const error = (parsed as Record<string, unknown>).error;
      if (typeof error === "object" && error !== null) {
        const message = (error as Record<string, unknown>).message;
        if (typeof message === "string" && message.length > 0) detail = message;
      }
    }
  } catch {
    // The HTTP status remains authoritative when an error body is not JSON.
  }
  return Object.assign(
    new Error(detail ?? `Gmail native data request failed with status ${status}.`),
    { status, response: { status, headers } },
  );
}

function normalizeMessage(value: unknown): GmailApiMessage {
  const data = asRecord(value, "Gmail message") as RawMessage;
  const id = requiredString(data.id, "Gmail message id");
  const labelIds = optionalStringArray(data.labelIds, "Gmail message labelIds") ?? [];
  const internalDate = optionalString(data.internalDate, "Gmail message internalDate");
  return {
    id,
    labelIds,
    ...(internalDate === undefined ? {} : { internalDate }),
    ...(data.payload === undefined
      ? {}
      : { payload: normalizePart(data.payload, "Gmail message payload") }),
  };
}

function normalizePart(value: unknown, description: string): GmailApiMessagePart {
  const data = asRecord(value, description) as RawMessagePart;
  const headers = data.headers === undefined
    ? []
    : requiredArray(data.headers, `${description} headers`).map((header, index) => {
        const record = asRecord(header, `${description} header ${index + 1}`);
        return {
          name: requiredString(record.name, `${description} header ${index + 1} name`),
          value: requiredText(record.value, `${description} header ${index + 1} value`),
        };
      });
  const parts = data.parts === undefined
    ? []
    : requiredArray(data.parts, `${description} parts`).map((part, index) =>
        normalizePart(part, `${description} part ${index + 1}`),
      );
  const body = data.body === undefined
    ? undefined
    : normalizeBody(data.body, `${description} body`);
  const partId = optionalText(data.partId, `${description} partId`);
  const mimeType = optionalText(data.mimeType, `${description} mimeType`);
  const filename = optionalText(data.filename, `${description} filename`);
  return {
    headers,
    parts,
    ...(partId === undefined ? {} : { partId }),
    ...(mimeType === undefined ? {} : { mimeType }),
    ...(filename === undefined ? {} : { filename }),
    ...(body === undefined ? {} : { body }),
  };
}

function normalizeBody(value: unknown, description: string): GmailApiMessagePart["body"] {
  const data = asRecord(value, description);
  const attachmentId = optionalString(data.attachmentId, `${description} attachmentId`);
  const size = optionalNonNegativeNumber(data.size, `${description} size`);
  const bodyData = optionalText(data.data, `${description} data`);
  return {
    ...(attachmentId === undefined ? {} : { attachmentId }),
    ...(size === undefined ? {} : { size }),
    ...(bodyData === undefined ? {} : { data: bodyData }),
  };
}

function asRecord(value: unknown, description: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw malformed(description);
  }
  return value as Record<string, unknown>;
}

function requiredArray(value: unknown, description: string): unknown[] {
  if (!Array.isArray(value)) throw malformed(description);
  return value;
}

function requiredString(value: unknown, description: string): string {
  if (typeof value !== "string" || value.length === 0) throw malformed(description);
  return value;
}

function requiredText(value: unknown, description: string): string {
  if (typeof value !== "string") throw malformed(description);
  return value;
}

function optionalString(value: unknown, description: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredString(value, description);
}

function optionalText(value: unknown, description: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredText(value, description);
}

function optionalStringArray(value: unknown, description: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredArray(value, description).map((item, index) =>
    requiredString(item, `${description} item ${index + 1}`),
  );
}

function optionalNonNegativeNumber(
  value: unknown,
  description: string,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw malformed(description);
  }
  return value;
}

function malformed(description: string): Error {
  return new Error(`${description} is malformed.`);
}

function isRetryable(error: unknown): boolean {
  const status = errorStatus(error);
  if (status === 401 || status === 403) return false;
  // HTTP/2 response decompression can fail after headers have supplied a 200
  // status. In that case the status alone looks successful, but these exact
  // zlib codes still identify a transient, truncated/corrupt transport body.
  if (isZlibTransportError(error)) return true;
  if (status !== undefined) return status === 429 || status >= 500;
  return error instanceof Error || typeof error === "object";
}

function isZlibTransportError(error: unknown): boolean {
  let current = error;
  const seen = new Set<object>();
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null || seen.has(current)) return false;
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (record.code === "Z_BUF_ERROR" || record.code === "Z_DATA_ERROR") return true;
    current = record.cause;
  }
  return false;
}

function errorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const record = error as Record<string, unknown>;
  const response = typeof record.response === "object" && record.response !== null
    ? record.response as Record<string, unknown>
    : undefined;
  const value = record.status ?? record.code ?? response?.status;
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d{3}$/u.test(value)) return Number(value);
  return undefined;
}

function retryDelay(
  error: unknown,
  retryIndex: number,
  random: () => number,
  now: () => number,
): number {
  const retryAfter = retryAfterMilliseconds(error, now());
  if (retryAfter !== undefined) return retryAfter;
  const jitterFraction = Math.min(1, Math.max(0, random()));
  return 1_000 * (2 ** retryIndex) + Math.floor(jitterFraction * 250);
}

function retryAfterMilliseconds(error: unknown, now: number): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const record = error as Record<string, unknown>;
  const response = typeof record.response === "object" && record.response !== null
    ? record.response as Record<string, unknown>
    : undefined;
  const headers = response?.headers ?? record.headers;
  const value = getHeader(headers, "retry-after");
  if (value === undefined) return undefined;
  if (/^\d+(?:\.\d+)?$/u.test(value.trim())) {
    return Math.max(0, Math.ceil(Number(value) * 1_000));
  }
  const retryAt = Date.parse(value);
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - now) : undefined;
}

function getHeader(headers: unknown, name: string): string | undefined {
  if (typeof headers !== "object" || headers === null) return undefined;
  const getter = (headers as { get?: unknown }).get;
  if (typeof getter === "function") {
    const value = getter.call(headers, name) as unknown;
    return typeof value === "string" ? value : undefined;
  }
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() === name && (typeof value === "string" || typeof value === "number")) {
      return String(value);
    }
  }
  return undefined;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class RequestLimiter {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("Gmail API request concurrency must be a positive integer.");
    }
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await operation();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      // Transfer the active permit directly so a newly arriving request cannot
      // overtake this FIFO waiter between promise microtasks.
      waiter();
    } else {
      this.active -= 1;
    }
  }
}
