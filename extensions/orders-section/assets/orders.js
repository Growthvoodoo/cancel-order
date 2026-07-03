(function () {
  "use strict";

  function formatDate(value) {
    if (!value) return "—";
    var d = new Date(value);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }

  // "gid://shopify/Order/123456" -> "123456" for a friendlier display.
  function shortOrderId(gid) {
    if (!gid) return "";
    var parts = String(gid).split("/");
    return parts[parts.length - 1] || gid;
  }

  function init(root) {
    var proxyUrl = root.getAttribute("data-proxy-url") || "/apps/orders";
    var statusEl = root.querySelector('[data-role="status"]');
    var listEl = root.querySelector('[data-role="list"]');
    var template = root.querySelector('[data-role="row-template"]');

    if (!statusEl || !listEl || !template) return;

    function setStatus(msg) {
      statusEl.hidden = false;
      statusEl.textContent = msg;
    }

    function renderOrders(orders) {
      listEl.innerHTML = "";

      if (!orders.length) {
        setStatus("You have no orders yet.");
        listEl.hidden = true;
        return;
      }

      statusEl.hidden = true;
      listEl.hidden = false;

      orders.forEach(function (order) {
        var node = template.content.firstElementChild.cloneNode(true);

        node.querySelector('[data-role="name"]').textContent = order.name;
        node.querySelector('[data-role="order-id"]').textContent = shortOrderId(order.id);
        node.querySelector('[data-role="order-date"]').textContent = formatDate(order.orderDate);

        var isCancelled = Boolean(order.cancelledAt) || Boolean(order.cancelledByApp);
        var badge = node.querySelector('[data-role="badge"]');
        var cancelBtn = node.querySelector('[data-role="cancel"]');
        var cancelWrap = node.querySelector('[data-role="cancel-date-wrap"]');
        var cancelDateEl = node.querySelector('[data-role="cancel-date"]');

        if (isCancelled) {
          badge.textContent = "Cancelled";
          badge.classList.add("app-my-orders__badge--cancelled");
          cancelBtn.hidden = true;
          if (order.cancelDate) {
            cancelWrap.hidden = false;
            cancelDateEl.textContent = formatDate(order.cancelDate);
          }
        } else if (order.cancellable === false) {
          // Past the cancellation window (default 14 days): show a disabled button.
          badge.textContent = order.fulfillmentStatus || "Open";
          var days = order.cancelWindowDays || 14;
          cancelBtn.disabled = true;
          cancelBtn.title = "The " + days + "-day cancellation window has passed.";
          var note = document.createElement("span");
          note.className = "app-my-orders__note";
          note.textContent = "Cancellation window closed";
          cancelBtn.parentNode.appendChild(note);
        } else {
          badge.textContent = order.fulfillmentStatus || "Open";
          cancelBtn.addEventListener("click", function () {
            cancelOrder(order, node, cancelBtn, badge, cancelWrap, cancelDateEl);
          });
        }

        listEl.appendChild(node);
      });
    }

    function cancelOrder(order, node, cancelBtn, badge, cancelWrap, cancelDateEl) {
      if (!window.confirm("Cancel order " + order.name + "? This cannot be undone.")) {
        return;
      }

      cancelBtn.disabled = true;
      cancelBtn.textContent = "Cancelling…";

      var body = new FormData();
      body.append("orderId", order.id);

      fetch(proxyUrl, {
        method: "POST",
        headers: { Accept: "application/json" },
        body: body,
      })
        .then(function (res) {
          return res.json().then(function (data) {
            return { ok: res.ok, data: data };
          });
        })
        .then(function (result) {
          if (!result.ok || !result.data.ok) {
            var msg = (result.data && result.data.error) || "Could not cancel this order.";
            cancelBtn.disabled = false;
            cancelBtn.textContent = "Cancel Order";
            window.alert(msg);
            return;
          }

          badge.textContent = "Cancelled";
          badge.classList.add("app-my-orders__badge--cancelled");
          cancelBtn.hidden = true;
          cancelWrap.hidden = false;
          cancelDateEl.textContent = formatDate(result.data.order.cancelDate);
        })
        .catch(function () {
          cancelBtn.disabled = false;
          cancelBtn.textContent = "Cancel Order";
          window.alert("Something went wrong. Please try again.");
        });
    }

    function load() {
      setStatus("Loading your orders…");
      fetch(proxyUrl, { headers: { Accept: "application/json" } })
        .then(function (res) {
          return res.json();
        })
        .then(function (data) {
          if (data.loggedIn === false) {
            setStatus("Please log in to view your orders.");
            return;
          }
          renderOrders(data.orders || []);
        })
        .catch(function () {
          setStatus("Unable to load your orders right now.");
        });
    }

    load();
  }

  function boot() {
    document.querySelectorAll(".app-my-orders").forEach(function (root) {
      if (root.getAttribute("data-logged-in") === "true") {
        init(root);
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
