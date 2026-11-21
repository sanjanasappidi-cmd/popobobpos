import pg from 'pg';
const { Pool } = pg;
import dotenv from 'dotenv';
dotenv.config();

export interface QueryResultRow {
  [column: string]: any;
}

export interface PgExecutionResult {
  rows: QueryResultRow[];
  rowCount?: number | null;
}

export class PgDatabase {
  private pool: pg.Pool | null = null;
  private isConnected = false;

  constructor() {
    this.initPool();
  }

  private initPool() {
    const connectionString =
      process.env.DATABASE_URL ||
      (process.env as any)['DATABASE_URL.'] ||
      `postgresql://${process.env.PGUSER || 'postgres'}:${encodeURIComponent(process.env.PGPASSWORD || 'postgres')}@${process.env.PGHOST || 'localhost'}:${process.env.PGPORT || '5432'}/${process.env.PGDATABASE || 'pob_pos'}`;

    const isRemote =
      connectionString.includes('dpg-') ||
      connectionString.includes('render.com') ||
      connectionString.includes('neon.tech') ||
      connectionString.includes('supabase.co') ||
      connectionString.includes('railway') ||
      connectionString.includes('sslmode=require') ||
      process.env.PGSSLMODE === 'require' ||
      (!connectionString.includes('127.0.0.1') && !connectionString.includes('localhost') && Boolean(process.env.DATABASE_URL));

    this.pool = new Pool({
      connectionString,
      ssl: isRemote ? { rejectUnauthorized: false } : undefined,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    this.pool.on('error', (err) => {
      console.error('[PostgreSQL Pool Error]:', err.message);
    });
  }

  public getPool(): pg.Pool {
    if (!this.pool) {
      this.initPool();
    }
    return this.pool!;
  }

  /**
   * Helper that converts SQL with `?` parameter markers into PostgreSQL `$1, $2, $3` syntax
   */
  public convertParamMarkers(sql: string): string {
    let index = 1;
    return sql.replace(/\?/g, () => `$${index++}`);
  }

  /**
   * Universal execute method matching the LibSQL/database.ts interface:
   * Accepts both execute(sql) and execute({ sql, args })
   */
  public async execute(
    statement: string | { sql: string; args?: any[] }
  ): Promise<PgExecutionResult> {
    const pool = this.getPool();

    let sql = typeof statement === 'string' ? statement : statement.sql;
    let args = typeof statement === 'string' ? [] : statement.args || [];

    // Transform SQLite syntax to PostgreSQL where applicable
    sql = sql.replace(/datetime\('now'\)/gi, 'NOW()');
    sql = sql.replace(/is_active\s*=\s*1\b/gi, 'is_active = true');
    sql = sql.replace(/is_active\s*=\s*0\b/gi, 'is_active = false');
    if (/INSERT\s+OR\s+IGNORE\s+INTO/i.test(sql)) {
      sql = sql.replace(/INSERT\s+OR\s+IGNORE\s+INTO/gi, 'INSERT INTO');
      if (!/ON\s+CONFLICT/i.test(sql)) {
        sql += ' ON CONFLICT DO NOTHING';
      }
    }
    sql = this.convertParamMarkers(sql);

    const res = await pool.query(sql, args);
    return {
      rows: res.rows,
      rowCount: res.rowCount,
    };
  }

  public async testConnection(): Promise<boolean> {
    try {
      const res = await this.execute('SELECT 1 as connected');
      this.isConnected = res.rows.length > 0;
      return this.isConnected;
    } catch (err: any) {
      this.isConnected = false;
      return false;
    }
  }

  public async ensureDatabaseExists(): Promise<void> {
    const targetDb = process.env.PGDATABASE || 'pob_pos';
    if (process.env.DATABASE_URL || (process.env as any)['DATABASE_URL.'] || targetDb === 'postgres') return;

    const adminClient = new pg.Client({
      host: process.env.PGHOST || 'localhost',
      port: Number(process.env.PGPORT || 5432),
      user: process.env.PGUSER || 'postgres',
      password: process.env.PGPASSWORD || 'postgres',
      database: 'postgres',
    });

    try {
      await adminClient.connect();
      const check = await adminClient.query(
        'SELECT 1 FROM pg_database WHERE datname = $1',
        [targetDb]
      );
      if (check.rows.length === 0) {
        await adminClient.query(`CREATE DATABASE "${targetDb}"`);
        console.log(`[PostgreSQL] Database "${targetDb}" created successfully.`);
      }
    } catch (err: any) {
      console.warn(`[PostgreSQL] Note on database check for "${targetDb}":`, err.message);
    } finally {
      await adminClient.end().catch(() => {});
    }
  }

  public async initSchema(): Promise<void> {
    await this.ensureDatabaseExists();
    const pool = this.getPool();

    // 1. OUTLETS
    await pool.query(`
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
    `);

    // 2. CATEGORIES
    await pool.query(`
      CREATE TABLE IF NOT EXISTS categories (
        id VARCHAR(64) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        display_order INT DEFAULT 1,
        is_active BOOLEAN DEFAULT TRUE,
        subcategories JSONB DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // 3. ADDONS / TOPPINGS / MODIFIERS
    await pool.query(`
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
    `);

    // 4. PRODUCTS / MENU ITEMS
    await pool.query(`
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
    `);

    // 5. PRODUCT ADDON MAPPINGS
    await pool.query(`
      CREATE TABLE IF NOT EXISTS product_addons (
        product_id VARCHAR(64) NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        addon_id VARCHAR(64) NOT NULL REFERENCES add_ons(id) ON DELETE CASCADE,
        PRIMARY KEY (product_id, addon_id)
      );
    `);

    // 6. RESTAURANT TABLES
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tables (
        id VARCHAR(64) PRIMARY KEY,
        outlet_id VARCHAR(64) NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
        table_number VARCHAR(32) NOT NULL,
        capacity INT DEFAULT 4,
        status VARCHAR(32) DEFAULT 'AVAILABLE',
        current_order_id VARCHAR(64),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // 7. SEQUENCES (Gapless numbering engine)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sequences (
        name VARCHAR(128) PRIMARY KEY,
        last_value BIGINT DEFAULT 0
      );
    `);

    // 8. ORDERS
    await pool.query(`
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
    `);

    // 9. ORDER ITEMS
    await pool.query(`
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
    `);

    // 10. ORDER ITEM ADDONS
    await pool.query(`
      CREATE TABLE IF NOT EXISTS order_item_addons (
        id VARCHAR(64) PRIMARY KEY,
        order_item_id VARCHAR(64) NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
        addon_id VARCHAR(64) NOT NULL,
        addon_name_snapshot VARCHAR(255) NOT NULL,
        addon_price_snapshot NUMERIC(10, 2) NOT NULL DEFAULT 0.00
      );
    `);

    // 11. BILLS / INVOICES (GST Tax Compliant)
    await pool.query(`
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
    `);

    // 12. PAYMENTS
    await pool.query(`
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
    `);

    // 13. KITCHEN ORDER TICKETS (KOT)
    await pool.query(`
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
    `);

    // 14. KITCHEN TICKET ITEMS
    await pool.query(`
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
    `);

    // 15. KITCHEN TICKET ITEM ADDONS
    await pool.query(`
      CREATE TABLE IF NOT EXISTS kitchen_ticket_item_addons (
        id VARCHAR(64) PRIMARY KEY,
        ticket_item_id VARCHAR(64) NOT NULL REFERENCES kitchen_ticket_items(id) ON DELETE CASCADE,
        addon_name_snapshot VARCHAR(255) NOT NULL
      );
    `);

    // Seed initial data if empty
    const check = await pool.query('SELECT COUNT(*) as count FROM outlets');
    if (Number(check.rows[0].count) === 0) {
      await this.seedData();
    }
  }

  public async seedData(): Promise<void> {
    const pool = this.getPool();

    // Outlets (Only seed the flagship outlet so system has an active store)
    await pool.query(`
      INSERT INTO outlets (id, name, code, address, phone, manager_name, payment_policy)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (id) DO NOTHING
    `, [
      'outlet-demo-flagship',
      'POP O\' BOB - Flagship Film Nagar',
      'POB-FN-01',
      '407, Mezzanine, Road No 81, Film Nagar, Hyderabad, Telangana 500096',
      '+91 98765 43210',
      'Arjun Varma',
      'FLEXIBLE'
    ]);
    // Tables
    for (let i = 1; i <= 8; i++) {
      await pool.query(`
        INSERT INTO tables (id, outlet_id, table_number, capacity, status)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (id) DO NOTHING
      `, [`tbl-fn-${i}`, 'outlet-demo-flagship', `T${i}`, i <= 2 ? 2 : (i <= 6 ? 4 : 6), 'AVAILABLE']);
    }

    console.log('[PostgreSQL] Outlets and tables initialized (clean catalog ready for real items).');
  }

  public async getNextSequence(sequenceName: string): Promise<number> {
    const pool = this.getPool();
    const res = await pool.query(
      `INSERT INTO sequences (name, last_value)
       VALUES ($1, 1)
       ON CONFLICT (name) DO UPDATE SET last_value = sequences.last_value + 1
       RETURNING last_value`,
      [sequenceName]
    );
    return Number(res.rows[0].last_value);
  }
}

export const pgDatabase = new PgDatabase();
