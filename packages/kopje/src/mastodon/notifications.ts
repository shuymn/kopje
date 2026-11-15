import { fallbackTypes } from "../domain/notification-fallback";
import { type ApiHandler, authorized, present, storeCall, userCredential, withParams } from "./context";
import { recordNotFound } from "./errors";
import { pageQuery, pageResponse } from "./pagination";
import { type Params, parseBoolean } from "./params";

// /api/v1/notifications: the list with types[], exclude_types[], account_id, include_filtered and supported_types,
// one notification with supported_types, dismiss and clear.

// supported_types, as Mastodon reads it raw (params[:supported_types]): supported_types[] as an array, else a scalar.
export const supportedTypes = (p: Params) => fallbackTypes(p.list("supported_types") ?? p.get("supported_types"));

export const listNotifications: ApiHandler = withParams(async (c, deps, p) => {
  const page = pageQuery(p);
  const accountId = p.get("account_id");
  const credential = userCredential(c, deps);
  const result = authorized(
    await storeCall(c, deps, (s, b) =>
      s.listNotifications(b, {
        credential,
        page,
        types: p.list("types") ?? [],
        excludeTypes: p.list("exclude_types") ?? [],
        accountId: accountId === undefined || accountId === "" ? null : accountId,
        includeFiltered: parseBoolean(p.get("include_filtered")) === true,
        fallbackTypes: supportedTypes(p),
        present: present(c),
      }),
    ),
  );
  return pageResponse(c, result, page.limit);
});

export const getNotification: ApiHandler = withParams(async (c, deps, p) => {
  const id = c.req.param("id") ?? "";
  const credential = userCredential(c, deps);
  const input = { credential, id, fallbackTypes: supportedTypes(p), present: present(c) };
  const notification = authorized(await storeCall(c, deps, (s, b) => s.getNotification(b, input)));
  return notification === null ? recordNotFound() : c.json(notification);
});

export const dismissNotification: ApiHandler = async (c, deps) => {
  const id = c.req.param("id") ?? "";
  const credential = userCredential(c, deps);
  const dismissed = authorized(await storeCall(c, deps, (s, b) => s.dismissNotification(b, { credential, id })));
  return dismissed ? c.json({}) : recordNotFound();
};

export const clearNotifications: ApiHandler = async (c, deps) => {
  const credential = userCredential(c, deps);
  authorized(await storeCall(c, deps, (s, b) => s.clearNotifications(b, { credential })));
  return c.json({});
};
