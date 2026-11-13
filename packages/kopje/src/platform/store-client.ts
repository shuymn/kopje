import { toStoreUnavailable } from "./store-errors";

// The single Store object of an instance. Never rename: the name selects the data.
const STORE_OBJECT_NAME = "store";

export type StoreStub = ReturnType<Env["STORE"]["getByName"]>;

export type StoreResolver = (env: Env) => StoreStub;

export const defaultStore: StoreResolver = (env) => env.STORE.getByName(STORE_OBJECT_NAME);

// Calls the Store and turns maintenance and transient failures into StoreUnavailableError.
export async function callStore<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw toStoreUnavailable(error) ?? error;
  }
}

// A caller of env's Store through callStore, resolving the stub at each call.
export function storeRpc(store: StoreResolver, env: Env): <T>(call: (store: StoreStub) => Promise<T>) => Promise<T> {
  return (call) => callStore(() => call(store(env)));
}
