import { seg, type HttpClient } from "../core.js";
import type {
  CreateMailboxParams,
  ListAllParams,
  Mailbox,
  MailboxPage,
  PageParams,
  RequestOptions,
} from "../types.js";
import { paginate } from "./pagination.js";

export class MailboxesResource {
  constructor(private readonly http: HttpClient) {}

  /** Creates a mailbox (spends one unit of the monthly quota). No params: a random address on a random domain. */
  create(params: CreateMailboxParams = {}, options?: RequestOptions): Promise<Mailbox> {
    const body: Record<string, string> = {};
    if (params.localPart !== undefined) body.localPart = params.localPart;
    if (params.domain !== undefined) body.domain = params.domain;
    return this.http.json<Mailbox>({ ...options, method: "POST", path: "/v1/mailboxes", body });
  }

  /** One page of active mailboxes, newest first. */
  list(params: PageParams = {}, options?: RequestOptions): Promise<MailboxPage> {
    return this.http.json<MailboxPage>({
      ...options,
      method: "GET",
      path: "/v1/mailboxes",
      query: { page: params.page, size: params.size },
    });
  }

  /** Every active mailbox, fetching pages as needed. */
  listAll(params: ListAllParams = {}, options?: RequestOptions): AsyncGenerator<Mailbox, void, undefined> {
    return paginate((page, size, o) => this.list({ page, size }, o), params.size ?? 50, options);
  }

  get(address: string, options?: RequestOptions): Promise<Mailbox> {
    return this.http.json<Mailbox>({ ...options, method: "GET", path: `/v1/mailboxes/${seg(address)}` });
  }

  /**
   * Deletes the mailbox and its messages. The address is never issued again; the quota is not given back.
   * A retry that finds the mailbox gone (the lost first attempt deleted it) counts as success; a `404` on the
   * first attempt is still a `NotFoundError`.
   */
  async delete(address: string, options?: RequestOptions): Promise<void> {
    await this.http.send({ ...options, method: "DELETE", path: `/v1/mailboxes/${seg(address)}` });
  }
}
