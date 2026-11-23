import { X509Certificate } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { ChainInput } from "../../src/authn/apple/chain";
import { verifyChain } from "../../src/authn/apple/chain";
import { makeChain, makeP256, withUndecodableKey } from "./cert-fixture";

const genuine = makeChain({
  leafKeyPem: makeP256().pem,
  leafExt: ["basicConstraints=CA:FALSE"],
  intermediateExt: ["basicConstraints=critical,CA:TRUE"],
});
const rootDer = new X509Certificate(genuine.rootPem).raw;

const check = (overrides: Partial<ChainInput> = {}): ReturnType<typeof verifyChain> =>
  verifyChain({
    leafDer: genuine.leafDer,
    intermediateDer: genuine.intermediateDer,
    roots: [genuine.rootPem],
    ...overrides,
  });

describe("certificate chain", () => {
  it("a genuine chain verifies against its root in any accepted form", () => {
    expect(check()?.root.subject).toBe(new X509Certificate(genuine.rootPem).subject);
    expect(check({ roots: [rootDer] })).not.toBeNull();
    expect(check({ roots: [new X509Certificate(genuine.rootPem)] })).not.toBeNull();
  });

  it("the corrupted certificates still parse, so the key is what fails", () => {
    const intermediate = new X509Certificate(withUndecodableKey(genuine.intermediateDer));
    expect(() => intermediate.publicKey).toThrow();
    expect(() => new X509Certificate(withUndecodableKey(rootDer)).publicKey).toThrow();
  });

  it("an intermediate whose key cannot be decoded does not hold", () => {
    expect(check({ intermediateDer: withUndecodableKey(genuine.intermediateDer) })).toBeNull();
  });

  it("a leaf whose key cannot be decoded does not hold", () => {
    expect(check({ leafDer: withUndecodableKey(genuine.leafDer) })).toBeNull();
  });

  it("a root whose key cannot be decoded, or that is not a certificate, issues nothing", () => {
    expect(check({ roots: [withUndecodableKey(rootDer)] })).toBeNull();
    expect(check({ roots: ["not a certificate"] })).toBeNull();
    expect(check({ roots: [new Uint8Array([0x30, 0x03, 0x02, 0x01])] })).toBeNull();
  });

  it("an unusable root does not hide the genuine one beside it", () => {
    const roots = ["not a certificate", withUndecodableKey(rootDer), genuine.rootPem];
    expect(check({ roots })).not.toBeNull();
  });

  it("certificates that are not certificates do not hold", () => {
    expect(check({ leafDer: genuine.leafDer.subarray(0, 40) })).toBeNull();
    expect(check({ intermediateDer: "" })).toBeNull();
  });
});
