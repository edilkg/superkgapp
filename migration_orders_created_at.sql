-- ==========================================================
-- МИГРАЦИЯ: Добавление created_at в таблицу orders
-- Необходима для точного учета смен, расчета дневной выручки
-- и фильтрации заказов в админ-панели TamakKG.
-- ==========================================================

ALTER TABLE orders 
ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

-- Индекс для быстрой выборки и сортировки заказов по времени
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);
