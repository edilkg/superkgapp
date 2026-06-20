const { Markup } = require('telegraf');

module.exports = function setupClientBot(bot, supabase) {
    
    // Приветствие и кнопка запуска Web App
    bot.start((ctx) => {
        const cacheBuster = Date.now(); 
        ctx.reply('Добро пожаловать в ТамакKG! 🍔\nСамая быстрая доставка на Иссык-Куле.', 
            Markup.inlineKeyboard([
                [Markup.button.webApp('🍕 Открыть меню', `https://edilkg.github.io/superkgapp/?v=${cacheBuster}`)] 
            ])
        );
    });

    console.log('📦 Модуль Client загружен');
};