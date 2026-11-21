import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db, getNextSequence } from '../db/database.js';

export async function billingRoutes(fastify: FastifyInstance): Promise<void> {
  // --- ISSUE BILL (Gapless Sequential GST Invoice Generation) ---
  fastify.post('/api/v1/bills', async (req: FastifyRequest<{
    Body: { orderId: string; notes?: string }
  }>, reply: FastifyReply) => {
    const { orderId, notes } = req.body;

    if (!orderId) return reply.status(400).send({ error: 'Order ID is required' });

    // Check if bill already exists
    const existingBill = await db.execute({ sql: 'SELECT * FROM bills WHERE order_id = ?', args: [orderId] });
    if (existingBill.rows.length > 0) {
      return reply.send(await formatBillResponse(existingBill.rows[0]));
    }

    const orderRes = await db.execute({ sql: 'SELECT * FROM orders WHERE id = ?', args: [orderId] });
    if (orderRes.rows.length === 0) return reply.status(404).send({ error: 'Order not found' });

    const order = orderRes.rows[0];
    const outletId = String(order.outlet_id);
    const subtotal = Number(order.subtotal);
    const discountAmount = Number(order.discount_amount);
    const taxableAmount = Number(order.taxable_amount);

    // 5% Total GST (2.5% CGST + 2.5% SGST)
    const cgstAmount = Number((taxableAmount * 0.025).toFixed(2));
    const sgstAmount = Number((taxableAmount * 0.025).toFixed(2));
    const taxAmount = Number((cgstAmount + sgstAmount).toFixed(2));
    const rawTotal = Number((taxableAmount + taxAmount).toFixed(2));
    const totalAmount = Math.round(rawTotal); // Petpooja nearest rupee round-off

    // Sequential GST Invoice Number: POB-FLG-YYYY-0001
    const year = new Date().getFullYear();
    const seq = await getNextSequence(`bills-${outletId}-${year}`);
    const invoiceNumber = `POB-FLG-${year}-${String(seq).padStart(4, '0')}`;
    const billId = `bill-${Date.now()}`;

    await db.execute({
      sql: `INSERT INTO bills (id, order_id, outlet_id, invoice_number, subtotal, discount_amount, taxable_amount, cgst_rate, cgst_amount, sgst_rate, sgst_amount, tax_amount, total_amount, paid_amount, status, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, 2.5, ?, 2.5, ?, ?, ?, 0.0, 'ISSUED', ?)`,
      args: [billId, orderId, outletId, invoiceNumber, subtotal, discountAmount, taxableAmount, cgstAmount, sgstAmount, taxAmount, totalAmount, notes || null],
    });

    const bill = await db.execute({ sql: 'SELECT * FROM bills WHERE id = ?', args: [billId] });
    return reply.status(201).send(await formatBillResponse(bill.rows[0]));
  });

  // --- GET BILL BY ORDER ID ---
  fastify.get('/api/v1/bills/order/:orderId', async (req: FastifyRequest<{ Params: { orderId: string } }>, reply: FastifyReply) => {
    const { orderId } = req.params;
    const res = await db.execute({ sql: 'SELECT * FROM bills WHERE order_id = ?', args: [orderId] });
    if (res.rows.length === 0) return reply.status(404).send({ error: 'Bill not found' });

    return reply.send(await formatBillResponse(res.rows[0]));
  });

  // --- GET ALL BILLS (GLOBAL OR OUTLET FILTERED) ---
  fastify.get('/api/v1/bills', async (req: FastifyRequest<{ Querystring: { outletId?: string } }>, reply: FastifyReply) => {
    const { outletId } = req.query;
    let sql = 'SELECT * FROM bills';
    const args: any[] = [];
    if (outletId) {
      sql += ' WHERE outlet_id = ?';
      args.push(outletId);
    }
    sql += ' ORDER BY created_at DESC LIMIT 100';
    const res = await db.execute({ sql, args });
    const bills = [];
    for (const b of res.rows) {
      bills.push(await formatBillResponse(b));
    }
    return reply.send(bills);
  });

  // --- GET BILLS FOR OUTLET ---
  fastify.get('/api/v1/bills/outlet/:outletId', async (req: FastifyRequest<{ Params: { outletId: string } }>, reply: FastifyReply) => {
    const { outletId } = req.params;
    const res = await db.execute({
      sql: 'SELECT * FROM bills WHERE outlet_id = ? ORDER BY created_at DESC LIMIT 100',
      args: [outletId],
    });

    const bills = [];
    for (const b of res.rows) {
      bills.push(await formatBillResponse(b));
    }
    return reply.send(bills);
  });

  // --- RECORD PAYMENT ---
  fastify.post('/api/v1/bills/payments', async (req: FastifyRequest<{
    Body: {
      billId: string;
      amount: number;
      paymentMethod: 'CASH' | 'UPI' | 'CARD' | 'OTHER';
      idempotencyKey?: string;
      transactionReference?: string;
    }
  }>, reply: FastifyReply) => {
    const { billId, amount, paymentMethod, idempotencyKey, transactionReference } = req.body;

    if (!billId || !amount || amount <= 0) {
      return reply.status(400).send({ error: 'Bill ID and valid payment amount are required' });
    }

    const billRes = await db.execute({ sql: 'SELECT * FROM bills WHERE id = ?', args: [billId] });
    if (billRes.rows.length === 0) return reply.status(404).send({ error: 'Bill not found' });

    const bill = billRes.rows[0];
    const paymentId = `pay-${Date.now()}`;

    await db.execute({
      sql: `INSERT INTO payments (id, bill_id, amount, payment_method, status, idempotency_key, transaction_reference)
            VALUES (?, ?, ?, ?, 'SUCCESSFUL', ?, ?)`,
      args: [paymentId, billId, amount, paymentMethod, idempotencyKey || null, transactionReference || null],
    });

    const newPaidAmount = Number((Number(bill.paid_amount) + amount).toFixed(2));
    const totalAmount = Number(bill.total_amount);
    const isFullyPaid = newPaidAmount >= totalAmount - 0.05;
    const newStatus = isFullyPaid ? 'PAID' : 'PARTIALLY_PAID';

    await db.execute({
      sql: `UPDATE bills SET paid_amount = ?, status = ?, settled_at = CASE WHEN ? = 'PAID' THEN datetime('now') ELSE settled_at END WHERE id = ?`,
      args: [newPaidAmount, newStatus, newStatus, billId],
    });

    // If fully paid, mark order as BILLED and free restaurant table
    if (isFullyPaid) {
      const orderId = String(bill.order_id);
      await db.execute({
        sql: "UPDATE orders SET status = 'BILLED' WHERE id = ?",
        args: [orderId],
      });

      // Release table if any
      await db.execute({
        sql: "UPDATE tables SET status = 'AVAILABLE', current_order_id = NULL WHERE current_order_id = ?",
        args: [orderId],
      });
    }

    return reply.status(201).send({
      id: paymentId,
      billId,
      amount,
      paymentMethod,
      status: 'SUCCESSFUL',
      createdAt: new Date().toISOString(),
    });
  });

  // --- UPDATE PAYMENT STATUS ---
  fastify.patch('/api/v1/bills/payments/:paymentId/status', async (req: FastifyRequest<{
    Params: { paymentId: string };
    Body: { status: 'SUCCESSFUL' | 'FAILED' | 'REFUNDED'; failureReason?: string; refundReason?: string };
  }>, reply: FastifyReply) => {
    const { paymentId } = req.params;
    const { status } = req.body;
    await db.execute({
      sql: 'UPDATE payments SET status = ? WHERE id = ?',
      args: [status || 'SUCCESSFUL', paymentId],
    });
    return reply.send({ id: paymentId, status: status || 'SUCCESSFUL' });
  });
}

function toIsoString(val: any): string {
  if (!val) return new Date().toISOString();
  if (val instanceof Date) return val.toISOString();
  const parsed = new Date(val);
  return !isNaN(parsed.getTime()) ? parsed.toISOString() : String(val);
}

async function formatBillResponse(row: any): Promise<any> {
  const paymentsRes = await db.execute({ sql: 'SELECT * FROM payments WHERE bill_id = ?', args: [row.id] });
  const orderRes = await db.execute({ sql: 'SELECT * FROM orders WHERE id = ?', args: [row.order_id] });

  const itemsRes = await db.execute({ sql: 'SELECT * FROM order_items WHERE order_id = ?', args: [row.order_id] });

  let orderSnapshot = undefined;
  if (orderRes.rows.length > 0) {
    const o = orderRes.rows[0];
    orderSnapshot = {
      id: String(o.id),
      orderNumber: String(o.order_number),
      orderType: o.order_type ? String(o.order_type) : undefined,
      customerName: o.customer_name ? String(o.customer_name) : undefined,
      customerPhone: o.customer_phone ? String(o.customer_phone) : undefined,
      tableNumber: o.table_number ? String(o.table_number) : undefined,
      items: itemsRes.rows.map((r) => ({
        id: String(r.id),
        productId: String(r.product_id),
        productNameSnapshot: String(r.product_name_snapshot),
        variantNameSnapshot: r.variant_name_snapshot ? String(r.variant_name_snapshot) : undefined,
        unitPriceSnapshot: Number(r.unit_price_snapshot),
        quantity: Number(r.quantity),
        lineTotalSnapshot: Number(r.line_total_snapshot),
        itemNotes: r.item_notes ? String(r.item_notes) : undefined,
      })),
    };
  }

  return {
    id: String(row.id),
    orderId: String(row.order_id),
    order: orderSnapshot,
    invoiceNumber: String(row.invoice_number),
    customerName: orderSnapshot?.customerName,
    customerPhone: orderSnapshot?.customerPhone,
    subtotal: Number(row.subtotal),
    discountAmount: Number(row.discount_amount),
    taxableAmount: Number(row.taxable_amount),
    cgstAmount: Number(row.cgst_amount),
    sgstAmount: Number(row.sgst_amount),
    taxAmount: Number(row.tax_amount),
    roundOffAmount: Number((Number(row.total_amount) - (Number(row.taxable_amount) + Number(row.tax_amount))).toFixed(2)),
    totalAmount: Number(row.total_amount),
    paidAmount: Number(row.paid_amount),
    status: String(row.status),
    notes: row.notes ? String(row.notes) : undefined,
    payments: paymentsRes.rows.map((p) => ({
      id: String(p.id),
      amount: Number(p.amount),
      paymentMethod: String(p.payment_method),
      status: String(p.status),
      transactionReference: p.transaction_reference ? String(p.transaction_reference) : undefined,
      createdAt: toIsoString(p.created_at),
    })),
    createdAt: toIsoString(row.created_at),
    settledAt: row.settled_at ? toIsoString(row.settled_at) : undefined,
  };
}
