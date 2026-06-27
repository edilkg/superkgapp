const { Markup } = require('telegraf');

module.exports = function setupClientBot(bot, supabase) {
    
    // Приветствие и кнопка запуска Web App
    bot.start((ctx) => {
        ctx.reply('Добро пожаловать в ТамакKG! 🍔\nСамая быстрая доставка на Иссык-Куле.', 
            Markup.inlineKeyboard([
                [Markup.button.webApp('🍕 Открыть меню', 'https://superkgapp.vercel.app/')] 
            ])
        );
    });

    console.log('📦 Модуль Client загружен');
};