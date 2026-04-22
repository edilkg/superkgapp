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
    restBot.action(/approve_rest_(.+)/, async (ctx) => {
        const restId = ctx.match[1];
        await supabase.from('restaurants').update({ is_approved: true }).eq('id', restId);
        ctx.editMessageText(`✅ Ресторан ${restId} одобрен!`);
        restBot.telegram.sendMessage(restId, "🎉 Ваш ресторан одобрен!").catch(() => {});
    });

    console.log('📦 Модуль Restaurant (Debug Mode) загружен');
};