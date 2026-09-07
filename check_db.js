require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function checkSchema() {
    // Получаем одну запись, чтобы посмотреть, какие вообще есть колонки
    const { data, error } = await supabase.from('couriers').select('*').limit(1);
    
    if (error) {
        console.error("Ошибка:", error);
    } else if (data.length > 0) {
        console.log("Колонки в таблице couriers:", Object.keys(data[0]));
    } else {
        // Если таблица пустая, попробуем вставить фиктивную запись и откатить, 
        // но лучше просто посмотреть через select
        console.log("Таблица couriers пуста, но запрос прошел.");
    }
}

checkSchema();
