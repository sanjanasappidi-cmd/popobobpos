import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../db/database.js';

function toIsoString(val: any): string {
  if (!val) return new Date().toISOString();
  if (val instanceof Date) return val.toISOString();
  const parsed = new Date(val);
  return !isNaN(parsed.getTime()) ? parsed.toISOString() : String(val);
}

async function getKitchenTicketResponse(ticketId: string): Promise<any> {
  const tRes = await db.execute({ sql: 'SELECT * FROM kitchen_tickets WHERE id = ?', args: [ticketId] });
  if (tRes.rows.length === 0) return null;
  const t = tRes.rows[0];

  const itemsRes = await db.execute({ sql: 'SELECT * FROM kitchen_ticket_items WHERE ticket_id = ?', args: [ticketId] });
  const items = [];

  for (const itemRow of itemsRes.rows) {
    const addonsRes = await db.execute({ sql: 'SELECT * FROM kitchen_ticket_item_addons WHERE ticket_item_id = ?', args: [itemRow.id] });
    items.push({
      id: String(itemRow.id),
      orderItemId: itemRow.order_item_id ? String(itemRow.order_item_id) : undefined,
      productNameSnapshot: String(itemRow.product_name_snapshot),
      variantNameSnapshot: itemRow.variant_name_snapshot ? String(itemRow.variant_name_snapshot) : undefined,
      quantity: Number(itemRow.quantity),
      status: String(itemRow.status),
      addOns: addonsRes.rows.map((a) => ({
        id: String(a.id),
        addOnNameSnapshot: String(a.addon_name_snapshot),
      })),
    });
  }

  return {
    id: String(t.id),
    ticketNumber: String(t.ticket_number),
    status: String(t.status),
    orderNumberSnapshot: String(t.order_number_snapshot),
    orderTypeSnapshot: String(t.order_type_snapshot),
    tableNumberSnapshot: t.table_number_snapshot ? String(t.table_number_snapshot) : undefined,
    customerNotesSnapshot: t.customer_notes_snapshot ? String(t.customer_notes_snapshot) : undefined,
    cancellationReason: t.cancellation_reason ? String(t.cancellation_reason) : undefined,
    items,
    createdAt: toIsoString(t.created_at),
    updatedAt: toIsoString(t.updated_at),
  };
}

export async function kitchenRoutes(fastify: FastifyInstance): Promise<void> {
  // --- GET KITCHEN TICKETS FOR OUTLET ---
  fastify.get('/api/v1/kitchen-tickets/outlet/:outletId', async (req: FastifyRequest<{
    Params: { outletId: string };
    Querystring: { status?: string; page?: string; size?: string };
  }>, reply: FastifyReply) => {
    const { outletId } = req.params;
    const { status } = req.query;

    let sql = 'SELECT * FROM kitchen_tickets WHERE outlet_id = ?';
    const args: any[] = [outletId];

    if (status) {
      sql += ' AND status = ?';
      args.push(status);
    }
    sql += ' ORDER BY created_at DESC LIMIT 50';

    const res = await db.execute({ sql, args });
    const content = [];

    for (const t of res.rows) {
      const ticketObj = await getKitchenTicketResponse(String(t.id));
      if (ticketObj) content.push(ticketObj);
    }

    return reply.send({
      content,
      totalElements: content.length,
      totalPages: 1,
      size: 50,
      number: 0,
    });
  });

  // --- GET ALL KITCHEN TICKETS (GLOBAL) ---
  fastify.get('/api/v1/kitchen-tickets', async (req: FastifyRequest<{
    Querystring: { status?: string; outletId?: string };
  }>, reply: FastifyReply) => {
    const { status, outletId } = req.query;
    let sql = 'SELECT * FROM kitchen_tickets';
    const args: any[] = [];
    const conditions: string[] = [];

    if (outletId) {
      conditions.push('outlet_id = ?');
      args.push(outletId);
    }
    if (status) {
      conditions.push('status = ?');
      args.push(status);
    }
    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' ORDER BY created_at DESC LIMIT 50';

    const res = await db.execute({ sql, args });
    const content = [];
    for (const t of res.rows) {
      const ticketObj = await getKitchenTicketResponse(String(t.id));
      if (ticketObj) content.push(ticketObj);
    }

    return reply.send({
      content,
      totalElements: content.length,
      totalPages: 1,
      size: 50,
      number: 0,
    });
  });

  // --- UPDATE KITCHEN TICKET STATUS ---
  fastify.patch('/api/v1/kitchen-tickets/:ticketId/status', async (req: FastifyRequest<{
    Params: { ticketId: string };
    Body: { status: string; cancellationReason?: string };
  }>, reply: FastifyReply) => {
    const { ticketId } = req.params;
    const { status, cancellationReason } = req.body;

    const existing = await db.execute({ sql: 'SELECT * FROM kitchen_tickets WHERE id = ?', args: [ticketId] });
    if (existing.rows.length === 0) return reply.status(404).send({ error: 'Ticket not found' });

    await db.execute({
      sql: "UPDATE kitchen_tickets SET status = ?, cancellation_reason = coalesce(?, cancellation_reason), updated_at = datetime('now') WHERE id = ?",
      args: [status, cancellationReason || null, ticketId],
    });

    // Also update item statuses
    await db.execute({
      sql: 'UPDATE kitchen_ticket_items SET status = ? WHERE ticket_id = ?',
      args: [status, ticketId],
    });

    const fullTicket = await getKitchenTicketResponse(ticketId);
    return reply.send(fullTicket);
  });

  // --- UPDATE SINGLE ITEM STATUS ON TICKET ---
  fastify.patch('/api/v1/kitchen-tickets/items/:itemId/status', async (req: FastifyRequest<{
    Params: { itemId: string };
    Body: { status: string };
  }>, reply: FastifyReply) => {
    const { itemId } = req.params;
    const { status } = req.body;

    const existing = await db.execute({ sql: 'SELECT * FROM kitchen_ticket_items WHERE id = ?', args: [itemId] });
    if (existing.rows.length === 0) return reply.status(404).send({ error: 'Item not found' });

    await db.execute({
      sql: 'UPDATE kitchen_ticket_items SET status = ? WHERE id = ?',
      args: [status, itemId],
    });

    const itemRes = await db.execute({ sql: 'SELECT * FROM kitchen_ticket_items WHERE id = ?', args: [itemId] });
    const itemRow = itemRes.rows[0];
    const addonsRes = await db.execute({ sql: 'SELECT * FROM kitchen_ticket_item_addons WHERE ticket_item_id = ?', args: [itemId] });

    return reply.send({
      id: String(itemRow.id),
      orderItemId: itemRow.order_item_id ? String(itemRow.order_item_id) : undefined,
      productNameSnapshot: String(itemRow.product_name_snapshot),
      variantNameSnapshot: itemRow.variant_name_snapshot ? String(itemRow.variant_name_snapshot) : undefined,
      quantity: Number(itemRow.quantity),
      status: String(itemRow.status),
      addOns: addonsRes.rows.map((a) => ({
        id: String(a.id),
        addOnNameSnapshot: String(a.addon_name_snapshot),
      })),
    });
  });
}
