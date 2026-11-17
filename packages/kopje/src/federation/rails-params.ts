import {
  bytewise,
  pairs,
  ParamHash,
  percentBytes,
  RACK,
  RAILS,
  type RailsParam,
  Refused,
  store,
  text,
} from "../platform/rails-params";

// The format parameter Mastodon 4.7.5 reads at a route with Rails' `(.:format)` (parameters[:format]), and where it
// refuses the request (400) before reading it: while the request is read, before any controller, or in the controller.
// Two parsers read the query (platform/rails-params.ts), in this order:
//   - Rack's, in a middleware (Rack::Attack's throttle_authenticated_paging reads every request's params), on the
//     key's bytes: its refusals are 400, a nesting 32 deep, more than 4,096 fields or more than 4 MiB (QueryLimitError)
//     an unmapped 500 there, and 400 here;
//   - Rails', in the controller, after ParamsWrapper reads the Content-Type (rails-format.ts railsContentTypeRefused)
//     and before it reads the format.
// The route's extension (the path parameter `format`, CGI.unescapeURIComponent'd, 400 in the router when not UTF-8) is
// merged last (Request#parameters), so it wins over the query's.

// Where Mastodon refuses a request's query or extension (400, or the 500 of a Rack limit): "request" while it reads the
// request, before any controller (Rack's parser, the router); "controller" when the controller reads its parameters.
type Refusal = "request" | "controller";

function refused<By extends Refusal>(error: unknown, by: By): { refused: By } {
  if (error instanceof Refused) {
    return { refused: by };
  }
  throw error;
}

// The format parameter of a request whose route extension is `extension` (undefined without one, as the path holds
// it) and whose query is `query` (without its `?`): `format` undefined when neither sets it (or the query's is nil);
// refused where Mastodon refuses it before reading it.
export function railsFormatParam(
  extension: string | undefined,
  query: string,
): { refused: "request" } | { refused: "controller" } | { refused: false; format: RailsParam | undefined } {
  let decoded: ReturnType<typeof pairs>;
  let pathFormat: string | undefined;
  try {
    decoded = pairs(query);
    const rack = new ParamHash();
    for (const { key, value } of decoded) {
      store(RACK, rack, bytewise(key), value === null ? null : "", 0);
    }
    pathFormat = extension?.includes("%") ? text(percentBytes(extension, false)) : extension;
    if (extension !== undefined && pathFormat === undefined) {
      throw new Refused();
    }
  } catch (error) {
    return refused(error, "request");
  }
  try {
    const rails = new ParamHash();
    for (const { key, value } of decoded) {
      const name = text(key);
      if (name === undefined) {
        throw new Refused();
      }
      const start = name.indexOf("[", 1);
      const top = start === -1 ? name : name.slice(0, start);
      const v = value === null ? null : text(value);
      if (v === undefined && top !== "") {
        throw new Refused();
      }
      store(RAILS, rails, name, v === undefined ? "" : v, 0);
    }
    return { refused: false, format: pathFormat ?? rails.get("format") };
  } catch (error) {
    return refused(error, "controller");
  }
}
