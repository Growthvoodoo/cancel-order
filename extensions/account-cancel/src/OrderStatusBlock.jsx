import '@shopify/ui-extensions/preact';
import {render} from 'preact';
import {useState} from 'preact/hooks';

// App backend that records the cancel request (same Vercel app URL).
const APP_URL = 'https://cancel-order-git-main-candy7913.vercel.app';

// A visible "Request cancellation" card rendered on an order's status/detail page.
export default async () => {
  render(<CancelBlock />, document.body);
};

function CancelBlock() {
  const order = shopify.order.value;
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      // Request a token immediately before use (they expire after 5 minutes).
      const token = await shopify.sessionToken.get();
      const res = await fetch(`${APP_URL}/customer-account/cancel`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({orderId: order?.id}),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error || 'Something went wrong. Please try again.');
        setSubmitting(false);
        return;
      }
      setDone(true);
    } catch (e) {
      setError('Something went wrong. Please try again.');
      setSubmitting(false);
    }
  }

  return (
    <s-section heading="Cancel order">
      <s-stack direction="block" gap="base">
        <s-text>
          {done
            ? 'We received your cancel order request. If the order is not delivered yet, we will contact you.'
            : 'Need to cancel this order? Send us a cancellation request and our team will follow up.'}
        </s-text>
        {!done && (
          <s-button onClick={submit} loading={submitting}>
            Request cancellation
          </s-button>
        )}
        {error && <s-banner tone="critical">{error}</s-banner>}
      </s-stack>
    </s-section>
  );
}
