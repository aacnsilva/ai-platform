import { describe, expect, it } from "vitest";

import { Buffer } from "../../src/authn/apple/buffer";
import { verifyChain } from "../../src/authn/apple/chain";
import { makeChain, makeP256, withUndecodableKey } from "./cert-fixture";

const pemToDer = (pem: string): Buffer =>
  Buffer.from(pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, ""), "base64");

describe("certificate chain", () => {
  const chain = makeChain({ leafKeyPem: makeP256().pem, leafExt: [], intermediateExt: [] });
  const { leafDer, intermediateDer, rootPem } = chain;

  it("accepts a genuine chain", () => {
    expect(verifyChain({ leafDer, intermediateDer, roots: [rootPem] })).not.toBeNull();
  });

  it("rejects an intermediate whose key cannot be read", () => {
    const damaged = withUndecodableKey(intermediateDer);
    expect(verifyChain({ leafDer, intermediateDer: damaged, roots: [rootPem] })).toBeNull();
  });

  it("rejects a root whose key cannot be read", () => {
    const damaged = withUndecodableKey(pemToDer(rootPem));
    expect(verifyChain({ leafDer, intermediateDer, roots: [damaged] })).toBeNull();
  });

  it("skips a root that is not a certificate and still finds the genuine one", () => {
    const roots = ["not a certificate", rootPem];
    expect(verifyChain({ leafDer, intermediateDer, roots })).not.toBeNull();
    expect(verifyChain({ leafDer, intermediateDer, roots: ["not a certificate"] })).toBeNull();
  });

  it("accepts the root as bytes as well as text", () => {
    expect(verifyChain({ leafDer, intermediateDer, roots: [pemToDer(rootPem)] })).not.toBeNull();
  });

  it("rejects a leaf whose key cannot be read", () => {
    const damaged = withUndecodableKey(leafDer);
    expect(verifyChain({ leafDer: damaged, intermediateDer, roots: [rootPem] })).toBeNull();
  });

  it("rejects a leaf or intermediate that is not a certificate", () => {
    const cut = leafDer.subarray(0, 40);
    expect(verifyChain({ leafDer: cut, intermediateDer, roots: [rootPem] })).toBeNull();
    expect(verifyChain({ leafDer, intermediateDer: "", roots: [rootPem] })).toBeNull();
  });
});
