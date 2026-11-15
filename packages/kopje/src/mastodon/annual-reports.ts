import { requestedId } from "../domain/ids";
import { type ApiContext, type ApiHandler, authorized, present, storeCall, userCredential } from "./context";
import { recordNotFound } from "./errors";

// Annual reports (Mastodon 4.7.5's Api::V1::AnnualReportsController); the Store does the work
// (domain/annual-reports.ts). The year is the path's id as Ruby's to_i reads it (params[:id]&.to_i); one that names
// no report (not 1 to 9999) is a year without one.

function yearOf(c: ApiContext): string {
  return requestedId(c.req.param("id") ?? "");
}

// GET /api/v1/annual_reports: the pending reports (REST::AnnualReportsSerializer).
export const index: ApiHandler = async (c, deps) => {
  const input = { credential: userCredential(c, deps), present: present(c) };
  return c.json(authorized(await storeCall(c, deps, (s, b) => s.annualReports(b, input))));
};

// GET /api/v1/annual_reports/:id: set_annual_report's find_by! answers Record not found for a year without one.
export const show: ApiHandler = async (c, deps) => {
  const input = { credential: userCredential(c, deps), year: yearOf(c), present: present(c) };
  const reports = authorized(await storeCall(c, deps, (s, b) => s.annualReport(b, input)));
  return reports === null ? recordNotFound() : c.json(reports);
};

// GET /api/v1/annual_reports/:id/state.
export const state: ApiHandler = async (c, deps) => {
  const input = { credential: userCredential(c, deps), year: yearOf(c) };
  return c.json({ state: authorized(await storeCall(c, deps, (s, b) => s.annualReportState(b, input))) });
};

// POST /api/v1/annual_reports/:id/generate: 200 {} (render_empty), the report made within the request when it is
// made at all; no 202 and no Mastodon-Async-Refresh (docs/mastodon-deviations.md, "Annual reports").
export const generate: ApiHandler = async (c, deps) => {
  const input = { credential: userCredential(c, deps), year: yearOf(c) };
  authorized(await storeCall(c, deps, (s, b) => s.generateAnnualReport(b, input)));
  return c.json({});
};

// POST /api/v1/annual_reports/:id/read: GeneratedAnnualReport#view!, then {}.
export const read: ApiHandler = async (c, deps) => {
  const input = { credential: userCredential(c, deps), year: yearOf(c) };
  const marked = authorized(await storeCall(c, deps, (s, b) => s.markAnnualReportRead(b, input)));
  return marked ? c.json({}) : recordNotFound();
};
