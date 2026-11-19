import type { HttpClient } from "../core.js";
import type { Limits as LimitsData, RequestOptions } from "../types.js";

export class LimitsResource {
  constructor(private readonly http: HttpClient) {}

  /** Your quota, rate limit, concurrent waits, storage and mailbox lifetime. Does not spend quota. */
  get(options?: RequestOptions): Promise<LimitsData> {
    return this.http.json<LimitsData>({ ...options, method: "GET", path: "/v1/limits" });
  }
}
