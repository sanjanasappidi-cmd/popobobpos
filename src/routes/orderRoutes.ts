import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db, getNextSequence } from '../db/database.js';

interface CreateOrderItemDTO {
  productId: string;
  variantId?: string;
  addOnIds?: string[];
  quantity: number;
  itemNotes?: string;
}

interface CreateOrderDTO {
  outletId: string;
  orderType: 'DINE_IN' | 'TAKEAWAY' | 'COUNTER';
  customerName?: string;
  customerPhone?: string;
  tableId?: string;
  tableNumber?: string;
  customerNotes?: string;
  items: CreateOrderItemDTO[];
}

function toIsoString(val: any): string {
  if (!val) return new Date().toISOString();
  if (val instanceof Date) return val.toISOString();
  const parsed = new Date(val);
  return !isNaN(parsed.getTime()) ? parsed.toISOString() : String(val);
}

export async function orderRoutes(fastify: FastifyInstance): Promise<void> {
  // --- CREATE ORDER (With Automatic KOT Generation) ---
  fastify.post('/api/v1/orders', async (req: FastifyRequest<{ Body: CreateOrderDTO }>, reply: FastifyReply) => {
    const { outletId, orderType, customerName, customerPhone, tableId, tableNumber, customerNotes, items } = req.body;

    if (!outletId) return reply.status(400).send({ error: 'Outlet ID is required' });
    if (!items || items.length === 0) return reply.status(400).send({ error: 'Order must contain at least 1 item' });

    const orderId = `ord-${Date.now()}`;
    const year = new Date().getFullYear();
    const seq = await getNextSequence(`orders-${outletId}-${year}`);
    const orderNumber = `ORD-${year}-${String(seq).padStart(4, '0')}`;

    let subtotal = 0;
    const resolvedItems = [];

    // Resolve products and add-ons from DB
    for (const item of items) {
      const prodRes = await db.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [item.productId] });
      if (prodRes.rows.length === 0) continue;

      const prod = prodRes.rows[0];
      const basePrice = Number(prod.base_price);
      let itemAddonTotal = 0;
      const resolvedAddons = [];

      if (item.addOnIds && item.addOnIds.length > 0) {
        for (const addonId of item.addOnIds) {
          const addonRes = await db.execute({ sql: 'SELECT * FROM add_ons WHERE id = ?', args: [addonId] });
          if (addonRes.rows.length > 0) {
            const add = addonRes.rows[0];
            const addonPrice = Number(add.price);
            itemAddonTotal += addonPrice;
            resolvedAddons.push({
              id: String(add.id),
              name: String(add.name),
              price: addonPrice,
            });
          }
        }
      }

      const unitPrice = basePrice + itemAddonTotal;
      const lineTotal = unitPrice * item.quantity;
      subtotal += lineTotal;

      resolvedItems.push({
        id: `oi-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        productId: item.productId,
        productName: String(prod.name),
        unitPrice,
        quantity: item.quantity,
        lineTotal,
        itemNotes: item.itemNotes,
        addons: resolvedAddons,
      });
    }

    const discountAmount = 0.0;
    const taxableAmount = subtotal - discountAmount;
    const taxAmount = Number((taxableAmount * 0.05).toFixed(2)); // 5% GST (2.5% CGST + 2.5% SGST)
    const rawTotal = Number((taxableAmount + taxAmount).toFixed(2));
    const totalAmount = Math.round(rawTotal); // Petpooja nearest rupee round-off

    // Insert Order
    await db.execute({
      sql: `INSERT INTO orders (id, outlet_id, order_number, order_type, status, customer_name, customer_phone, table_id, table_number, customer_notes, subtotal, discount_amount, taxable_amount, tax_amount, total_amount)
            VALUES (?, ?, ?, ?, 'CONFIRMED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [orderId, outletId, orderNumber, orderType, customerName || null, customerPhone || null, tableId || null, tableNumber || null, customerNotes || null, subtotal, discountAmount, taxableAmount, taxAmount, totalAmount],
    });

    // Insert Order Items and Item Addons
    for (const ri of resolvedItems) {
      await db.execute({
        sql: `INSERT INTO order_items (id, order_id, product_id, product_name_snapshot, unit_price_snapshot, quantity, line_total_snapshot, item_notes)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [ri.id, orderId, ri.productId, ri.productName, ri.unitPrice, ri.quantity, ri.lineTotal, ri.itemNotes || null],
      });

      for (const add of ri.addons) {
        await db.execute({
          sql: `INSERT INTO order_item_addons (id, order_item_id, addon_id, addon_name_snapshot, addon_price_snapshot)
                VALUES (?, ?, ?, ?, ?)`,
          args: [`oia-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, ri.id, add.id, add.name, add.price],
        });
      }
    }

    // --- AUTOMATIC KOT ENGINE ---
    // Generate sequential daily KOT Ticket Number formatted for QSR industry (KOT #001, KOT #002...)
    const todayStr = new Date().toISOString().slice(0, 10);
    const kotSeq = await getNextSequence(`kot-${outletId}-${todayStr}`);
    const formattedKotNumber = `KOT #${String(kotSeq).padStart(3, '0')}`;
    const ticketId = `kot-${Date.now()}`;

    await db.execute({
      sql: `INSERT INTO kitchen_tickets (id, ticket_number, outlet_id, order_id, order_number_snapshot, order_type_snapshot, table_number_snapshot, customer_notes_snapshot)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [ticketId, formattedKotNumber, outletId, orderId, orderNumber, orderType, tableNumber || null, customerNotes || null],
    });

    for (const ri of resolvedItems) {
      const kotItemId = `kti-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      await db.execute({
        sql: `INSERT INTO kitchen_ticket_items (id, ticket_id, order_item_id, product_name_snapshot, quantity)
              VALUES (?, ?, ?, ?, ?)`,
        args: [kotItemId, ticketId, ri.id, ri.productName, ri.quantity],
      });

      for (const add of ri.addons) {
        await db.execute({
          sql: `INSERT INTO kitchen_ticket_item_addons (id, ticket_item_id, addon_name_snapshot)
                VALUES (?, ?, ?)`,
          args: [`ktia-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, kotItemId, add.name],
        });
      }
    }

    // If table assigned, mark table as OCCUPIED
    if (tableId) {
      await db.execute({
        sql: "UPDATE tables SET status = 'OCCUPIED', current_order_id = ? WHERE id = ?",
        args: [orderId, tableId],
      });
    } else if (tableNumber && outletId) {
      await db.execute({
        sql: "UPDATE tables SET status = 'OCCUPIED', current_order_id = ? WHERE outlet_id = ? AND table_number = ?",
        args: [orderId, outletId, tableNumber],
      });
    }

    const createdOrder = {
      id: orderId,
      orderNumber,
      kotNumber: formattedKotNumber,
      orderType,
      status: 'CONFIRMED',
      customerName,
      customerPhone,
      tableNumber,
      subtotal,
      discountAmount,
      taxableAmount,
      taxAmount,
      totalAmount,
      items: resolvedItems.map((ri) => ({
        id: ri.id,
        productNameSnapshot: ri.productName,
        unitPriceSnapshot: ri.unitPrice,
        quantity: ri.quantity,
        lineTotalSnapshot: ri.lineTotal,
        itemNotes: ri.itemNotes,
        addOns: ri.addons,
      })),
      createdAt: new Date().toISOString(),
    };

    return reply.status(201).send(createdOrder);
  });

  // --- GET SINGLE ORDER ---
  fastify.get('/api/v1/orders/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { id } = req.params;
    const orderRes = await db.execute({ sql: 'SELECT * FROM orders WHERE id = ?', args: [id] });
    if (orderRes.rows.length === 0) return reply.status(404).send({ error: 'Order not found' });

    const order = orderRes.rows[0];
    const itemsRes = await db.execute({ sql: 'SELECT * FROM order_items WHERE order_id = ?', args: [id] });

    const items = [];
    for (const row of itemsRes.rows) {
      const addonsRes = await db.execute({ sql: 'SELECT * FROM order_item_addons WHERE order_item_id = ?', args: [row.id] });
      items.push({
        id: String(row.id),
        productNameSnapshot: String(row.product_name_snapshot),
        unitPriceSnapshot: Number(row.unit_price_snapshot),
        quantity: Number(row.quantity),
        lineTotalSnapshot: Number(row.line_total_snapshot),
        itemNotes: row.item_notes ? String(row.item_notes) : undefined,
        addOns: addonsRes.rows.map((a) => ({
          id: String(a.addon_id),
          name: String(a.addon_name_snapshot),
          price: Number(a.addon_price_snapshot),
        })),
      });
    }

    const latestTicketRes = await db.execute({
      sql: 'SELECT ticket_number FROM kitchen_tickets WHERE order_id = ? ORDER BY created_at DESC LIMIT 1',
      args: [id],
    });
    const kotNumber = latestTicketRes.rows.length > 0 ? String(latestTicketRes.rows[0].ticket_number) : undefined;

    return reply.send({
      id: String(order.id),
      orderNumber: String(order.order_number),
      kotNumber,
      orderType: String(order.order_type),
      status: String(order.status),
      customerName: order.customer_name ? String(order.customer_name) : undefined,
      customerPhone: order.customer_phone ? String(order.customer_phone) : undefined,
      tableNumber: order.table_number ? String(order.table_number) : undefined,
      subtotal: Number(order.subtotal),
      discountAmount: Number(order.discount_amount),
      taxableAmount: Number(order.taxable_amount),
      taxAmount: Number(order.tax_amount),
      totalAmount: Number(order.total_amount),
      items,
      createdAt: toIsoString(order.created_at),
    });
  });

  // --- GET ALL ORDERS (GLOBAL OR FILTERED) ---
  fastify.get('/api/v1/orders', async (req: FastifyRequest<{ Querystring: { outletId?: string } }>, reply: FastifyReply) => {
    const { outletId } = req.query;
    let sql = 'SELECT * FROM orders';
    const args: any[] = [];
    if (outletId) {
      sql += ' WHERE outlet_id = ?';
      args.push(outletId);
    }
    sql += ' ORDER BY created_at DESC LIMIT 100';
    const res = await db.execute({ sql, args });

    const orders = [];
    for (const o of res.rows) {
      const itemsRes = await db.execute({ sql: 'SELECT * FROM order_items WHERE order_id = ?', args: [o.id] });
      orders.push({
        id: String(o.id),
        orderNumber: String(o.order_number),
        orderType: String(o.order_type),
        status: String(o.status),
        customerName: o.customer_name ? String(o.customer_name) : undefined,
        customerPhone: o.customer_phone ? String(o.customer_phone) : undefined,
        tableNumber: o.table_number ? String(o.table_number) : undefined,
        subtotal: Number(o.subtotal),
        discountAmount: Number(o.discount_amount),
        taxableAmount: Number(o.taxable_amount),
        taxAmount: Number(o.tax_amount),
        totalAmount: Number(o.total_amount),
        items: itemsRes.rows.map((r) => ({
          id: String(r.id),
          productNameSnapshot: String(r.product_name_snapshot),
          unitPriceSnapshot: Number(r.unit_price_snapshot),
          quantity: Number(r.quantity),
          lineTotalSnapshot: Number(r.line_total_snapshot),
        })),
        createdAt: toIsoString(o.created_at),
      });
    }

    return reply.send(orders);
  });

  // --- GET ORDERS FOR OUTLET ---
  fastify.get('/api/v1/orders/outlet/:outletId', async (req: FastifyRequest<{ Params: { outletId: string } }>, reply: FastifyReply) => {
    const { outletId } = req.params;
    const res = await db.execute({
      sql: 'SELECT * FROM orders WHERE outlet_id = ? ORDER BY created_at DESC LIMIT 50',
      args: [outletId],
    });

    const orders = [];
    for (const o of res.rows) {
      const itemsRes = await db.execute({ sql: 'SELECT * FROM order_items WHERE order_id = ?', args: [o.id] });
      orders.push({
        id: String(o.id),
        orderNumber: String(o.order_number),
        orderType: String(o.order_type),
        status: String(o.status),
        customerName: o.customer_name ? String(o.customer_name) : undefined,
        customerPhone: o.customer_phone ? String(o.customer_phone) : undefined,
        tableNumber: o.table_number ? String(o.table_number) : undefined,
        subtotal: Number(o.subtotal),
        discountAmount: Number(o.discount_amount),
        taxableAmount: Number(o.taxable_amount),
        taxAmount: Number(o.tax_amount),
        totalAmount: Number(o.total_amount),
        items: itemsRes.rows.map((r) => ({
          id: String(r.id),
          productNameSnapshot: String(r.product_name_snapshot),
          unitPriceSnapshot: Number(r.unit_price_snapshot),
          quantity: Number(r.quantity),
          lineTotalSnapshot: Number(r.line_total_snapshot),
        })),
        createdAt: toIsoString(o.created_at),
      });
    }

    return reply.send(orders);
  });

  // --- REAL-TIME PRICING CALCULATION ---
  fastify.post('/api/v1/pricing/calculate', async (req: FastifyRequest<{
    Body: {
      outletId?: string;
      items: { productId: string; variantId?: string; addOnIds: string[]; quantity: number }[];
    }
  }>, reply: FastifyReply) => {
    const { items } = req.body;
    if (!items || items.length === 0) {
      return reply.send({
        subtotal: 0,
        discountAmount: 0,
        taxableAmount: 0,
        cgstAmount: 0,
        sgstAmount: 0,
        taxAmount: 0,
        totalAmount: 0,
        roundOffAmount: 0,
      });
    }

    let subtotal = 0;
    for (const item of items) {
      const prodRes = await db.execute({ sql: 'SELECT base_price FROM products WHERE id = ?', args: [item.productId] });
      const basePrice = prodRes.rows.length > 0 ? Number(prodRes.rows[0].base_price) : 0;
      let addonTotal = 0;
      if (item.addOnIds && item.addOnIds.length > 0) {
        for (const aid of item.addOnIds) {
          const addonRes = await db.execute({ sql: 'SELECT price FROM add_ons WHERE id = ?', args: [aid] });
          if (addonRes.rows.length > 0) {
            addonTotal += Number(addonRes.rows[0].price);
          }
        }
      }
      subtotal += (basePrice + addonTotal) * item.quantity;
    }

    const discountAmount = 0;
    const taxableAmount = subtotal - discountAmount;
    const cgstAmount = Number((taxableAmount * 0.025).toFixed(2));
    const sgstAmount = Number((taxableAmount * 0.025).toFixed(2));
    const taxAmount = Number((cgstAmount + sgstAmount).toFixed(2));
    const rawTotal = Number((taxableAmount + taxAmount).toFixed(2));
    const totalAmount = Math.round(rawTotal); // Petpooja nearest rupee round-off
    const roundOffAmount = Number((totalAmount - rawTotal).toFixed(2));

    return reply.send({
      subtotal,
      discountAmount,
      taxableAmount,
      cgstAmount,
      sgstAmount,
      taxAmount,
      totalAmount,
      roundOffAmount,
    });
  });

  // --- ADD ITEMS TO EXISTING ORDER (Table Top-up) ---
  fastify.post('/api/v1/orders/:orderId/add-items', async (req: FastifyRequest<{
    Params: { orderId: string };
    Body: { items: CreateOrderItemDTO[] };
  }>, reply: FastifyReply) => {
    const { orderId } = req.params;
    const { items } = req.body;

    const orderRes = await db.execute({ sql: 'SELECT * FROM orders WHERE id = ?', args: [orderId] });
    if (orderRes.rows.length === 0) return reply.status(404).send({ error: 'Order not found' });

    const order = orderRes.rows[0];
    let addedSubtotal = 0;

    const addedKotItems = [];

    for (const item of items) {
      const prodRes = await db.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [item.productId] });
      if (prodRes.rows.length === 0) continue;
      const prod = prodRes.rows[0];
      let addonTotal = 0;
      const resolvedAddons: { id: string; name: string; price: number }[] = [];
      if (item.addOnIds && item.addOnIds.length > 0) {
        for (const aid of item.addOnIds) {
          const addRes = await db.execute({ sql: 'SELECT price, name FROM add_ons WHERE id = ?', args: [aid] });
          if (addRes.rows.length > 0) {
            const addPrice = Number(addRes.rows[0].price);
            addonTotal += addPrice;
            resolvedAddons.push({ id: aid, name: String(addRes.rows[0].name), price: addPrice });
          }
        }
      }
      const unitPrice = Number(prod.base_price) + addonTotal;
      const lineTotal = unitPrice * item.quantity;
      addedSubtotal += lineTotal;
      const newOrderItemId = `oi-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

      await db.execute({
        sql: `INSERT INTO order_items (id, order_id, product_id, product_name_snapshot, unit_price_snapshot, quantity, line_total_snapshot, item_notes)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [newOrderItemId, orderId, item.productId, String(prod.name), unitPrice, item.quantity, lineTotal, item.itemNotes || null],
      });

      for (const rad of resolvedAddons) {
        await db.execute({
          sql: `INSERT INTO order_item_addons (id, order_item_id, addon_id, addon_name_snapshot, addon_price_snapshot)
                VALUES (?, ?, ?, ?, ?)`,
          args: [`oia-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, newOrderItemId, rad.id, rad.name, rad.price],
        });
      }

      addedKotItems.push({
        orderItemId: newOrderItemId,
        productName: String(prod.name),
        quantity: item.quantity,
        addons: resolvedAddons,
      });
    }

    const newSubtotal = Number(order.subtotal) + addedSubtotal;
    const newTaxable = newSubtotal - Number(order.discount_amount);
    const newTax = Number((newTaxable * 0.05).toFixed(2));
    const newTotal = Number((newTaxable + newTax).toFixed(2));

    await db.execute({
      sql: 'UPDATE orders SET subtotal = ?, taxable_amount = ?, tax_amount = ?, total_amount = ? WHERE id = ?',
      args: [newSubtotal, newTaxable, newTax, newTotal, orderId],
    });

    let latestKotNumber: string | undefined;
    // Generate supplementary KOT ticket for the kitchen
    if (addedKotItems.length > 0) {
      const outletId = String(order.outlet_id);
      const todayStr = new Date().toISOString().slice(0, 10);
      const kotSeq = await getNextSequence(`kot-${outletId}-${todayStr}`);
      const suppTicketId = `kot-${Date.now()}`;
      latestKotNumber = `KOT #${String(kotSeq).padStart(3, '0')} (Round 2)`;

      await db.execute({
        sql: `INSERT INTO kitchen_tickets (id, ticket_number, outlet_id, order_id, order_number_snapshot, order_type_snapshot, table_number_snapshot, customer_notes_snapshot)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [suppTicketId, latestKotNumber, outletId, orderId, String(order.order_number), String(order.order_type), order.table_number ? String(order.table_number) : null, 'Table Running Order Top-up'],
      });

      for (const ki of addedKotItems) {
        const kotItemId = `kti-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        await db.execute({
          sql: `INSERT INTO kitchen_ticket_items (id, ticket_id, order_item_id, product_name_snapshot, quantity)
                VALUES (?, ?, ?, ?, ?)`,
          args: [kotItemId, suppTicketId, ki.orderItemId, ki.productName, ki.quantity],
        });

        for (const ad of ki.addons) {
          await db.execute({
            sql: `INSERT INTO kitchen_ticket_item_addons (id, ticket_item_id, addon_name_snapshot)
                  VALUES (?, ?, ?)`,
            args: [`ktia-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, kotItemId, ad.name],
          });
        }
      }
    }

    const updatedRes = await db.execute({ sql: 'SELECT * FROM orders WHERE id = ?', args: [orderId] });
    const updOrder = updatedRes.rows[0];
    const allItemsRes = await db.execute({ sql: 'SELECT * FROM order_items WHERE order_id = ?', args: [orderId] });
    const allItems = [];
    for (const row of allItemsRes.rows) {
      const addonsRes = await db.execute({ sql: 'SELECT * FROM order_item_addons WHERE order_item_id = ?', args: [row.id] });
      allItems.push({
        id: String(row.id),
        productNameSnapshot: String(row.product_name_snapshot),
        unitPriceSnapshot: Number(row.unit_price_snapshot),
        quantity: Number(row.quantity),
        lineTotalSnapshot: Number(row.line_total_snapshot),
        itemNotes: row.item_notes ? String(row.item_notes) : undefined,
        addOns: addonsRes.rows.map((a) => ({
          id: String(a.addon_id),
          name: String(a.addon_name_snapshot),
          price: Number(a.addon_price_snapshot),
        })),
      });
    }

    return reply.send({
      id: String(updOrder.id),
      orderNumber: String(updOrder.order_number),
      kotNumber: latestKotNumber,
      orderType: String(updOrder.order_type),
      status: String(updOrder.status),
      customerName: updOrder.customer_name ? String(updOrder.customer_name) : undefined,
      customerPhone: updOrder.customer_phone ? String(updOrder.customer_phone) : undefined,
      tableNumber: updOrder.table_number ? String(updOrder.table_number) : undefined,
      subtotal: Number(updOrder.subtotal),
      discountAmount: Number(updOrder.discount_amount),
      taxableAmount: Number(updOrder.taxable_amount),
      taxAmount: Number(updOrder.tax_amount),
      totalAmount: Number(updOrder.total_amount),
      items: allItems,
      createdAt: toIsoString(updOrder.created_at),
    });
  });

  // --- UPDATE ORDER STATUS / CANCEL ORDER ---
  fastify.patch('/api/v1/orders/:id/status', async (req: FastifyRequest<{
    Params: { id: string };
    Body: { status: 'CONFIRMED' | 'PREPARING' | 'READY' | 'BILLED' | 'COMPLETED' | 'CANCELLED'; cancellationReason?: string };
  }>, reply: FastifyReply) => {
    const { id } = req.params;
    const { status, cancellationReason } = req.body;

    const orderRes = await db.execute({ sql: 'SELECT * FROM orders WHERE id = ?', args: [id] });
    if (orderRes.rows.length === 0) return reply.status(404).send({ error: 'Order not found' });
    const order = orderRes.rows[0];

    await db.execute({
      sql: "UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?",
      args: [status, id],
    });

    // If cancelled, free associated table and cancel kitchen tickets
    if (status === 'CANCELLED') {
      if (order.table_id) {
        await db.execute({
          sql: "UPDATE restaurant_tables SET status = 'AVAILABLE', active_order_id = NULL, updated_at = datetime('now') WHERE id = ?",
          args: [order.table_id],
        });
      }
      await db.execute({
        sql: "UPDATE kitchen_tickets SET status = 'CANCELLED', cancellation_reason = ?, updated_at = datetime('now') WHERE order_id = ?",
        args: [cancellationReason || 'Order Cancelled', id],
      });
      // Also record in void_audit_logs
      const voidId = `void-${Date.now()}`;
      await db.execute({
        sql: `INSERT INTO void_audit_logs (id, outlet_id, order_number, table_number, item_name, quantity, amount, original_waiter, manager_pin, reason)
              VALUES (?, ?, ?, ?, 'Entire Order Cancelled', 1, ?, 'Manager', '****1234', ?)`,
        args: [voidId, order.outlet_id, order.order_number, order.table_number || null, Number(order.total_amount), cancellationReason || 'Order Cancelled'],
      });
    }

    const updated = await db.execute({ sql: 'SELECT * FROM orders WHERE id = ?', args: [id] });
    return reply.send(updated.rows[0]);
  });
}
