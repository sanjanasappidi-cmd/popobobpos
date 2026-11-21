import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../db/database.js';
import { v4 as uuidv4 } from 'uuid';

export async function catalogRoutes(fastify: FastifyInstance): Promise<void> {
  // --- CATEGORIES ---
  fastify.get('/api/v1/categories', async (_req: FastifyRequest, reply: FastifyReply) => {
    const res = await db.execute('SELECT * FROM categories ORDER BY display_order ASC, created_at ASC');
    const categories = res.rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      description: row.description ? String(row.description) : undefined,
      displayOrder: Number(row.display_order),
      isActive: Boolean(row.is_active),
      subcategories: Array.isArray(row.subcategories)
        ? row.subcategories
        : (typeof row.subcategories === 'string' && row.subcategories.startsWith('[')
            ? JSON.parse(row.subcategories)
            : []),
    }));
    return reply.send(categories);
  });

  fastify.post('/api/v1/categories', async (req: FastifyRequest<{ Body: { name: string; description?: string; subcategories?: string[] } }>, reply: FastifyReply) => {
    const { name, description, subcategories } = req.body;
    if (!name?.trim()) {
      return reply.status(400).send({ error: 'Category name is required' });
    }

    const id = `cat-${Date.now()}`;
    const subcatsJson = subcategories && subcategories.length > 0 ? JSON.stringify(subcategories) : JSON.stringify([]);

    await db.execute({
      sql: 'INSERT INTO categories (id, name, description, subcategories) VALUES (?, ?, ?, ?)',
      args: [id, name.trim(), description || null, subcatsJson],
    });

    return reply.status(201).send({
      id,
      name: name.trim(),
      description,
      subcategories: subcategories || [],
      isActive: true,
      displayOrder: 1,
    });
  });

  fastify.patch('/api/v1/categories/:id/deactivate', async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { id } = req.params;
    const cat = await db.execute({ sql: 'SELECT * FROM categories WHERE id = ?', args: [id] });
    if (cat.rows.length === 0) {
      return reply.status(404).send({ error: 'Category not found' });
    }

    const currentActive = Boolean(cat.rows[0].is_active);
    const newActive = currentActive ? 0 : 1;
    await db.execute({ sql: 'UPDATE categories SET is_active = ? WHERE id = ?', args: [newActive, id] });

    return reply.send({
      id,
      name: cat.rows[0].name,
      isActive: Boolean(newActive),
    });
  });

  // --- PRODUCTS ---
  fastify.get('/api/v1/products', async (req: FastifyRequest<{ Querystring: { categoryId?: string } }>, reply: FastifyReply) => {
    const { categoryId } = req.query;

    let sql = `
      SELECT p.*, c.name as category_name, c.description as category_desc
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
    `;
    const args: any[] = [];

    if (categoryId && categoryId !== 'cat-all') {
      sql += ' WHERE p.category_id = ?';
      args.push(categoryId);
    }
    sql += ' ORDER BY p.created_at DESC';

    const res = await db.execute({ sql, args });

    // Fetch product add-ons
    const products = [];
    for (const row of res.rows) {
      const addonsRes = await db.execute({
        sql: `SELECT a.* FROM add_ons a
              INNER JOIN product_addons pa ON a.id = pa.addon_id
              WHERE pa.product_id = ? AND a.is_active`,
        args: [row.id],
      });

      const addOns = addonsRes.rows.map((a) => ({
        id: String(a.id),
        name: String(a.name),
        price: Number(a.price),
        isActive: Boolean(a.is_active),
        category: a.category ? String(a.category) : undefined,
        selectionType: a.selection_type as 'SINGLE' | 'MULTI',
      }));

      products.push({
        id: String(row.id),
        name: String(row.name),
        description: row.description ? String(row.description) : undefined,
        sku: row.sku ? String(row.sku) : undefined,
        basePrice: Number(row.base_price),
        imageUrl: row.image_url ? String(row.image_url) : undefined,
        badge: row.badge ? String(row.badge) : undefined,
        dietaryType: (row.dietary_type || 'BEVERAGE') as 'BEVERAGE' | 'VEG' | 'NON_VEG' | 'VEGAN',
        prepTimeMinutes: Number(row.prep_time_minutes || 5),
        subcategory: row.subcategory ? String(row.subcategory) : undefined,
        isActive: Boolean(row.is_active),
        category: {
          id: String(row.category_id),
          name: String(row.category_name || ''),
          description: row.category_desc ? String(row.category_desc) : undefined,
        },
        variants: [],
        addOns,
      });
    }

    return reply.send(products);
  });

  fastify.post('/api/v1/products', async (req: FastifyRequest<{
    Body: {
      name: string;
      basePrice: number;
      categoryId: string;
      subcategory?: string;
      description?: string;
      sku?: string;
      imageUrl?: string;
      badge?: string;
      dietaryType?: string;
      addOnIds?: string[];
    }
  }>, reply: FastifyReply) => {
    const { name, basePrice, categoryId, subcategory, description, sku, imageUrl, badge, dietaryType, addOnIds } = req.body;

    if (!name?.trim()) return reply.status(400).send({ error: 'Product name is required' });
    if (!basePrice || basePrice <= 0) return reply.status(400).send({ error: 'Valid base price is required' });
    if (!categoryId) return reply.status(400).send({ error: 'Category is required' });

    const id = `prod-${Date.now()}`;
    const generatedSku = sku || `TEA-${Math.floor(1000 + Math.random() * 9000)}`;

    await db.execute({
      sql: `INSERT INTO products (id, category_id, subcategory, name, description, sku, base_price, image_url, badge, dietary_type)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, categoryId, subcategory || null, name.trim(), description || null, generatedSku, basePrice, imageUrl || null, badge || null, dietaryType || 'BEVERAGE'],
    });

    if (addOnIds && addOnIds.length > 0) {
      for (const addonId of addOnIds) {
        await db.execute({
          sql: 'INSERT OR IGNORE INTO product_addons (product_id, addon_id) VALUES (?, ?)',
          args: [id, addonId],
        });
      }
    }

    return reply.status(201).send({
      id,
      name: name.trim(),
      basePrice,
      categoryId,
      subcategory,
      description,
      sku: generatedSku,
      imageUrl,
      badge,
      dietaryType,
      isActive: true,
      variants: [],
      addOns: [],
    });
  });

  fastify.put('/api/v1/products/:id', async (req: FastifyRequest<{
    Params: { id: string };
    Body: {
      name: string;
      basePrice: number;
      categoryId?: string;
      subcategory?: string;
      description?: string;
      sku?: string;
      imageUrl?: string;
      badge?: string;
      dietaryType?: string;
      addOnIds?: string[];
    }
  }>, reply: FastifyReply) => {
    const { id } = req.params;
    const { name, basePrice, categoryId, subcategory, description, sku, imageUrl, badge, dietaryType, addOnIds } = req.body;

    const existing = await db.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [id] });
    if (existing.rows.length === 0) {
      return reply.status(404).send({ error: 'Product not found' });
    }

    await db.execute({
      sql: `UPDATE products
            SET name = ?, base_price = ?, category_id = coalesce(?, category_id),
                subcategory = ?, description = ?, sku = coalesce(?, sku),
                image_url = ?, badge = ?, dietary_type = coalesce(?, dietary_type)
            WHERE id = ?`,
      args: [name.trim(), basePrice, categoryId || null, subcategory || null, description || null, sku || null, imageUrl || null, badge || null, dietaryType || null, id],
    });

    if (addOnIds) {
      await db.execute({ sql: 'DELETE FROM product_addons WHERE product_id = ?', args: [id] });
      for (const addonId of addOnIds) {
        await db.execute({
          sql: 'INSERT INTO product_addons (product_id, addon_id) VALUES (?, ?)',
          args: [id, addonId],
        });
      }
    }

    return reply.send({
      id,
      name: name.trim(),
      basePrice,
      categoryId,
      subcategory,
      imageUrl,
      badge,
      dietaryType,
      isActive: Boolean(existing.rows[0].is_active),
    });
  });

  fastify.delete('/api/v1/products/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { id } = req.params;
    try {
      await db.execute({ sql: 'DELETE FROM product_addons WHERE product_id = ?', args: [id] }).catch(() => {});
      await db.execute({ sql: 'DELETE FROM products WHERE id = ?', args: [id] });
      return reply.status(200).send({ success: true, deletedId: id });
    } catch (err: any) {
      return reply.status(500).send({ error: 'Failed to delete product: ' + err.message });
    }
  });

  fastify.patch('/api/v1/products/:id/deactivate', async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { id } = req.params;
    const prod = await db.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [id] });
    if (prod.rows.length === 0) return reply.status(404).send({ error: 'Product not found' });

    const newActive = Boolean(prod.rows[0].is_active) ? 0 : 1;
    await db.execute({ sql: 'UPDATE products SET is_active = ? WHERE id = ?', args: [newActive, id] });

    return reply.send({
      id,
      name: prod.rows[0].name,
      isActive: Boolean(newActive),
    });
  });

  // --- ADD-ONS ---
  fastify.get('/api/v1/addons', async (_req: FastifyRequest, reply: FastifyReply) => {
    const res = await db.execute('SELECT * FROM add_ons ORDER BY category ASC, price ASC');
    const addOns = res.rows.map((a) => ({
      id: String(a.id),
      name: String(a.name),
      price: Number(a.price),
      isActive: Boolean(a.is_active),
      category: a.category ? String(a.category) : undefined,
      selectionType: (a.selection_type || 'SINGLE') as 'SINGLE' | 'MULTI',
      minSelections: Number(a.min_selections || 1),
      maxSelections: Number(a.max_selections || 1),
    }));
    return reply.send(addOns);
  });

  fastify.post('/api/v1/addons', async (req: FastifyRequest<{
    Body: {
      name: string;
      price: number;
      category?: string;
      selectionType?: 'SINGLE' | 'MULTI';
      minSelections?: number;
      maxSelections?: number;
    }
  }>, reply: FastifyReply) => {
    const { name, price, category, selectionType, minSelections, maxSelections } = req.body;
    if (!name?.trim()) return reply.status(400).send({ error: 'Add-on name is required' });

    const id = `addon-${Date.now()}`;
    const resolvedMin = minSelections !== undefined ? minSelections : (selectionType === 'SINGLE' ? 1 : 0);
    const resolvedMax = maxSelections !== undefined ? maxSelections : (selectionType === 'SINGLE' ? 1 : 3);

    await db.execute({
      sql: `INSERT INTO add_ons (id, name, price, category, selection_type, min_selections, max_selections)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [id, name.trim(), price || 0, category || 'Choice Of Boba & Toppings', selectionType || 'MULTI', resolvedMin, resolvedMax],
    });

    return reply.status(201).send({
      id,
      name: name.trim(),
      price: price || 0,
      category: category || 'Choice Of Boba & Toppings',
      selectionType: selectionType || 'MULTI',
      isActive: true,
    });
  });

  fastify.delete('/api/v1/addons/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { id } = req.params;
    await db.execute({ sql: 'DELETE FROM add_ons WHERE id = ?', args: [id] });
    return reply.status(204).send();
  });

  fastify.patch('/api/v1/addons/:id/toggle', async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { id } = req.params;
    const addon = await db.execute({ sql: 'SELECT * FROM add_ons WHERE id = ?', args: [id] });
    if (addon.rows.length === 0) return reply.status(404).send({ error: 'Add-on not found' });

    const newActive = Boolean(addon.rows[0].is_active) ? 0 : 1;
    await db.execute({ sql: 'UPDATE add_ons SET is_active = ? WHERE id = ?', args: [newActive, id] });

    return reply.send({
      id,
      name: addon.rows[0].name,
      isActive: Boolean(newActive),
    });
  });

  fastify.put('/api/v1/products/:id/addons', async (req: FastifyRequest<{
    Params: { id: string };
    Body: { addOnIds: string[] }
  }>, reply: FastifyReply) => {
    const { id } = req.params;
    const { addOnIds } = req.body;

    await db.execute({ sql: 'DELETE FROM product_addons WHERE product_id = ?', args: [id] });
    for (const addonId of addOnIds) {
      await db.execute({
        sql: 'INSERT INTO product_addons (product_id, addon_id) VALUES (?, ?)',
        args: [id, addonId],
      });
    }

    return reply.send({ productId: id, addOnIds });
  });

  // --- CLEAR ALL DEMO DATA FOR FRESH PRODUCTION ---
  fastify.post('/api/v1/catalog/clear-all', async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      const tablesToClear = [
        'order_item_addons',
        'order_items',
        'payments',
        'bills',
        'kitchen_ticket_item_addons',
        'kitchen_ticket_items',
        'kitchen_tickets',
        'orders',
        'product_addons',
        'products',
        'add_ons',
        'categories',
      ];

      for (const tbl of tablesToClear) {
        try {
          await db.execute(`DELETE FROM ${tbl}`);
        } catch (e: any) {
          // Table might not exist or already be empty
        }
      }

      try {
        await db.execute("UPDATE sequences SET last_value = 0 WHERE name IN ('invoice_number', 'kot_number', 'order_number')");
      } catch {
        // ignore sequence reset error if table schema differs
      }

      return reply.send({
        success: true,
        message: 'All demo products, categories, orders, and reports have been permanently removed. System is ready for fresh real items.',
      });
    } catch (err: any) {
      return reply.status(500).send({ error: 'Failed to clear data: ' + err.message });
    }
  });
}
