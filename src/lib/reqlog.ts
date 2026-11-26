// Request log without query strings. Queries can carry unlisted service codes (?serviceCode=,
// ServiceCodes=) and other things that shouldn't sit in the journal, so only the method, path,
// status and time are written. (Replaces hono/logger, which logs the full URL.)
import type { MiddlewareHandler } from "hono";

export function requestLogger(print: (line: string) => void = console.log): MiddlewareHandler {
  return async (c, next) => {
    const start = Date.now();
    const path = new URL(c.req.url).pathname;
    await next();
    print(`${c.req.method} ${path} ${c.res.status} ${Date.now() - start}ms`);
  };
}
