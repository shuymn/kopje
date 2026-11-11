// WEB-6: once setup has fixed the domain, Kopje answers only on it, as Mastodon's `config.hosts` does
// (config/initializers/1_hosts.rb). The host is the request URL's, which the platform routes by; no header is read.
// app/app.ts reads the domain for a request in one early middleware, unless a handler the request matched reads it
// itself and applies offDomain with it (decidesHost): those routes keep their one Store read.

// A redirect to the same path and query on the instance domain for GET and HEAD, 421 Misdirected Request (RFC 9110
// §15.5.20) for any other method, or null on the domain itself. 301 rather than 308: only safe methods are redirected,
// so the method is kept either way, and every client follows 301. Not stored by caches, so a domain an operator
// changes later (/admin/config, a restored dump) is not shadowed by an earlier redirect.
export function offDomain(request: { url: string; method: string }, domain: string): Response | null {
  const url = new URL(request.url);
  if (url.host === domain) {
    return null;
  }
  if (request.method === "GET" || request.method === "HEAD") {
    const target = new URL(url);
    target.protocol = "https:";
    target.username = "";
    target.password = "";
    target.host = domain;
    target.port = "";
    return new Response(null, { status: 301, headers: { location: target.href, "cache-control": "no-store" } });
  }
  return misdirected();
}

export function misdirected(): Response {
  return new Response("Misdirected Request", {
    status: 421,
    headers: { "content-type": "text/plain;charset=UTF-8", "cache-control": "no-store" },
  });
}

// The handlers that decide the host themselves: each reads the domain in the request's own Store read and answers
// offDomain's response, or answers on any host by design (media, which reads no Store). Kept by identity, as Hono's
// matchedRoutes hands them back.
const DECIDES_HOST = new WeakSet<object>();

export function decidesHost<H extends object>(handler: H): H {
  DECIDES_HOST.add(handler);
  return handler;
}

export function hostDecided(routes: readonly { handler: unknown }[]): boolean {
  return routes.some((route) => typeof route.handler === "function" && DECIDES_HOST.has(route.handler));
}
