import assert from "node:assert/strict";
import test from "node:test";
import { cloudflareHostObjectMember } from "../dist-ts/src/cloudflare-host-object.js";

test("Cloudflare host-object passthrough preserves the original receiver", () => {
  const host = {
    value: 41,
    method() {
      assert.equal(this, host);
      return this.value + 1;
    },
    get checkedValue() {
      assert.equal(this, host);
      return this.value;
    },
  };

  const proxy = new Proxy(host, {
    get(target, property) {
      return cloudflareHostObjectMember(target, property);
    },
  });

  assert.equal(proxy.checkedValue, 41);
  assert.equal(proxy.method(), 42);
});

test("unbound Proxy passthrough reproduces the receiver failure this helper prevents", () => {
  const host = {
    method() {
      if (this !== host) throw new TypeError("Illegal invocation");
      return "ok";
    },
  };
  const unsafe = new Proxy(host, {
    get(target, property, receiver) {
      return Reflect.get(target, property, receiver);
    },
  });

  assert.throws(() => unsafe.method(), /Illegal invocation/);
  const safe = new Proxy(host, {
    get(target, property) {
      return cloudflareHostObjectMember(target, property);
    },
  });
  assert.equal(safe.method(), "ok");
});
