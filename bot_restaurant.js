const { Markup } = require('telegraf');

module.exports = function setupRestaurantBot(restBot, courierBot, clientBot, supabase, ADMIN_GROUP_ID) {
    
    // Хендлер на ЛЮБОЕ сообщение для теста
    restBot.on('message', async (ctx, next) => {
        console.log(`[DEBUG] Ресторан получил сообщение: ${ctx.message.text || 'не текст'}`);
        return next();
    });

    restBot.start(async (ctx) => {
        try {
            const id = ctx.from.id;
            // СРАЗУ отвечаем, чтобы проверить связь
            await ctx.reply("--- СИСТЕМА ТАМАК-KG: РЕГИСТРАЦИЯ ---");
            
            const { data: rest, error: fetchError } = await supabase
                .from('restaurants')
                .select('*')
                .eq('id', id)
                .maybeSingle();

            if (!rest) {
                await supabase.from('restaurants').insert([{ id, step: 'ask_name', is_approved: false }]);
                return ctx.reply("Введите название вашего заведения:");
            }

            if (!rest.is_approved) {
                return ctx.reply("⏳ Ваша заявка на проверке.");
            }

            ctx.reply(`✅ Кабинет ресторана "${rest.name}" активен!`);
        } catch (err) {
            console.error("Ошибка в боте ресторана:", err);
            ctx.reply("⚠️ Ошибка. Попробуйте позже.");
        }
    });

    // Одобрение (оставляем старое)
    restBot.action(/rest_ready_(.+)/, async (ctx) => {
        try {
            const orderId = ctx.match[1];
            
            // 1. Обновляем статус в базе
            await supabase.from('orders').update({ status: 'searching_courier' }).eq('id', orderId);
            ctx.editMessageText(`✅ Заказ #${String(orderId).slice(0,5)} готов. Ищем курьера...`);

            // 2. Достаем информацию о заказе из базы
            const { data: order } = await supabase.from('orders').select('*').eq('id', orderId).maybeSingle();
            if (!order) return;

            // 3. Формируем красивое сообщение для курьера
            const msg = `🔥 НОВЫЙ ЗАКАЗ ГОТОВ К ВЫДАЧЕ!\n\n🏢 Откуда: ${order.restaurant || 'Ресторан'}\n📍 Куда везти: ${order.address}\n💰 Сумма: ${order.total_price} сом\n\nКто заберет?`;

            // 4. Курьерский бот кричит в группу! 
            // (Если у тебя нет отдельной группы курьеров, заказ упадет в админскую)
            const targetGroupId = process.env.COURIER_GROUP_ID || ADMIN_GROUP_ID;

            await courierBot.telegram.sendMessage(targetGroupId, msg, 
                Markup.inlineKeyboard([
                    [Markup.button.callback('🏃‍♂️ Я ЗАБЕРУ ЗАКАЗ!', `courier_take_${orderId}`)]
                ])
            );
        } catch (err) {
            console.error("❌ Ошибка при вызове курьера:", err);
            ctx.reply("⚠️ Ошибка при поиске курьера. Напишите администратору.");
        }
    });

    console.log('📦 Модуль Restaurant (Debug Mode) загружен');
};