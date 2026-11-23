import { describe, expect, it } from "vitest";

import { Buffer } from "../../src/authn/apple/buffer";
import { verifyChain } from "../../src/authn/apple/chain";
import { makeChain, makeP256 } from "./cert-fixture";

const POINT_HEADER = Buffer.from([0x03, 0x42, 0x00, 0x04]);
const INVALID_POINT_FORM = 0x05;

const withUnreadableKey = (der: Uint8Array): Buffer => {
  const damaged = Buffer.from(der);
  const at = damaged.indexOf(POINT_HEADER);
  if (at < 0) {
    throw new Error("certificate has no uncompressed P-256 key");
  }
  damaged[at + POINT_HEADER.length - 1] = INVALID_POINT_FORM;
  return damaged;
};

const pemToDer = (pem: string): Buffer =>
  Buffer.from(pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, ""), "base64");

describe("certificate chain", () => {
  const chain = makeChain({ leafKeyPem: makeP256().pem, leafExt: [], intermediateExt: [] });
  const { leafDer, intermediateDer, rootPem } = chain;

  it("accepts a genuine chain", () => {
    expect(verifyChain({ leafDer, intermediateDer, roots: [rootPem] })).not.toBeNull();
  });

  it("rejects an intermediate whose key cannot be read", () => {
    const damaged = withUnreadableKey(intermediateDer);
    expect(verifyChain({ leafDer, intermediateDer: damaged, roots: [rootPem] })).toBeNull();
  });

  it("rejects a root whose key cannot be read", () => {
    const damaged = withUnreadableKey(pemToDer(rootPem));
    expect(verifyChain({ leafDer, intermediateDer, roots: [damaged] })).toBeNull();
  });

  it("skips a root that is not a certificate and still finds the genuine one", () => {
    const roots = ["not a certificate", rootPem];
    expect(verifyChain({ leafDer, intermediateDer, roots })).not.toBeNull();
    expect(verifyChain({ leafDer, intermediateDer, roots: ["not a certificate"] })).toBeNull();
  });
});
