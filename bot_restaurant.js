const { Markup } = require('telegraf');

module.exports = function setupRestaurantBot(restBot, courierBot, clientBot, supabase, ADMIN_GROUP_ID) {
    
    // 1. СТАРТ И РЕГИСТРАЦИЯ
    restBot.start(async (ctx) => {
        try {
            const id = ctx.from.id;
            const { data: rest } = await supabase.from('restaurants').select('*').eq('id', id).maybeSingle();

            if (!rest) {
                await supabase.from('restaurants').insert([{ id, step: 'ask_name', is_approved: false }]);
                return ctx.reply("Привет! Добро пожаловать в панель партнера ТамакKG. 🍔\n\nВведите название вашего заведения (например, 'Дракон Суши'):");
            }

            if (!rest.is_approved) {
                return ctx.reply("⏳ Ваша заявка находится на проверке у администратора.");
            }

            ctx.reply(`✅ Кабинет ресторана "${rest.name}" активен!\nСюда будут приходить новые заказы.`);
        } catch (err) {
            ctx.reply("⚠️ Ошибка. Попробуйте позже.");
        }
    });

    // 2. ШАГИ РЕГИСТРАЦИИ
    restBot.on('text', async (ctx) => {
        const id = ctx.from.id;
        const text = ctx.message.text;
        if (text.startsWith('/')) return;

        const { data: rest } = await supabase.from('restaurants').select('*').eq('id', id).maybeSingle();
        if (!rest || rest.is_approved) return;

        if (rest.step === 'ask_name') {
            await supabase.from('restaurants').update({ name: text, step: 'ask_phone' }).eq('id', id);
            return ctx.reply(`Принято! Теперь напишите номер телефона для связи:`);
        }

        if (rest.step === 'ask_phone') {
            await supabase.from('restaurants').update({ phone: text, step: 'waiting' }).eq('id', id);
            ctx.reply("Спасибо! Заявка отправлена администратору.");

            // ПУШ АДМИНУ
            return restBot.telegram.sendMessage(ADMIN_GROUP_ID, 
                `🏢 НОВАЯ ЗАЯВКА (РЕСТОРАН)\n\nНазвание: ${rest.name}\nТелефон: ${text}\nID: ${id}`,
                Markup.inlineKeyboard([[Markup.button.callback('✅ ОДОБРИТЬ РЕСТОРАН', `approve_rest_${id}`)]])
            );
        }
    });

    // 3. ДЕЙСТВИЕ АДМИНА: ОДОБРЕНИЕ
    restBot.action(/approve_rest_(.+)/, async (ctx) => {
        const restId = ctx.match[1];
        await supabase.from('restaurants').update({ is_approved: true }).eq('id', restId);
        await ctx.editMessageText(`✅ Ресторан ${restId} одобрен!`);
        restBot.telegram.sendMessage(restId, "🎉 Поздравляем! Ваш ресторан одобрен. Теперь вы можете принимать заказы.");
    });

    // 4. ЛОГИКА ЗАКАЗОВ (ОСТАВЛЯЕМ БЕЗ ИЗМЕНЕНИЙ)
    restBot.action(/rest_accept_(.+)/, async (ctx) => {
        const orderId = ctx.match[1];
        await supabase.from('orders').update({ status: 'cooking' }).eq('id', orderId);
        ctx.editMessageText(`👨‍🍳 Заказ #${String(orderId).slice(0,5)} готовится!\nНажмите кнопку, когда отдадите пакет:`,
            Markup.inlineKeyboard([[Markup.button.callback('📦 ОТДАНО КУРЬЕРУ', `rest_given_${orderId}`)]])
        );
    });

    restBot.action(/rest_given_(.+)/, async (ctx) => {
        ctx.editMessageText(`✅ Заказ успешно передан курьеру!`);
    });

    restBot.action(/rest_decline_(.+)/, async (ctx) => {
        const orderId = ctx.match[1];
        await supabase.from('orders').update({ status: 'canceled' }).eq('id', orderId);
        ctx.editMessageText(`❌ Заказ отклонен.`);
    });

    console.log('📦 Модуль Restaurant обновлен');
};