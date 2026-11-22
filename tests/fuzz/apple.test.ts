import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { CborValue } from "../../src/authn/apple";
import {
  AppleFormatError,
  decodeBase64,
  decodeCbor,
  encodeCbor,
  verifyAppTransaction,
  verifyAssertion,
  verifyAttestation,
  verifyTransaction,
} from "../../src/authn/apple";
import { extensionValue, octetStringInsideSequence, readDer } from "../../src/authn/apple/asn1";
import { Buffer } from "../../src/authn/apple/buffer";
import { createFakeDevice, createFakeStore } from "../apple/device-fixture";

const TEAM = "ABCDE12345";
const BUNDLE = "com.example.app";
const ENVIRONMENTS = ["Production", "Sandbox"];
const PRODUCTS = ["example.plan.monthly"];

const formatOnly = <T>(work: () => T): T | "format" => {
  try {
    return work();
  } catch (error) {
    if (error instanceof AppleFormatError) {
      return "format";
    }
    throw error;
  }
};

const cborValues: fc.Arbitrary<CborValue> = fc.letrec<{ value: CborValue }>((tie) => ({
  value: fc.oneof(
    { maxDepth: 4, depthSize: "small" },
    fc.integer({ min: -(2 ** 32), max: 2 ** 32 - 1 }),
    fc.string(),
    fc.uint8Array({ maxLength: 40 }),
    fc.array(tie("value"), { maxLength: 4 }),
    fc
      .array(fc.tuple(fc.string(), tie("value")), { maxLength: 4 })
      .map((entries): CborValue => new Map<CborValue, CborValue>(entries)),
  ),
})).value;

const bytes = fc.uint8Array({ maxLength: 200 });

const mutations = fc.oneof(
  fc.record({
    kind: fc.constant("flip" as const),
    at: fc.double({ min: 0, max: 1, noNaN: true, maxExcluded: true }),
    mask: fc.integer({ min: 1, max: 255 }),
  }),
  fc.record({
    kind: fc.constant("cut" as const),
    at: fc.double({ min: 0, max: 1, noNaN: true, maxExcluded: true }),
  }),
  fc.record({
    kind: fc.constant("grow" as const),
    tail: fc.uint8Array({ minLength: 1, maxLength: 8 }),
  }),
);
type Mutation = typeof mutations extends fc.Arbitrary<infer M> ? M : never;

const mutate = (original: Uint8Array, mutation: Mutation): Buffer => {
  const copy = Buffer.from(original);
  if (mutation.kind === "grow") {
    return Buffer.concat([copy, mutation.tail]);
  }
  const at = Math.floor(mutation.at * copy.length);
  if (mutation.kind === "cut") {
    return copy.subarray(0, at);
  }
  copy.writeUInt8(copy.readUInt8(at) ^ mutation.mask, at);
  return copy;
};

describe("cbor decoder under hostile bytes", () => {
  it("answers any bytes with a value or its own format error", () => {
    fc.assert(
      fc.property(bytes, (input) => {
        formatOnly(() => decodeCbor(input));
      }),
      { numRuns: 5000 },
    );
  });

  it("answers any damaged encoding with a value or its own format error", () => {
    fc.assert(
      fc.property(cborValues, mutations, (value, mutation) => {
        formatOnly(() => decodeCbor(mutate(encodeCbor(value), mutation)));
      }),
      { numRuns: 3000 },
    );
  });

  it("reads back what it wrote", () => {
    fc.assert(
      fc.property(cborValues, (value) => {
        const encoded = encodeCbor(value);
        expect(encodeCbor(decodeCbor(encoded)).equals(encoded)).toBe(true);
      }),
      { numRuns: 2000 },
    );
  });

  it("refuses nesting deeper than an attestation ever needs instead of exhausting the stack", () => {
    for (const opener of [0x81, 0xa1]) {
      const nested = Buffer.alloc(12_000, opener);
      expect(formatOnly(() => decodeCbor(nested))).toBe("format");
    }
  });
});

it("reads sixteen levels of nesting and refuses the seventeenth", () => {
  const nestedTo = (levels: number): Buffer =>
    Buffer.concat([Buffer.alloc(levels, 0x81), Buffer.from([0x00])]);
  expect(formatOnly(() => decodeCbor(nestedTo(16)))).not.toBe("format");
  expect(formatOnly(() => decodeCbor(nestedTo(17)))).toBe("format");
});

describe("der reader under hostile bytes", () => {
  it("never reads outside the buffer", () => {
    fc.assert(
      fc.property(bytes, fc.integer({ min: 0, max: 220 }), (input, offset) => {
        const buffer = Buffer.from(input);
        const element = formatOnly(() => readDer(buffer, offset));
        if (element !== "format") {
          expect(element.offset).toBeLessThanOrEqual(buffer.length);
          expect(element.value.length).toBeLessThanOrEqual(buffer.length - offset);
        }
      }),
      { numRuns: 5000 },
    );
  });

  it("answers any bytes with a value, nothing, or its own format error", () => {
    const oid = fc.uint8Array({ minLength: 1, maxLength: 4 });
    fc.assert(
      fc.property(bytes, oid, (input, needle) => {
        formatOnly(() => extensionValue(Buffer.concat([input, needle, input]), needle));
        formatOnly(() => octetStringInsideSequence(Buffer.from(input)));
      }),
      { numRuns: 5000 },
    );
  });

  it("decodes base64 to bytes within its size cap or to nothing", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.anything(), fc.string({ unit: "binary", maxLength: 40 })),
        (input) => {
          const decoded = decodeBase64(input);
          expect(decoded === null || (decoded.length > 0 && decoded.length <= 16_384)).toBe(true);
        },
      ),
      { numRuns: 3000 },
    );
  });
});

describe("attestation and assertion under hostile bytes", () => {
  const device = createFakeDevice({ teamId: TEAM, bundleId: BUNDLE });
  const challenge = Buffer.from("fuzz-challenge");
  const attestation = Buffer.from(device.attest(challenge), "base64");
  const common = { teamId: TEAM, bundleId: BUNDLE };
  const attest = (candidate: Uint8Array): ReturnType<typeof verifyAttestation> =>
    verifyAttestation({
      ...common,
      attestation: candidate,
      challenge,
      keyId: Buffer.from(device.keyId, "base64"),
      roots: [device.rootPem],
    });
  const genuine = attest(attestation);
  if (!genuine.ok) {
    throw new Error("the fixture attestation must verify");
  }
  const clientData = Buffer.from("fuzz request");
  const assertion = Buffer.from(device.assert(clientData), "base64");
  const assertWith = (candidate: Uint8Array): ReturnType<typeof verifyAssertion> =>
    verifyAssertion({
      ...common,
      assertion: candidate,
      publicKey: genuine.publicKey,
      clientData,
      counter: 0,
    });

  it("never attests a different key, whatever is done to a genuine attestation", () => {
    fc.assert(
      fc.property(mutations, (mutation) => {
        const result = attest(mutate(attestation, mutation));
        expect(result.ok ? result.publicKey : genuine.publicKey).toEqual(genuine.publicKey);
      }),
      { numRuns: 400 },
    );
  });

  it("rejects bytes that were never an attestation or an assertion", () => {
    fc.assert(
      fc.property(fc.oneof(bytes, cborValues.map(encodeCbor)), (input) => {
        expect(attest(input).ok).toBe(false);
        expect(assertWith(input).ok).toBe(false);
      }),
      { numRuns: 2000 },
    );
  });

  it("accepts a genuine assertion and no damaged one", () => {
    expect(assertWith(assertion)).toEqual({ ok: true, counter: 1 });
    fc.assert(
      fc.property(mutations, (mutation) => {
        expect(assertWith(mutate(assertion, mutation)).ok).toBe(false);
      }),
      { numRuns: 1000 },
    );
  });
});

describe("store transactions under hostile text", () => {
  const store = createFakeStore({ bundleId: BUNDLE });
  const jws = store.transaction();
  const appJws = store.appTransaction();
  const verify = (candidate: unknown): ReturnType<typeof verifyTransaction> =>
    verifyTransaction({
      jws: candidate,
      bundleId: BUNDLE,
      environments: ENVIRONMENTS,
      productIds: PRODUCTS,
      roots: [store.rootPem],
    });
  const verifyApp = (candidate: unknown): ReturnType<typeof verifyAppTransaction> =>
    verifyAppTransaction({
      jws: candidate,
      bundleId: BUNDLE,
      environments: ENVIRONMENTS,
      roots: [store.rootPem],
    });
  const genuine = verify(jws);
  const genuineApp = verifyApp(appJws);
  const edits = fc.record({
    at: fc.double({ min: 0, max: 1, noNaN: true, maxExcluded: true }),
    text: fc.string({ unit: "binary", maxLength: 3 }),
    drop: fc.integer({ min: 0, max: 3 }),
  });
  const edit = (text: string, change: { at: number; text: string; drop: number }): string => {
    const at = Math.floor(change.at * text.length);
    return text.slice(0, at) + change.text + text.slice(at + change.drop);
  };

  it("verifies the genuine fixtures", () => {
    expect(genuine.ok).toBe(true);
    expect(genuineApp.ok).toBe(true);
  });

  it("never reads a different purchase out of an edited transaction", () => {
    fc.assert(
      fc.property(edits, (change) => {
        const result = verify(edit(jws, change));
        expect(result.ok ? result : genuine).toEqual(genuine);
        const appResult = verifyApp(edit(appJws, change));
        expect(appResult.ok ? appResult : genuineApp).toEqual(genuineApp);
      }),
      { numRuns: 400 },
    );
  });

  it("rejects anything that was never a transaction", () => {
    const parts = fc.array(fc.base64String({ maxLength: 60 }), { minLength: 3, maxLength: 3 });
    const padded = parts.map((three) => three.join(".").padEnd(120, "A"));
    fc.assert(
      fc.property(fc.oneof(fc.anything(), fc.string({ maxLength: 300 }), padded), (input) => {
        expect(verify(input).ok).toBe(false);
        expect(verifyApp(input).ok).toBe(false);
      }),
      { numRuns: 2000 },
    );
  });
});
