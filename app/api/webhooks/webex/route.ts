import { BridgeError } from "../../../../lib/errors";
import { safeErrorCode } from "../../../../lib/logger";
import { handleWebexWebhook } from "../../../../lib/webex/handler";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const rawBody = await request.text();
  try {
    const result = await handleWebexWebhook(rawBody, request);
    return Response.json({ received: true, outcome: result.outcome });
  } catch (error) {
    const status = error instanceof BridgeError ? error.httpStatus : 500;
    return Response.json(
      {
        received: false,
        retryable: status >= 500,
        code: safeErrorCode(error),
      },
      { status },
    );
  }
}
