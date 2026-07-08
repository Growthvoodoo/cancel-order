import '@shopify/ui-extensions/preact';
import {render} from 'preact';
import {useState} from 'preact/hooks';

// App backend that records the cancel request (same Vercel app URL).
const APP_URL = 'https://cancel-order-git-main-candy7913.vercel.app';

// Modal shown when the customer clicks the "Cancel order" action button.
export default async () => {
  render(<CancelAction />, document.body);
};

function CancelAction() {
  // This target only exposes the order id; the backend re-fetches order details.
  const orderId = shopify.orderId;
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
        body: JSON.stringify({orderId}),
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
    <s-customer-account-action heading="Cancel order">
      {!done && (
        <s-button slot="primary-action" onClick={submit} loading={submitting}>
          Confirm cancellation
        </s-button>
      )}
      {!done && (
        <s-button slot="secondary-action" onClick={() => shopify.close()}>
          Keep order
        </s-button>
      )}
      <s-stack direction="block" gap="base">
        <s-text>
          {done
            ? 'We received your cancel order request. If the order is not delivered yet, we will contact you.'
            : 'Request cancellation for this order? Our team will review and follow up with you.'}
        </s-text>
        {error && <s-banner tone="critical">{error}</s-banner>}
      </s-stack>
    </s-customer-account-action>
  );
}
