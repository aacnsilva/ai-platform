export type AppleFormatErrorCode =
  | "der_truncated"
  | "der_length"
  | "cbor_truncated"
  | "cbor_depth"
  | "cbor_unsupported"
  | "cbor_trailing"
  | "cbor_int"
  | "cbor_key";

export class AppleFormatError extends Error {
  readonly code: AppleFormatErrorCode;

  constructor(code: AppleFormatErrorCode) {
    super(code);
    this.name = "AppleFormatError";
    this.code = code;
  }
}
