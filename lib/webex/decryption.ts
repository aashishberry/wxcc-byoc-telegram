import { webexDecryptionTimeoutMs } from "../config";
import { BridgeError } from "../errors";
import { webexAccessToken } from "./client";
import type { WebexAttachment } from "./types";

type Cypher = {
  register(): Promise<void>;
  deregister(): Promise<void>;
  downloadAndDecryptFile(
    url: string,
    options: {
      useFileService: false;
      jwe?: string;
      keyUri?: string;
    },
  ): Promise<ArrayBuffer>;
};

type WebexEncryptionClient = {
  ready?: boolean;
  cypher?: Cypher;
  once(event: "ready", callback: () => void): void;
  logger?: Record<string, (...args: unknown[]) => void>;
};

type WebexEncryptionConstructor = {
  init(input: {
    credentials: { access_token: string };
  }): WebexEncryptionClient;
};

function withoutSdkLogs(client: WebexEncryptionClient) {
  if (!client.logger) return;
  const discard = () => undefined;
  for (const level of ["error", "warn", "log", "info", "debug", "trace"])
    client.logger[level] = discard;
}

async function ready(client: WebexEncryptionClient) {
  if (client.ready) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new BridgeError("WEBEX_DECRYPTION_SDK_TIMEOUT", 504, true)),
      webexDecryptionTimeoutMs(),
    );
    client.once("ready", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function encryptionMetadata(attachment: WebexAttachment) {
  return {
    jwe:
      attachment.jwe ??
      attachment.encryptionDetails?.jwe ??
      attachment.encryption_details?.jwe,
    keyUri:
      attachment.keyUri ??
      attachment.encryptionDetails?.keyUri ??
      attachment.encryption_details?.keyUri,
  };
}

async function withTimeout<T>(
  operation: Promise<T>,
  code: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new BridgeError(code, 504, true)),
          webexDecryptionTimeoutMs(),
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function decryptWebexAttachment(
  url: string,
  attachment: WebexAttachment,
) {
  let client: WebexEncryptionClient | undefined;
  try {
    const sdkModule = await import("@webex/plugin-encryption");
    const Webex = sdkModule.default as unknown as WebexEncryptionConstructor;
    client = Webex.init({
      credentials: { access_token: await webexAccessToken() },
    });
    withoutSdkLogs(client);
    await ready(client);
    if (!client.cypher)
      throw new BridgeError("WEBEX_DECRYPTION_SDK_UNAVAILABLE", 502, true);

    await withTimeout(
      client.cypher.register(),
      "WEBEX_DECRYPTION_REGISTER_TIMEOUT",
    );
    const decrypted = await withTimeout(
      client.cypher.downloadAndDecryptFile(url, {
        useFileService: false,
        ...encryptionMetadata(attachment),
      }),
      "WEBEX_ATTACHMENT_DECRYPT_TIMEOUT",
    );
    return new Uint8Array(decrypted);
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError("WEBEX_ATTACHMENT_DECRYPT_FAILED", 502, true);
  } finally {
    if (client?.cypher) {
      try {
        await withTimeout(
          client.cypher.deregister(),
          "WEBEX_DECRYPTION_DEREGISTER_TIMEOUT",
        );
      } catch {
        // The ephemeral SDK device is best-effort cleanup. Never expose SDK
        // errors or attachment metadata through logs.
      }
    }
  }
}
