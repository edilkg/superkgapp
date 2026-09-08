-- ====================================================================
-- МИГРАЦИЯ ДЛЯ ТАБЛИЦЫ ДИНАМИЧЕСКИХ ТАРИФОВ И ЗОН ДОСТАВКИ TAMAKKG
-- Выполните этот SQL в Supabase -> SQL Editor -> New query -> Run
-- ====================================================================

-- 1. Создаем таблицу delivery_settings
CREATE TABLE IF NOT EXISTS delivery_settings (
    key text PRIMARY KEY,
    value jsonb NOT NULL,
    updated_at timestamptz DEFAULT now()
);

-- 2. Включаем RLS (Row Level Security)
ALTER TABLE delivery_settings ENABLE ROW LEVEL SECURITY;

-- 3. Политики доступа для анонимного и публичного использования
DROP POLICY IF EXISTS "Allow public read" ON delivery_settings;
CREATE POLICY "Allow public read" ON delivery_settings FOR SELECT USING (true);

DROP POLICY IF EXISTS "Allow public insert" ON delivery_settings;
CREATE POLICY "Allow public insert" ON delivery_settings FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "Allow public update" ON delivery_settings;
CREATE POLICY "Allow public update" ON delivery_settings FOR UPDATE USING (true) WITH CHECK (true);

-- 4. Первичная инициализация конфигурации тарифов и геозон Бишкека
INSERT INTO delivery_settings (key, value, updated_at)
VALUES (
    'tariff_config',
    '{
        "rateCity": 17,
        "rateOutOfTown": 29,
        "rateSuper": 43,
        "baseFee": 150,
        "nightFee": 50,
        "nightFeeDeep": 50,
        "nightTariffEnabled": true,
        "deepNightTariffEnabled": true,
        "doorFee": 50,
        "yardMultiplier": 1.05,
        "calcMode": "split",
        "cityNorth": 4.0,
        "cityEast": 10.0,
        "citySouth": 8.0,
        "cityWest": 4.6,
        "maxNorth": 11.0,
        "corridorNorthWest": 4.4,
        "corridorNorthEast": 12.0,
        "redZoneNorth": 6.0,
        "purpleZoneNorth": 8.0,
        "maxEast": 19.0,
        "corridorEastNorth": 2.1,
        "corridorEastSouth": 8.5,
        "redZoneEast": 11.0,
        "purpleZoneEast": 17.5,
        "maxWest": 12.0,
        "corridorWestNorth": 2.5,
        "corridorWestSouth": 2.5,
        "redZoneWest": 6.0,
        "purpleZoneWest": 9.0,
        "maxSouth": 18.5,
        "corridorSouthWest": 6.0,
        "corridorSouthEast": 11.0,
        "redZoneSouth": 7.2,
        "purpleZoneSouth": 10.0
    }'::jsonb,
    now()
)
ON CONFLICT (key) DO NOTHING;
