import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  CANCEL_WINDOW_DAYS,
  customerGid,
  processCancelRequest,
  withinCancelWindow,
} from "../cancel.server";

/**
 * Storefront App Proxy endpoint.
 *
 * Mounted at {app_proxy.url} = /proxy, reached from the storefront as
 * https://{shop}/apps/orders.
 *
 *  - GET  -> list the logged-in customer's orders (Admin GraphQL) merged with
 *            the cancel requests we persisted locally.
 *  - POST -> record a cancel REQUEST for an order the customer owns.
 *
 * The shared cancel logic lives in app/cancel.server.ts (also used by the
 * customer-account UI extension endpoint).
 */

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
      requested,
      requestDate: record?.cancelDate ?? null,
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

  const { status, body } = await processCancelRequest({
    admin,
    shop: session.shop,
    customerId,
    orderId,
  });
  return json(body, { status });
}
