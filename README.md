# Pop O' Bob POS - Production Fastify Backend API

High-performance, low-latency Node.js & TypeScript Fastify backend API for the Pop O' Bob Restaurant Point of Sale system. Supports both PostgreSQL (Neon DB / Railway) and SQLite (WAL mode).

---

## 🚀 Cloud Deployment (Railway)

1. **Deploy Repository**: Connect this repository to your Railway project.
2. **Environment Variables**:
   - `DATABASE_URL`: Your Neon DB PostgreSQL connection string (use pooled connection string).
   - `DATABASE_TYPE`: `postgres`
   - `NODE_ENV`: `production`
   - `PORT`: `8080` (or Railway dynamic `$PORT`)
   - `HOST`: `0.0.0.0`
   - `CORS_ORIGIN`: `*` (or your frontend domain, e.g. `https://pos.krunnex.in`)

---

## 🛠️ Local Development

```bash
# Install dependencies
npm install

# Run TypeScript build
npm run build

# Start development server with live reload
npm run dev

# Run PostgreSQL schema migration
npm run db:migrate

# Start production server
npm start
```

---

## 📡 API Endpoints

- `GET /health`: Health status, active database engine, memory usage, uptime
- `GET /api/v1/catalog`: Menu catalog, categories, products, modifiers/toppings
- `POST /api/v1/orders`: Create dining / takeout order
- `POST /api/v1/orders/:id/items`: Add items/rounds to existing active order
- `POST /api/v1/orders/settle`: Settle bill with payment mode & sequential invoice generation
- `GET /api/v1/reports/sales`: Real-time sales report & timeline analytics
- `GET /api/v1/reports/void-logs`: Item alteration and cancellation audit trail
