// The members of Node's built-in modules the Worker imports itself (federation/loader.ts resolveDeliveryHost), as
// workerd's nodejs_compat provides them and Fedify's validatePublicUrl uses them; the Worker's types leave Node's out.

declare module "node:dns/promises" {
  type LookupAddress = { address: string; family: number };
  const dns: { lookup(hostname: string, options: { all: true }): Promise<LookupAddress[]> };
  export default dns;
}

declare module "node:net" {
  export function isIP(input: string): number;
}
