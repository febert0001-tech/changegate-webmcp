import { createHash, timingSafeEqual } from "node:crypto";
import { MerchantError, merchantCommand } from "./contracts";
import type { MerchantRefunds } from "./service";

const responseHeaders = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: responseHeaders });

async function commandBody(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.startsWith("application/json") || !request.body) {
    throw new MerchantError("JSON_REQUIRED", 400);
  }
  const reader = request.body.getReader();
  const bytes: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > 8192) {
      void reader.cancel().catch(() => {});
      throw new MerchantError("REQUEST_TOO_LARGE", 413);
    }
    bytes.push(next.value);
  }
  try {
    return JSON.parse(Buffer.concat(bytes).toString("utf8")) as unknown;
  } catch {
    throw new MerchantError("INVALID_JSON", 400);
  }
}

const digest = (value: string) => createHash("sha256").update(value).digest();

export function createMerchantHandler(
  service: MerchantRefunds,
  config: { origin: string; operator: string; password: string; executionEnabled: boolean },
) {
  const authorization = digest("Basic " + Buffer.from(config.operator + ":" + config.password).toString("base64"));
  const expectedHost = new URL(config.origin).host;
  return async (request: Request): Promise<Response> => {
    const requestHost = request.headers.get("host") ?? new URL(request.url).host;
    if (request.headers.get("origin") !== config.origin || requestHost !== expectedHost) {
      return json({ error: "ORIGIN_DENIED" }, 403);
    }
    const candidate = request.headers.get("authorization");
    if (!candidate || candidate.length > 1024 || !timingSafeEqual(digest(candidate), authorization)) {
      return json({ error: "OPERATOR_AUTH_REQUIRED" }, 401);
    }
    try {
      const parsed = merchantCommand.safeParse(await commandBody(request));
      if (!parsed.success) return json({ error: "INVALID_OPERATOR_REQUEST" }, 400);
      const input = parsed.data;
      switch (input.action) {
        case "session":
          return json({
            operator: config.operator, merchantId: service.store.merchantId, environment: service.environment,
            maxRefundCents: service.maxRefundCents, executionEnabled: config.executionEnabled,
          });
        case "queue": return json(service.store.queue());
        case "find": return json(await service.find(input.kind, input.reference));
        case "case": return json(service.store.detail(input.id));
        case "propose": return json(await service.propose(input.captureId, input.amountCents, config.operator));
        case "review": return json(service.review(input.id, input.version, config.operator));
        case "decide": return json(service.decide(input.id, input.version, input.decision, config.operator));
        case "execute":
          if (!config.executionEnabled) throw new MerchantError("SANDBOX_EXECUTION_DISABLED", 403);
          return json(await service.execute(input.id, input.version, config.operator));
        case "reconcile": return json(await service.reconcile(input.id, input.refundId));
      }
    } catch (error) {
      return error instanceof MerchantError
        ? json({ error: error.code }, error.status)
        : json({ error: "MERCHANT_WORKFLOW_UNAVAILABLE" }, 502);
    }
  };
}
