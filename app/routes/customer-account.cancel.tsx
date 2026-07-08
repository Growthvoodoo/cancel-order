import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate, unauthenticated } from "../shopify.server";
import { numericId, processCancelRequest } from "../cancel.server";

/**
 * Backend endpoint for the customer-account UI extension (new customer accounts).
 *
 * The extension runs on account.{shop} — a different origin — so it can't use the
 * storefront App Proxy. Instead it sends a Shopify session token (Bearer), which
 * we verify here with `authenticate.public.customerAccount`. That gives us the
 * shop (token `dest`) and the signed-in customer id (token `sub`). We then use an
 * offline admin client to run the exact same cancel logic as the storefront.
 *
 * CORS: the `cors()` helper adds the Access-Control-Allow-* headers and the auth
 * call also answers the preflight OPTIONS request.
 */
export async function action({ request }: ActionFunctionArgs) {
  const { sessionToken, cors } = await authenticate.public.customerAccount(request, {
    corsHeaders: ["Content-Type", "Authorization"],
  });

  // token.dest -> "https://{shop}.myshopify.com"; token.sub -> "gid://shopify/Customer/123"
  const shop = new URL(sessionToken.dest as string).hostname;
  const customerId = numericId((sessionToken as any).sub);

  if (!customerId) {
    return cors(
      json(
        { ok: false, error: "You must be logged in to cancel an order." },
        { status: 401 },
      ),
    );
  }

  let orderId = "";
  try {
    const payload = await request.json();
    orderId = String(payload?.orderId || "");
  } catch {
    return cors(json({ ok: false, error: "Invalid request body." }, { status: 400 }));
  }

  const { admin } = await unauthenticated.admin(shop);

  const { status, body } = await processCancelRequest({
    admin,
    shop,
    customerId,
    orderId,
  });
  return cors(json(body, { status }));
}
