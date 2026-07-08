import '@shopify/ui-extensions/preact';
import {render} from 'preact';

// Renders a "Cancel order" button in each order's action menu, on BOTH the
// order index (list) page and the order status page. Because it has no `href`,
// clicking it opens the paired `customer-account.order.action.render` modal.
export default async () => {
  render(<MenuItem />, document.body);
};

function MenuItem() {
  return <s-button>Cancel order</s-button>;
}
