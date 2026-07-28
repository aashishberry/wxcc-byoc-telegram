export class BridgeError extends Error {
  constructor(
    readonly code: string,
    readonly httpStatus = 500,
    readonly retryable = false,
  ) {
    super(code);
    this.name = "BridgeError";
  }
}

export function bridgeErrorCode(error: unknown) {
  return error instanceof BridgeError ? error.code : "UNEXPECTED";
}
