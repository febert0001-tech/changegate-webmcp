import { isAbsolute } from "node:path";
import { cents, providerReference } from "../../../merchant/contracts";
import { createMerchantHandler } from "../../../merchant/handler";
import { PayPalMerchantSandbox } from "../../../merchant/paypal-sandbox";
import { MerchantRefunds } from "../../../merchant/service";
import { demoMerchant, simulatedSandbox } from "../../../merchant/simulation";
import { MerchantStore } from "../../../merchant/store";

export const runtime = "nodejs";

let handler: ReturnType<typeof createMerchantHandler> | undefined;

function configure() {
  const env = process.env;
  const mode = env.CHANGEGATE_MERCHANT_MODE;
  if (mode !== "simulated" && mode !== "sandbox") return undefined;
  const origin = env.CHANGEGATE_MERCHANT_ORIGIN ?? "http://127.0.0.1:3190";
  const password = env.CHANGEGATE_OPERATOR_PASSWORD;
  const operator = env.CHANGEGATE_OPERATOR_NAME;
  const dbPath = env.CHANGEGATE_MERCHANT_DB;
  const maxRefundCents = Number(env.CHANGEGATE_MAX_REFUND_CENTS);
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(origin) ||
      !operator || !/^[\w.-]{1,64}$/.test(operator) ||
      !password || !/^[\x21-\x7e]{16,160}$/.test(password) ||
      !dbPath || !isAbsolute(dbPath) || !cents.safeParse(maxRefundCents).success) return undefined;

  const merchantId = mode === "simulated" ? demoMerchant : env.CHANGEGATE_MERCHANT_ID;
  const clientId = mode === "simulated" ? "simulated-client" : env.CHANGEGATE_SANDBOX_CLIENT_ID;
  const clientSecret = mode === "simulated" ? "simulated-secret" : env.CHANGEGATE_SANDBOX_CLIENT_SECRET;
  if (!merchantId || !providerReference.safeParse(merchantId).success || !clientId || !clientSecret) return undefined;
  const store = new MerchantStore(dbPath, merchantId, mode);
  const provider = new PayPalMerchantSandbox(
    { merchantId, clientId, clientSecret, maxRefundCents }, mode === "simulated" ? simulatedSandbox(store) : undefined,
  );
  const service = new MerchantRefunds(store, provider, mode === "simulated" ? "Simulated PayPal Sandbox" : "PayPal Sandbox", maxRefundCents);
  return createMerchantHandler(service, {
    origin, operator, password, executionEnabled: mode === "simulated" || env.CHANGEGATE_SANDBOX_ALLOW_REFUNDS === "1",
  });
}

export async function POST(request: Request) {
  try {
    handler ??= configure();
    if (handler) return await handler(request);
  } catch {
    // Server configuration and SQLite errors can contain paths. Report a stable code only.
  }
  return Response.json({ error: "MERCHANT_SANDBOX_CONFIGURATION_REQUIRED" }, {
    status: 503, headers: { "Cache-Control": "no-store" },
  });
}
