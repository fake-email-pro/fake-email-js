import type { RequestOptions } from "../types.js";

interface Page<T> {
  content: T[];
  page: number;
  totalPages: number;
}

/** Walks pages from 0 until the last one. New items arriving meanwhile shift pages (lists are newest first). */
export async function* paginate<T>(
  fetchPage: (page: number, size: number, options?: RequestOptions) => Promise<Page<T>>,
  size: number,
  options?: RequestOptions,
): AsyncGenerator<T, void, undefined> {
  for (let page = 0; ; page++) {
    const result = await fetchPage(page, size, options);
    yield* result.content;
    if (result.content.length === 0 || page + 1 >= result.totalPages) return;
  }
}
