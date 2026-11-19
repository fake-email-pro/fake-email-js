import type { HttpClient } from "../core.js";
import type { Domain, RequestOptions } from "../types.js";
import type { components } from "../generated/public.js";

export class DomainsResource {
  constructor(private readonly http: HttpClient) {}

  /** Domains you can create a mailbox on, sorted by name. */
  async list(options?: RequestOptions): Promise<Domain[]> {
    const res = await this.http.json<components["schemas"]["Domains"]>({ ...options, method: "GET", path: "/v1/domains" });
    return res.domains;
  }
}
