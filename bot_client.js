const { Markup } = require('telegraf');

module.exports = function setupClientBot(bot, supabase, ADMIN_GROUP_ID) {
    
    // Приветствие и кнопка запуска Web App
    // Приветствие и кнопка запуска Web App
    bot.start((ctx) => {
        const cacheBuster = Date.now(); // Генерирует уникальное число (текущее время)
        ctx.reply('Добро пожаловать в ТамакKG! 🍔\nСамая быстрая доставка на Иссык-Куле.', 
            Markup.inlineKeyboard([
                // Телеграм будет думать, что это всегда новая ссылка
                [Markup.button.webApp('🍕 Открыть меню', `https://edilkg.github.io/superkgapp/?v=${cacheBuster}`)] 
            ])
        );
    });

    // Обработка кнопок администратора (одобрение курьеров)
    // Эта кнопка нажимается в админской группе, но обрабатывается главным ботом
    bot.action(/approve_(.+)/, async (ctx) => {
        const courierId = ctx.match[1];
        
        const { error } = await supabase.from('couriers').update({ is_approved: true }).eq('id', courierId);
        
        if (error) {
            return ctx.answerCbQuery('❌ Ошибка при одобрении', { show_alert: true });
        }

        await ctx.editMessageText(`✅ Курьер ${courierId} теперь в штате!`);
        
        // Пытаемся уведомить самого курьера (через его личку, если бот имеет туда доступ)
        try {
            await ctx.telegram.sendMessage(courierId, "🎉 Поздравляем! Твой аккаунт одобрен администратором. Теперь ты можешь выйти на линию!");
        } catch (e) {
            console.log(`Не удалось отправить ЛС курьеру ${courierId}. Возможно, он заблокировал бота.`);
        }
    });

    // В будущем здесь будут: 
    // - Проверка статуса заказа по номеру
    // - Оставить отзыв
    // - Связь с поддержкой

    console.log('📦 Модуль Client загружен');
};