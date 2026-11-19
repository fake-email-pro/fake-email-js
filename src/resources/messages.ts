import { seg, type CallOptions, type HttpClient } from "../core.js";
import type {
  DetailedMessage,
  DownloadedAttachment,
  ListAllParams,
  MessagePage,
  PageParams,
  RequestOptions,
  SimpleMessage,
  WaitParams,
} from "../types.js";
import { paginate } from "./pagination.js";

const DEFAULT_SERVER_WAIT_S = 30;
// The HTTP attempt must outlive the server's hold, or a healthy long poll would be cut off as a timeout.
const WAIT_HTTP_MARGIN_MS = 10_000;

export class MessagesResource {
  constructor(private readonly http: HttpClient) {}

  /** One page of the mailbox's messages, newest first. To watch for new mail use `wait`, not polling. */
  list(address: string, params: PageParams = {}, options?: RequestOptions): Promise<MessagePage> {
    return this.http.json<MessagePage>({
      ...options,
      method: "GET",
      path: `${base(address)}/messages`,
      query: { page: params.page, size: params.size },
    });
  }

  /** Every message of the mailbox, newest first, fetching pages as needed. */
  listAll(
    address: string,
    params: ListAllParams = {},
    options?: RequestOptions,
  ): AsyncGenerator<SimpleMessage, void, undefined> {
    return paginate((page, size, o) => this.list(address, { page, size }, o), params.size ?? 50, options);
  }

  /**
   * One long poll: the earliest matching message (strictly after `after`), or `null` when the server's
   * `timeout` passed without one. For a loop with a client-side deadline, use `client.waitForMessage`.
   */
  wait(address: string, params: WaitParams = {}, options?: RequestOptions): Promise<SimpleMessage | null> {
    return waitOnce(this.http, address, params, options ?? {});
  }

  /** The full message: bodies, attachments, every code and link. */
  get(address: string, id: string, options?: RequestOptions): Promise<DetailedMessage> {
    return this.http.json<DetailedMessage>({ ...options, method: "GET", path: `${base(address)}/messages/${seg(id)}` });
  }

  async delete(address: string, id: string, options?: RequestOptions): Promise<void> {
    await this.http.send({ ...options, method: "DELETE", path: `${base(address)}/messages/${seg(id)}` });
  }

  /** The raw EML, byte for byte. */
  async raw(address: string, id: string, options?: RequestOptions): Promise<Uint8Array> {
    const { response } = await this.http.send({
      ...options,
      method: "GET",
      path: `${base(address)}/messages/${seg(id)}/raw`,
    });
    return new Uint8Array(await response.arrayBuffer());
  }

  /** The decoded bytes of an attachment, with its type and file name. */
  async attachment(
    address: string,
    id: string,
    attachmentId: string,
    options?: RequestOptions,
  ): Promise<DownloadedAttachment> {
    const { response, headers } = await this.http.send({
      ...options,
      method: "GET",
      path: `${base(address)}/messages/${seg(id)}/attachments/${seg(attachmentId)}`,
    });
    return {
      data: new Uint8Array(await response.arrayBuffer()),
      contentType: headers.get("content-type") ?? "application/octet-stream",
      fileName: parseContentDispositionFileName(headers.get("content-disposition")),
    };
  }
}

export function waitOnce(
  http: HttpClient,
  address: string,
  params: WaitParams,
  options: RequestOptions & Pick<CallOptions, "deadline">,
): Promise<SimpleMessage | null> {
  const serverTimeoutS = params.timeout ?? DEFAULT_SERVER_WAIT_S;
  return http.jsonOrNull<SimpleMessage>({
    ...options,
    timeoutMs: options.timeoutMs ?? serverTimeoutS * 1000 + WAIT_HTTP_MARGIN_MS,
    method: "GET",
    path: `${base(address)}/messages/wait`,
    query: {
      timeout: params.timeout,
      after: params.after instanceof Date ? params.after.toISOString() : params.after,
      from: params.from,
      subject: params.subject,
    },
  });
}

function base(address: string): string {
  return `/v1/mailboxes/${seg(address)}`;
}

/** `filename*` (RFC 5987/6266) wins over `filename`; `null` when neither is present. */
export function parseContentDispositionFileName(header: string | null): string | null {
  if (!header) return null;
  const params = splitParams(header);
  const extended = params.get("filename*");
  if (extended !== undefined) {
    const m = /^([\w!#$%&+^`{}~-]*)'[\w-]*'(.*)$/.exec(extended);
    if (m) {
      const charset = (m[1] ?? "").toLowerCase();
      const decoded = decodeExtValue(m[2] ?? "", charset);
      if (decoded !== null) return decoded;
    }
  }
  const plain = params.get("filename");
  return plain === undefined || plain === "" ? null : plain;
}

function splitParams(header: string): Map<string, string> {
  const params = new Map<string, string>();
  // name=token | name="quoted \" string"; the leading disposition type has no "=" and is skipped.
  const re = /;\s*([^\s=;]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))/g;
  for (let m = re.exec(header); m !== null; m = re.exec(header)) {
    const name = (m[1] ?? "").toLowerCase();
    const value = m[2] !== undefined ? m[2].replace(/\\(.)/g, "$1") : (m[3] ?? "").trim();
    if (!params.has(name)) params.set(name, value);
  }
  return params;
}

function decodeExtValue(value: string, charset: string): string | null {
  try {
    if (charset === "utf-8" || charset === "") return decodeURIComponent(value);
    if (charset === "iso-8859-1") {
      return value.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    }
  } catch {
    // Malformed percent-encoding: fall back to the plain filename.
  }
  return null;
}
