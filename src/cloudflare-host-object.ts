/**
 * Read a member from a Cloudflare host object without leaking a Proxy as `this`.
 *
 * Durable Object namespace/stub methods are Web-API host functions and may
 * brand-check their receiver. A transparent Proxy therefore must read getters
 * with the original object as receiver and bind callable members back to that
 * original object.
 */
export function cloudflareHostObjectMember(
  target: object,
  property: PropertyKey,
): unknown {
  const value = Reflect.get(target, property, target);
  return typeof value === "function" ? value.bind(target) : value;
}
