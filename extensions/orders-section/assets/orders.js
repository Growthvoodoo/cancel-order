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
    // Merchant-customizable text (set in the theme editor).
    var text = {
      popupTitle: root.getAttribute("data-popup-title") || "Request received",
      popupMessage:
        root.getAttribute("data-popup-message") ||
        "We received your cancel order request. If the order is not delivered yet, we will contact with you.",
      requested: root.getAttribute("data-requested-label") || "Cancellation requested",
      windowClosed: root.getAttribute("data-window-closed-label") || "Cancellation window closed",
    };

    var statusEl = root.querySelector('[data-role="status"]');
    var listEl = root.querySelector('[data-role="list"]');
    var template = root.querySelector('[data-role="row-template"]');
    if (!statusEl || !listEl || !template) return;

    // ---- Popup modal -------------------------------------------------------
    var modal = root.querySelector('[data-role="modal"]');
    var modalTitle = modal && modal.querySelector('[data-role="modal-title"]');
    var modalMsg = modal && modal.querySelector('[data-role="modal-message"]');
    // Move the modal to <body> so its fixed overlay always covers the whole
    // viewport — a transformed theme ancestor can otherwise clip a fixed child.
    if (modal) document.body.appendChild(modal);

    function openModal(title, message, isError) {
      if (!modal) {
        window.alert(message);
        return;
      }
      modal.classList.toggle("is-error", !!isError);
      if (modalTitle) modalTitle.textContent = title || "";
      if (modalMsg) modalMsg.textContent = message || "";
      modal.hidden = false;
    }
    function closeModal() {
      if (modal) modal.hidden = true;
    }
    if (modal) {
      modal.querySelectorAll('[data-role="modal-close"]').forEach(function (el) {
        el.addEventListener("click", closeModal);
      });
      document.addEventListener("keydown", function (e) {
        if (e.key === "Escape") closeModal();
      });
    }

    function setStatus(msg) {
      statusEl.hidden = false;
      statusEl.textContent = msg;
    }

    // ---- Rendering ---------------------------------------------------------
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
        listEl.appendChild(buildRow(order));
      });
    }

    function buildRow(order) {
      var node = template.content.firstElementChild.cloneNode(true);
      node.querySelector('[data-role="name"]').textContent = order.name;
      node.querySelector('[data-role="order-id"]').textContent = shortOrderId(order.id);
      node.querySelector('[data-role="order-date"]').textContent = formatDate(order.orderDate);

      var badge = node.querySelector('[data-role="badge"]');
      var cancelBtn = node.querySelector('[data-role="cancel"]');
      var reqWrap = node.querySelector('[data-role="request-date-wrap"]');
      var reqDateEl = node.querySelector('[data-role="request-date"]');

      function showRequestDate(dateStr) {
        if (dateStr && reqWrap && reqDateEl) {
          reqWrap.hidden = false;
          reqDateEl.textContent = formatDate(dateStr);
        }
      }
      function markRequested(dateStr) {
        badge.textContent = text.requested;
        badge.classList.add("app-my-orders__badge--requested");
        cancelBtn.hidden = true;
        showRequestDate(dateStr);
      }

      if (order.cancelledInShopify) {
        badge.textContent = "Cancelled";
        badge.classList.add("app-my-orders__badge--cancelled");
        cancelBtn.hidden = true;
        showRequestDate(order.requestDate);
      } else if (order.requested) {
        markRequested(order.requestDate);
      } else if (order.cancellable === false) {
        // Past the cancellation window: disabled button + note.
        badge.textContent = order.fulfillmentStatus || "Open";
        var days = order.cancelWindowDays || 14;
        cancelBtn.disabled = true;
        cancelBtn.title = "The " + days + "-day cancellation window has passed.";
        var note = document.createElement("span");
        note.className = "app-my-orders__note";
        note.textContent = text.windowClosed;
        cancelBtn.parentNode.appendChild(note);
      } else {
        badge.textContent = order.fulfillmentStatus || "Open";
        cancelBtn.addEventListener("click", function () {
          requestCancel(order, cancelBtn, markRequested);
        });
      }

      return node;
    }

    // ---- Submit a cancel REQUEST (does not cancel the order) ---------------
    function requestCancel(order, cancelBtn, markRequested) {
      var original = cancelBtn.textContent;
      cancelBtn.disabled = true;
      cancelBtn.textContent = "Sending…";

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
            cancelBtn.disabled = false;
            cancelBtn.textContent = original;
            openModal(
              text.popupTitle,
              (result.data && result.data.error) || "Something went wrong. Please try again.",
              true,
            );
            return;
          }
          var reqDate = result.data.order && result.data.order.requestDate;
          markRequested(reqDate);
          openModal(text.popupTitle, text.popupMessage);
        })
        .catch(function () {
          cancelBtn.disabled = false;
          cancelBtn.textContent = original;
          openModal(text.popupTitle, "Something went wrong. Please try again.", true);
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
