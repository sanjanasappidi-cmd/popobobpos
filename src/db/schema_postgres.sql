-- ========================================================
-- POP O' BOB POS & Kitchen Order System
-- PostgreSQL 18 Production Schema
-- ========================================================

-- Enable UUID extension if needed
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. OUTLETS
CREATE TABLE IF NOT EXISTS outlets (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  code VARCHAR(64) UNIQUE,
  address TEXT,
  phone VARCHAR(32),
  manager_name VARCHAR(128),
  payment_policy VARCHAR(32) DEFAULT 'FLEXIBLE',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. CATEGORIES
CREATE TABLE IF NOT EXISTS categories (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  display_order INT DEFAULT 1,
  is_active BOOLEAN DEFAULT TRUE,
  subcategories JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. ADDONS / TOPPINGS / MODIFIERS
CREATE TABLE IF NOT EXISTS add_ons (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  price NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
  category VARCHAR(128) NOT NULL,
  selection_type VARCHAR(32) DEFAULT 'SINGLE',
  min_selections INT DEFAULT 1,
  max_selections INT DEFAULT 1,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. PRODUCTS / MENU ITEMS
CREATE TABLE IF NOT EXISTS products (
  id VARCHAR(64) PRIMARY KEY,
  category_id VARCHAR(64) NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  subcategory VARCHAR(128),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  sku VARCHAR(64) UNIQUE,
  base_price NUMERIC(10, 2) NOT NULL,
  image_url TEXT,
  badge VARCHAR(64),
  dietary_type VARCHAR(32) DEFAULT 'BEVERAGE',
  prep_time_minutes INT DEFAULT 5,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. PRODUCT ADDON MAPPINGS
CREATE TABLE IF NOT EXISTS product_addons (
  product_id VARCHAR(64) NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  addon_id VARCHAR(64) NOT NULL REFERENCES add_ons(id) ON DELETE CASCADE,
  PRIMARY KEY (product_id, addon_id)
);

-- 6. RESTAURANT TABLES
CREATE TABLE IF NOT EXISTS tables (
  id VARCHAR(64) PRIMARY KEY,
  outlet_id VARCHAR(64) NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
  table_number VARCHAR(32) NOT NULL,
  capacity INT DEFAULT 4,
  status VARCHAR(32) DEFAULT 'AVAILABLE',
  current_order_id VARCHAR(64),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7. SEQUENCES (Gapless Numbering Engine for Bills, Orders, KOTs)
CREATE TABLE IF NOT EXISTS sequences (
  name VARCHAR(128) PRIMARY KEY,
  last_value BIGINT DEFAULT 0
);

-- 8. ORDERS
CREATE TABLE IF NOT EXISTS orders (
  id VARCHAR(64) PRIMARY KEY,
  outlet_id VARCHAR(64) NOT NULL REFERENCES outlets(id),
  order_number VARCHAR(64) NOT NULL UNIQUE,
  order_type VARCHAR(32) NOT NULL,
  status VARCHAR(32) DEFAULT 'CONFIRMED',
  customer_name VARCHAR(128),
  customer_phone VARCHAR(32),
  table_id VARCHAR(64),
  table_number VARCHAR(32),
  customer_notes TEXT,
  subtotal NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
  discount_amount NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
  taxable_amount NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
  tax_amount NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
  total_amount NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 9. ORDER ITEMS
CREATE TABLE IF NOT EXISTS order_items (
  id VARCHAR(64) PRIMARY KEY,
  order_id VARCHAR(64) NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id VARCHAR(64) NOT NULL,
  product_name_snapshot VARCHAR(255) NOT NULL,
  variant_name_snapshot VARCHAR(128),
  unit_price_snapshot NUMERIC(10, 2) NOT NULL,
  quantity INT NOT NULL DEFAULT 1,
  line_total_snapshot NUMERIC(10, 2) NOT NULL,
  item_notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 10. ORDER ITEM ADDONS
CREATE TABLE IF NOT EXISTS order_item_addons (
  id VARCHAR(64) PRIMARY KEY,
  order_item_id VARCHAR(64) NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  addon_id VARCHAR(64) NOT NULL,
  addon_name_snapshot VARCHAR(255) NOT NULL,
  addon_price_snapshot NUMERIC(10, 2) NOT NULL DEFAULT 0.00
);

-- 11. BILLS / INVOICES (GST Tax Compliant)
CREATE TABLE IF NOT EXISTS bills (
  id VARCHAR(64) PRIMARY KEY,
  order_id VARCHAR(64) NOT NULL UNIQUE REFERENCES orders(id),
  outlet_id VARCHAR(64) NOT NULL REFERENCES outlets(id),
  invoice_number VARCHAR(64) NOT NULL UNIQUE,
  subtotal NUMERIC(10, 2) NOT NULL,
  discount_amount NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
  taxable_amount NUMERIC(10, 2) NOT NULL,
  cgst_rate NUMERIC(5, 2) NOT NULL DEFAULT 2.50,
  cgst_amount NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
  sgst_rate NUMERIC(5, 2) NOT NULL DEFAULT 2.50,
  sgst_amount NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
  tax_amount NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
  total_amount NUMERIC(10, 2) NOT NULL,
  paid_amount NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
  status VARCHAR(32) NOT NULL DEFAULT 'ISSUED',
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  settled_at TIMESTAMPTZ
);

-- 12. PAYMENTS
CREATE TABLE IF NOT EXISTS payments (
  id VARCHAR(64) PRIMARY KEY,
  bill_id VARCHAR(64) NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  amount NUMERIC(10, 2) NOT NULL,
  payment_method VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'SUCCESSFUL',
  idempotency_key VARCHAR(128),
  transaction_reference VARCHAR(128),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 13. KITCHEN ORDER TICKETS (KOT)
CREATE TABLE IF NOT EXISTS kitchen_tickets (
  id VARCHAR(64) PRIMARY KEY,
  ticket_number VARCHAR(64) NOT NULL,
  outlet_id VARCHAR(64) NOT NULL REFERENCES outlets(id),
  order_id VARCHAR(64) NOT NULL REFERENCES orders(id),
  order_number_snapshot VARCHAR(64) NOT NULL,
  order_type_snapshot VARCHAR(32) NOT NULL,
  table_number_snapshot VARCHAR(32),
  status VARCHAR(32) DEFAULT 'QUEUED',
  customer_notes_snapshot TEXT,
  cancellation_reason TEXT,
  reprint_count INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 14. KITCHEN TICKET ITEMS
CREATE TABLE IF NOT EXISTS kitchen_ticket_items (
  id VARCHAR(64) PRIMARY KEY,
  ticket_id VARCHAR(64) NOT NULL REFERENCES kitchen_tickets(id) ON DELETE CASCADE,
  order_item_id VARCHAR(64),
  product_name_snapshot VARCHAR(255) NOT NULL,
  variant_name_snapshot VARCHAR(128),
  quantity INT NOT NULL DEFAULT 1,
  status VARCHAR(32) DEFAULT 'QUEUED',
  is_voided INT DEFAULT 0,
  void_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 15. KITCHEN TICKET ITEM ADDONS
CREATE TABLE IF NOT EXISTS kitchen_ticket_item_addons (
  id VARCHAR(64) PRIMARY KEY,
  ticket_item_id VARCHAR(64) NOT NULL REFERENCES kitchen_ticket_items(id) ON DELETE CASCADE,
  addon_name_snapshot VARCHAR(255) NOT NULL
);

-- INDEXES FOR FAST REPORTING AND LOOKUPS
CREATE INDEX IF NOT EXISTS idx_products_cat ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_orders_outlet ON orders(outlet_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bills_outlet ON bills(outlet_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kitchen_tickets_outlet ON kitchen_tickets(outlet_id, status);
CREATE INDEX IF NOT EXISTS idx_payments_bill ON payments(bill_id);
