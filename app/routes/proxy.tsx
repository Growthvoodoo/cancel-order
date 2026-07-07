import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

/**
 * Storefront App Proxy endpoint.
 *
 * Mounted at {app_proxy.url} = /proxy, reached from the storefront as
 * https://{shop}/apps/orders.
 *
 *  - GET  -> list the logged-in customer's orders (Admin GraphQL) merged with
 *            the cancel requests we persisted locally.
 *  - POST -> record a cancel REQUEST for an order the customer owns (the Shopify
 *            order is NOT cancelled) and notify CandyExpress so the team follows up.
 *
 * `authenticate.public.appProxy` verifies Shopify's signed request and hands us
 * an offline `admin` client for the shop. Shopify appends `logged_in_customer_id`
 * to the query string when a customer is signed in on the storefront.
 */

// Customers can cancel only within this many days of the order being placed.
const CANCEL_WINDOW_DAYS = 14;
const CANCEL_WINDOW_MS = CANCEL_WINDOW_DAYS * 24 * 60 * 60 * 1000;

// External system that wants a copy of every cancellation.
const CANDYEXPRESS_WEBHOOK_URL =
  "https://api.candyexpress.com/api/v1/webhook/sync/order/cancel";

function customerGid(id: string) {
  return `gid://shopify/Customer/${id}`;
}

// "gid://shopify/Order/123" -> "123"
function numericId(gid: string | null | undefined) {
  if (!gid) return null;
  return gid.split("/").pop() || gid;
}

function withinCancelWindow(createdAt: string) {
  return Date.now() - new Date(createdAt).getTime() <= CANCEL_WINDOW_MS;
}

const CUSTOMER_ORDERS_QUERY = `#graphql
  query CustomerOrders($id: ID!) {
    customer(id: $id) {
      id
      orders(first: 50, sortKey: CREATED_AT, reverse: true) {
        edges {
          node {
            id
            name
            createdAt
            cancelledAt
            displayFinancialStatus
            displayFulfillmentStatus
            totalPriceSet {
              presentmentMoney {
                amount
                currencyCode
              }
            }
          }
        }
      }
    }
  }
`;

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

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.public.appProxy(request);

  if (!admin || !session) {
    return json({ error: "App is not installed on this shop." }, { status: 401 });
  }

  const url = new URL(request.url);
  const customerId = url.searchParams.get("logged_in_customer_id");

  if (!customerId) {
    return json({ loggedIn: false, orders: [] });
  }

  const response = await admin.graphql(CUSTOMER_ORDERS_QUERY, {
    variables: { id: customerGid(customerId) },
  });
  const body = await response.json();
  const edges = body?.data?.customer?.orders?.edges ?? [];

  // Local cancel records for this customer, keyed by order gid.
  const records = await prisma.cancelledOrder.findMany({
    where: { shop: session.shop, customerId },
  });
  const recordByOrderId = new Map(records.map((r) => [r.orderId, r]));

  const orders = edges.map(({ node }: any) => {
    const record = recordByOrderId.get(node.id);
    const requested = Boolean(record); // a cancel request was submitted via the app
    const cancelledInShopify = Boolean(node.cancelledAt); // merchant actually cancelled it
    const inWindow = withinCancelWindow(node.createdAt);
    return {
      id: node.id,
      name: node.name,
      orderDate: node.createdAt,
      cancelledInShopify,
      financialStatus: node.displayFinancialStatus,
      fulfillmentStatus: node.displayFulfillmentStatus,
      total: node.totalPriceSet?.presentmentMoney ?? null,
      // A cancel request submitted through this app (order is NOT auto-cancelled).
      requested,
      requestDate: record?.cancelDate ?? null,
      // The button is only offered on open orders inside the window that
      // haven't already been requested/cancelled.
      cancellable: !requested && !cancelledInShopify && inWindow,
      cancelWindowClosed: !requested && !cancelledInShopify && !inWindow,
      cancelWindowDays: CANCEL_WINDOW_DAYS,
    };
  });

  return json({ loggedIn: true, orders });
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.public.appProxy(request);

  if (!admin || !session) {
    return json({ ok: false, error: "App is not installed on this shop." }, { status: 401 });
  }

  const url = new URL(request.url);
  const customerId = url.searchParams.get("logged_in_customer_id");

  if (!customerId) {
    return json({ ok: false, error: "You must be logged in to cancel an order." }, { status: 401 });
  }

  const form = await request.formData();
  const orderId = String(form.get("orderId") || "");

  if (!orderId.startsWith("gid://shopify/Order/")) {
    return json({ ok: false, error: "Invalid order id." }, { status: 400 });
  }

  // Fetch full order details (also used to build the outbound webhook payload).
  const ownerRes = await admin.graphql(ORDER_DETAILS_QUERY, {
    variables: { id: orderId },
  });
  const ownerBody = await ownerRes.json();
  const order = ownerBody?.data?.order;

  if (!order) {
    return json({ ok: false, error: "Order not found." }, { status: 404 });
  }
  // Ownership check: never cancel an order that isn't this customer's.
  if (order.customer?.id !== customerGid(customerId)) {
    return json({ ok: false, error: "You can only cancel your own orders." }, { status: 403 });
  }
  if (order.cancelledAt) {
    return json({ ok: false, error: "This order is already cancelled." }, { status: 409 });
  }
  // Enforce the 14-day window server-side so it can't be bypassed by the client.
  if (!withinCancelWindow(order.createdAt)) {
    return json(
      {
        ok: false,
        error: `The ${CANCEL_WINDOW_DAYS}-day cancellation window for this order has passed.`,
      },
      { status: 403 },
    );
  }

  // Idempotent: if a request already exists for this order, don't notify again.
  const existing = await prisma.cancelledOrder.findUnique({
    where: { shop_orderId: { shop: session.shop, orderId } },
  });
  if (existing) {
    return json({
      ok: true,
      alreadyRequested: true,
      order: {
        id: orderId,
        name: order.name,
        orderDate: order.createdAt,
        requestDate: existing.cancelDate,
      },
    });
  }

  // Record the cancel REQUEST only. We intentionally do NOT call orderCancel —
  // the merchant / CandyExpress team reviews it and follows up with the customer.
  const record = await prisma.cancelledOrder.create({
    data: {
      shop: session.shop,
      customerId,
      orderId,
      orderName: order.name,
      orderDate: new Date(order.createdAt),
    },
  });

  // Notify the external CandyExpress system with everything we know about the order.
  const money = order.totalPriceSet?.presentmentMoney ?? order.totalPriceSet?.shopMoney ?? null;
  const webhookPayload = {
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
    shop: session.shop,
  };

  const webhook = await sendCancelWebhook(webhookPayload);

  return json({
    ok: true,
    webhookDelivered: webhook.delivered,
    order: {
      id: orderId,
      name: order.name,
      orderDate: order.createdAt,
      requestDate: record.cancelDate,
    },
  });
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
