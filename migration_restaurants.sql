-- ==========================================================
-- МИГРАЦИЯ: Расширение таблицы restaurants для TamakKG
-- Добавляет поддержку городов (Бишкек / Чолпон-Ата), координаты,
-- графики работы, логотипы и порядок сортировки.
-- ==========================================================

-- 1. Добавление колонок
ALTER TABLE restaurants 
ADD COLUMN IF NOT EXISTS lat float8,
ADD COLUMN IF NOT EXISTS lon float8,
ADD COLUMN IF NOT EXISTS city text DEFAULT 'Бишкек',
ADD COLUMN IF NOT EXISTS address text DEFAULT '',
ADD COLUMN IF NOT EXISTS hours text DEFAULT '10:00 - 22:00',
ADD COLUMN IF NOT EXISTS logo text DEFAULT '',
ADD COLUMN IF NOT EXISTS img text DEFAULT '',
ADD COLUMN IF NOT EXISTS tags jsonb DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS categories_order jsonb DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS sort_order integer DEFAULT 100,
ADD COLUMN IF NOT EXISTS is_active boolean DEFAULT true;

-- Индекс для быстрой фильтрации по городу и активности
CREATE INDEX IF NOT EXISTS idx_restaurants_city_active ON restaurants(city, is_active, is_approved);

-- 2. Перенос (Backfill) существующих заведений из Чолпон-Аты и Бишкека

-- 1. Кунжут Фаст Фуд (8958317669)
UPDATE restaurants SET
    name = 'Кунжут Фаст Фуд',
    city = 'Чолпон-Ата',
    address = 'ул. Советская, 67в',
    phone = '+996505696970',
    hours = '09:00 - 22:00',
    lat = 42.650075,
    lon = 77.086667,
    logo = 'https://dtxybpdjbdmqrvsdwvvk.supabase.co/storage/v1/object/public/icons/KUNJUT%20MINI%20LOG.png',
    img = 'https://dtxybpdjbdmqrvsdwvvk.supabase.co/storage/v1/object/public/icons/KUNJUT%20BIGLOGO.jpg',
    tags = '["burgers", "sushi", "shawarma", "pizza"]'::jsonb,
    categories_order = '["Шаурма", "Бургеры", "Курочка", "Пицца", "Сеты", "Напитки", "Суши"]'::jsonb,
    sort_order = 1,
    is_active = true,
    is_approved = true
WHERE id = 8958317669;

-- 2. Шашлык Парк (8905203649)
UPDATE restaurants SET
    name = 'Шашлык Парк',
    city = 'Чолпон-Ата',
    address = 'ул. Советская, 132',
    phone = '+996997800988',
    hours = '10:00 - 22:00',
    lat = 42.64584,
    lon = 77.076624,
    logo = 'https://dtxybpdjbdmqrvsdwvvk.supabase.co/storage/v1/object/public/icons/shaskykparkmninlog.png',
    img = 'https://dtxybpdjbdmqrvsdwvvk.supabase.co/storage/v1/object/public/icons/shashlyk%20biglogo%20(1).jpeg',
    tags = '["shashlik", "pizza", "desserts"]'::jsonb,
    categories_order = '["Шашлыки", "Ассорти", "Стейки", "Напитки", "Закуски", "Горячие закуски", "Пиццы", "Десерты", "Супы", "Вторые блюда", "Салаты", "Пасты", "Соусы"]'::jsonb,
    sort_order = 2,
    is_active = true,
    is_approved = true
WHERE id = 8905203649;

-- 3. MAX BURGER (8709006886)
UPDATE restaurants SET
    name = 'MAX BURGER',
    city = 'Чолпон-Ата',
    address = 'ул. Советская, 67в',
    phone = '+996501459721',
    hours = '10:00 - 22:00',
    lat = 42.650075,
    lon = 77.086667,
    logo = 'https://dtxybpdjbdmqrvsdwvvk.supabase.co/storage/v1/object/public/icons/max%20logo%20krug.jpg',
    img = 'https://dtxybpdjbdmqrvsdwvvk.supabase.co/storage/v1/object/public/icons/max%20big%20logo.jpg',
    tags = '["burgers", "shawarma"]'::jsonb,
    categories_order = '["Шаурма", "Бургеры", "Курочка", "Снеки", "Рамены"]'::jsonb,
    sort_order = 3,
    is_active = true,
    is_approved = true
WHERE id = 8709006886;

-- 4. Лагманкана (1532754022)
UPDATE restaurants SET
    name = 'Лагманкана',
    city = 'Чолпон-Ата',
    address = 'ул. Советская, 57',
    phone = '+996553844644',
    hours = '09:00 - 22:00',
    lat = 42.6490,
    lon = 77.0870,
    logo = 'https://dtxybpdjbdmqrvsdwvvk.supabase.co/storage/v1/object/public/icons/lagman%20mini%20logo.png',
    img = 'https://dtxybpdjbdmqrvsdwvvk.supabase.co/storage/v1/object/public/icons/lagmanlogo.jpg',
    tags = '[]'::jsonb,
    categories_order = '["Лагманы", "Супы", "Вторые блюда", "Напитки", "Салаты", "Завтраки", "Гарниры", "Мучные изделия"]'::jsonb,
    sort_order = 4,
    is_active = true,
    is_approved = true
WHERE id = 1532754022;

-- 5. Инжир (6756874089)
UPDATE restaurants SET
    name = 'Инжир',
    city = 'Чолпон-Ата',
    address = 'ул. Советская, 67в',
    phone = '+996500252505',
    hours = '09:00 - 22:00',
    lat = 42.650075,
    lon = 77.086667,
    logo = 'https://dtxybpdjbdmqrvsdwvvk.supabase.co/storage/v1/object/public/icons/injirminilogo.jpg',
    img = 'https://dtxybpdjbdmqrvsdwvvk.supabase.co/storage/v1/object/public/icons/injirlogo.jpeg',
    tags = '["burgers", "sushi", "shawarma", "pizza"]'::jsonb,
    categories_order = '["Шашлыки", "Восточная кухня", "Салаты", "Напитки", "Пиццы", "Первые блюда", "Европейсие блюда", "Стейки", "Нарезки", "Гарниры", "Соусы", "Банкотные блюда"]'::jsonb,
    sort_order = 5,
    is_active = true,
    is_approved = true
WHERE id = 6756874089;

-- 6. ТЕСТ ЗАКАЗ (5521273499 - Бишкек)
UPDATE restaurants SET
    name = 'ТЕСТ ЗАКАЗ',
    city = 'Бишкек',
    address = 'ул. Киевская, 100',
    phone = '+996990003433',
    hours = '09:00 - 22:00',
    lat = 42.852578,
    lon = 74.687742,
    logo = 'https://dtxybpdjbdmqrvsdwvvk.supabase.co/storage/v1/object/public/icons/KUNJUT%20MINI%20LOG.png',
    img = 'https://dummyimage.com/600x400/ff8c00/fff&text=TEST+RESTAURANT',
    tags = '["burgers", "sushi", "shawarma", "pizza"]'::jsonb,
    categories_order = '[]'::jsonb,
    sort_order = 6,
    is_active = true,
    is_approved = true
WHERE id = 5521273499;

-- 7. Бай манты (843389293)
UPDATE restaurants SET
    name = 'Бай манты',
    city = 'Чолпон-Ата',
    address = 'Советская улица 168д',
    phone = '+996703600080',
    hours = '09:00 - 22:00',
    lat = 42.6490,
    lon = 77.0870,
    logo = 'https://dtxybpdjbdmqrvsdwvvk.supabase.co/storage/v1/object/public/icons/baimantu%20minilogo.jpeg',
    img = 'https://dtxybpdjbdmqrvsdwvvk.supabase.co/storage/v1/object/public/icons/baimantu%20biglogo.jpeg',
    tags = '[]'::jsonb,
    categories_order = '["Манты", "Дополнительно", "Напитки"]'::jsonb,
    sort_order = 7,
    is_active = true,
    is_approved = true
WHERE id = 843389293;
