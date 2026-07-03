-- CreateTable
CREATE TABLE "CancelledOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderName" TEXT NOT NULL,
    "orderDate" DATETIME NOT NULL,
    "cancelDate" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "CancelledOrder_shop_customerId_idx" ON "CancelledOrder"("shop", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "CancelledOrder_shop_orderId_key" ON "CancelledOrder"("shop", "orderId");
