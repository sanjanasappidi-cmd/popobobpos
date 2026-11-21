import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../db/database.js';

export async function outletRoutes(fastify: FastifyInstance): Promise<void> {
  // --- OUTLETS ---
  fastify.get('/api/v1/outlets', async (_req: FastifyRequest, reply: FastifyReply) => {
    const res = await db.execute('SELECT * FROM outlets ORDER BY created_at ASC');
    const outlets = res.rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      code: row.code ? String(row.code) : undefined,
      address: row.address ? String(row.address) : undefined,
      phone: row.phone ? String(row.phone) : undefined,
      managerName: row.manager_name ? String(row.manager_name) : undefined,
      paymentPolicy: (row.payment_policy || 'FLEXIBLE') as 'FLEXIBLE' | 'PAY_FIRST' | 'PAY_AFTER',
    }));
    return reply.send(outlets);
  });

  fastify.post('/api/v1/outlets', async (req: FastifyRequest<{
    Body: {
      name: string;
      code?: string;
      address?: string;
      phone?: string;
      managerName?: string;
      paymentPolicy?: string;
    }
  }>, reply: FastifyReply) => {
    const { name, code, address, phone, managerName, paymentPolicy } = req.body;
    if (!name?.trim()) return reply.status(400).send({ error: 'Outlet name is required' });

    const id = `outlet-${Date.now()}`;
    await db.execute({
      sql: `INSERT INTO outlets (id, name, code, address, phone, manager_name, payment_policy)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [id, name.trim(), code || null, address || null, phone || null, managerName || null, paymentPolicy || 'FLEXIBLE'],
    });

    return reply.status(201).send({
      id,
      name: name.trim(),
      code,
      address,
      phone,
      managerName,
      paymentPolicy: paymentPolicy || 'FLEXIBLE',
    });
  });

  fastify.patch('/api/v1/outlets/:id/payment-policy', async (req: FastifyRequest<{
    Params: { id: string };
    Querystring: { policy: string };
  }>, reply: FastifyReply) => {
    const { id } = req.params;
    const { policy } = req.query;

    await db.execute({
      sql: 'UPDATE outlets SET payment_policy = ? WHERE id = ?',
      args: [policy, id],
    });

    const res = await db.execute({ sql: 'SELECT * FROM outlets WHERE id = ?', args: [id] });
    if (res.rows.length === 0) return reply.status(404).send({ error: 'Outlet not found' });

    const o = res.rows[0];
    return reply.send({
      id: String(o.id),
      name: String(o.name),
      paymentPolicy: String(o.payment_policy),
    });
  });

  // --- RESTAURANT TABLES ---
  const handleGetTables = async (req: FastifyRequest<{ Params: { outletId: string } }>, reply: FastifyReply) => {
    const { outletId } = req.params;
    const res = await db.execute({
      sql: `
        SELECT 
          t.id, t.outlet_id, t.table_number, t.capacity, t.status, t.current_order_id,
          o.order_number, o.total_amount, o.subtotal, o.created_at as order_created_at
        FROM tables t
        LEFT JOIN orders o ON t.current_order_id = o.id
        WHERE t.outlet_id = ?
        ORDER BY t.table_number ASC
      `,
      args: [outletId],
    });

    const tables = await Promise.all(
      res.rows.map(async (row) => {
        const currentOrderId = row.current_order_id ? String(row.current_order_id) : undefined;
        let items: { name: string; variant?: string; quantity: number; lineTotal?: number }[] = [];

        if (currentOrderId) {
          try {
            const itemRes = await db.execute({
              sql: 'SELECT product_name_snapshot, variant_name_snapshot, quantity, line_total_snapshot FROM order_items WHERE order_id = ?',
              args: [currentOrderId],
            });
            items = itemRes.rows.map((ir) => ({
              name: String(ir.product_name_snapshot),
              variant: ir.variant_name_snapshot ? String(ir.variant_name_snapshot) : undefined,
              quantity: Number(ir.quantity),
              lineTotal: Number(ir.line_total_snapshot),
            }));
          } catch (e) {
            console.warn('Failed to load table items:', e);
          }
        }

        const orderTotal = row.total_amount != null ? Number(row.total_amount) : 0;
        const durationMinutes = row.order_created_at
          ? Math.max(1, Math.round((Date.now() - new Date(String(row.order_created_at)).getTime()) / 60000))
          : undefined;

        return {
          id: String(row.id),
          outletId: String(row.outlet_id),
          tableNumber: String(row.table_number),
          capacity: Number(row.capacity),
          status: String(row.status),
          currentOrderId,
          orderNumber: row.order_number ? String(row.order_number) : undefined,
          currentTotal: orderTotal,
          amountDue: orderTotal,
          durationMinutes,
          items,
        };
      })
    );

    return reply.send(tables);
  };

  fastify.get('/api/v1/tables/outlet/:outletId', handleGetTables);
  fastify.get('/api/v1/outlets/:outletId/tables', handleGetTables);

  fastify.post('/api/v1/tables', async (req: FastifyRequest<{
    Body: { tableNumber: string; capacity?: number; outletId?: string }
  }>, reply: FastifyReply) => {
    const { tableNumber, capacity, outletId } = req.body;
    const targetOutletId = outletId || 'outlet-demo-flagship';
    const id = `tbl-${Date.now()}`;

    await db.execute({
      sql: 'INSERT INTO tables (id, outlet_id, table_number, capacity) VALUES (?, ?, ?, ?)',
      args: [id, targetOutletId, tableNumber, capacity || 4],
    });

    return reply.status(201).send({
      id,
      tableNumber,
      capacity: capacity || 4,
      status: 'AVAILABLE',
    });
  });

  fastify.patch('/api/v1/tables/:id/status', async (req: FastifyRequest<{
    Params: { id: string };
    Body: { status: string };
  }>, reply: FastifyReply) => {
    const { id } = req.params;
    const { status } = req.body;

    await db.execute({
      sql: 'UPDATE tables SET status = ? WHERE id = ?',
      args: [status, id],
    });

    const res = await db.execute({ sql: 'SELECT * FROM tables WHERE id = ?', args: [id] });
    if (res.rows.length === 0) return reply.status(404).send({ error: 'Table not found' });

    return reply.send({
      id,
      status,
    });
  });

  fastify.delete('/api/v1/tables/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { id } = req.params;
    await db.execute({ sql: 'DELETE FROM tables WHERE id = ?', args: [id] });
    return reply.status(204).send();
  });
}
