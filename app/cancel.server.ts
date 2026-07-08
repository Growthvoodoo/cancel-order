/**
 * Shared "cancel request" logic used by both entry points:
 *   - app/routes/proxy.tsx                (storefront App Proxy, /apps/orders)
 *   - app/routes/customer-account.cancel.tsx (new customer accounts UI extension)
 *
 * It records a cancel REQUEST for an order the customer owns (the Shopify order
 * is NOT cancelled) and notifies CandyExpress. Callers authenticate however is
 * appropriate for their surface, then hand us an offline `admin` client plus the
 * shop + customer id, and we enforce ownership / the cancel window / idempotency.
 */
import prisma from "./db.server";

// Customers can cancel only within this many days of the order being placed.
export const CANCEL_WINDOW_DAYS = 14;
const CANCEL_WINDOW_MS = CANCEL_WINDOW_DAYS * 24 * 60 * 60 * 1000;

// External system that wants a copy of every cancellation.
const CANDYEXPRESS_WEBHOOK_URL =
  "https://api.candyexpress.com/api/v1/webhook/sync/order/cancel";

export function customerGid(id: string) {
  return `gid://shopify/Customer/${id}`;
}

// "gid://shopify/Order/123" -> "123"  and  "gid://shopify/Customer/123" -> "123"
export function numericId(gid: string | null | undefined) {
  if (!gid) return null;
  return gid.split("/").pop() || gid;
}

export function withinCancelWindow(createdAt: string) {
  return Date.now() - new Date(createdAt).getTime() <= CANCEL_WINDOW_MS;
}

const ORDER_DETAILS_QUERY = `#graphql
  query OrderDetails($id: ID!) {
    order(id: $id) {
      id
      name
      email
      phone
      createdAt
      cancelledAt
      totalPriceSet {
        presentmentMoney {
          amount
          currencyCode
        }
        shopMoney {
          amount
          currencyCode
        }
      }
      customer {
        id
        firstName
        lastName
        email
        phone
      }
    }
  }
`;

type AdminClient = {
  graphql: (query: string, opts: { variables: Record<string, unknown> }) => Promise<Response>;
};

export interface CancelResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Record a cancel request. `customerId` is the numeric Shopify customer id.
 * Returns a { status, body } pair the caller serializes with json()/cors().
 */
export async function processCancelRequest(params: {
  admin: AdminClient;
  shop: string;
  customerId: string;
  orderId: string;
}): Promise<CancelResult> {
  const { admin, shop, customerId, orderId } = params;

  if (!orderId.startsWith("gid://shopify/Order/")) {
    return { status: 400, body: { ok: false, error: "Invalid order id." } };
  }

  // Fetch full order details (also used to build the outbound webhook payload).
  const ownerRes = await admin.graphql(ORDER_DETAILS_QUERY, {
    variables: { id: orderId },
  });
  const ownerBody = await ownerRes.json();
  const order = ownerBody?.data?.order;

  if (!order) {
    return { status: 404, body: { ok: false, error: "Order not found." } };
  }
  // Ownership check: never cancel an order that isn't this customer's.
  if (order.customer?.id !== customerGid(customerId)) {
    return { status: 403, body: { ok: false, error: "You can only cancel your own orders." } };
  }
  if (order.cancelledAt) {
    return { status: 409, body: { ok: false, error: "This order is already cancelled." } };
  }
  // Enforce the cancellation window server-side so it can't be bypassed.
  if (!withinCancelWindow(order.createdAt)) {
    return {
      status: 403,
      body: {
        ok: false,
        error: `The ${CANCEL_WINDOW_DAYS}-day cancellation window for this order has passed.`,
      },
    };
  }

  // Idempotent: if a request already exists for this order, don't notify again.
  const existing = await prisma.cancelledOrder.findUnique({
    where: { shop_orderId: { shop, orderId } },
  });
  if (existing) {
    return {
      status: 200,
      body: {
        ok: true,
        alreadyRequested: true,
        order: {
          id: orderId,
          name: order.name,
          orderDate: order.createdAt,
          requestDate: existing.cancelDate,
        },
      },
    };
  }

  // Record the cancel REQUEST only. We intentionally do NOT call orderCancel —
  // the merchant / CandyExpress team reviews it and follows up with the customer.
  const record = await prisma.cancelledOrder.create({
    data: {
      shop,
      customerId,
      orderId,
      orderName: order.name,
      orderDate: new Date(order.createdAt),
    },
  });

  // Notify the external CandyExpress system with everything we know.
  const money = order.totalPriceSet?.presentmentMoney ?? order.totalPriceSet?.shopMoney ?? null;
  const webhook = await sendCancelWebhook({
    id: Number(numericId(order.id)),
    admin_graphql_api_id: order.id,
    name: order.name,
    email: order.email ?? order.customer?.email ?? null,
    phone: order.phone ?? order.customer?.phone ?? null,
    cancel_reason: "customer",
    cancelled_at: record.cancelDate.toISOString(),
    created_at: order.createdAt,
    currency: money?.currencyCode ?? null,
    total_price: money?.amount ?? null,
    customer: {
      id: numericId(order.customer?.id) ? Number(numericId(order.customer?.id)) : null,
      first_name: order.customer?.firstName ?? null,
      last_name: order.customer?.lastName ?? null,
      email: order.customer?.email ?? null,
      phone: order.customer?.phone ?? null,
    },
    shop,
  });

  return {
    status: 200,
    body: {
      ok: true,
      webhookDelivered: webhook.delivered,
      order: {
        id: orderId,
        name: order.name,
        orderDate: order.createdAt,
        requestDate: record.cancelDate,
      },
    },
  };
}

// POST the cancel request to CandyExpress. Never throws: the request is already
// recorded, so a webhook failure must not fail the customer's request.
async function sendCancelWebhook(payload: Record<string, unknown>) {
  try {
    const res = await fetch(CANDYEXPRESS_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error(
        `CandyExpress webhook failed: ${res.status} ${await res.text().catch(() => "")}`,
      );
      return { delivered: false };
    }
    return { delivered: true };
  } catch (error) {
    console.error("CandyExpress webhook error:", error);
    return { delivered: false };
  }
}
