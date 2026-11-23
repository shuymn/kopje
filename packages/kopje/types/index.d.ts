// The package's public entry: the Worker's handlers and the Durable Object classes, the Store and the media processor.
// An instance re-exports them from its own entry module (`export { default, MediaProcessor, Store } from 'kopje'`);
// nothing else in the package is public API.
// The parameters are left opaque on purpose: the runtime passes them, and an instance never calls these itself.

export interface KopjeWorker {
  fetch(request: Request, env: unknown, ctx: unknown): Response | Promise<Response>;
  queue(batch: unknown, env: unknown): Promise<void>;
  scheduled(controller: unknown, env: unknown, ctx: unknown): void;
}

declare const worker: KopjeWorker;
export default worker;

// The SQLite-backed Durable Object that holds the instance. Bind it as STORE with a `new_sqlite_classes` migration.
// oxlint-disable-next-line typescript/no-extraneous-class -- the class is the binding; its members are the runtime's
export declare class Store {
  constructor(ctx: unknown, env: unknown);
}

// The media processor's Container Durable Object. Unbound, it is never instantiated; the instance template's optional
// block binds it as MEDIA_PROCESSOR with a `new_sqlite_classes` migration and builds its image from container/.
// oxlint-disable-next-line typescript/no-extraneous-class -- the class is the binding; its members are the runtime's
export declare class MediaProcessor {
  constructor(ctx: unknown, env: unknown);
}
