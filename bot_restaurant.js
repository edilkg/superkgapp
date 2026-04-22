const { Markup } = require('telegraf');

module.exports = function setupRestaurantBot(restBot, courierBot, clientBot, supabase, ADMIN_GROUP_ID) {
    
    // 1. СТАРТ И РЕГИСТРАЦИЯ
    restBot.start(async (ctx) => {
        try {
            const id = ctx.from.id;
            
            const { data: rest } = await supabase
                .from('restaurants')
                .select('*')
                .eq('id', id)
                .maybeSingle();

            if (!rest) {
                await supabase.from('restaurants').insert([{ id: id, step: 'ask_name', is_approved: false }]);
                return ctx.reply("Привет! Добро пожаловать в панель партнера. 🍔\n\nВведите название вашего заведения (например, 'Дракон Суши'):");
            }

            if (!rest.is_approved) {
                return ctx.reply("⏳ Ваша заявка находится на проверке у администратора.");
            }

            ctx.reply(`✅ Кабинет ресторана "${rest.name}" активен!\nСюда будут приходить новые заказы от клиентов.`);
        } catch (err) {
            console.error("Ошибка /start:", err);
            ctx.reply("⚠️ Внутренняя ошибка бота.");
        }
    });

    // 2. ОБРАБОТКА ТЕКСТОВЫХ СООБЩЕНИЙ (Шаги регистрации)
    restBot.on('text', async (ctx) => {
        try {
            const id = ctx.from.id;
            const text = ctx.message.text;

            if (text.startsWith('/')) return; 

            const { data: rest } = await supabase.from('restaurants').select('*').eq('id', id).maybeSingle();
            if (!rest || rest.is_approved) return;

            // ШАГ 1: Получаем название
            if (rest.step === 'ask_name') {
                await supabase.from('restaurants').update({ name: text, step: 'ask_phone' }).eq('id', id);
                return ctx.reply(`Принято! Теперь напишите рабочий номер телефона для связи с курьерами:`);
            }

            // ШАГ 2: Получаем телефон и отправляем админу
            if (rest.step === 'ask_phone') {
                await supabase.from('restaurants').update({ phone: text, step: 'waiting_approval' }).eq('id', id);
                
                ctx.reply("Спасибо! Заявка отправлена администратору. Ожидайте подтверждения.");

                return restBot.telegram.sendMessage(ADMIN_GROUP_ID, 
                    `🏢 НОВАЯ ЗАЯВКА (РЕСТОРАН)\n\nНазвание: ${rest.name}\nВладелец: ${text}\nID: ${id}`,
                    Markup.inlineKeyboard([
                        [Markup.button.callback('✅ ОДОБРИТЬ', `approve_rest_${id}`)]
                    ])
                );
            }
        } catch (err) {
            console.error("Ошибка ввода текста:", err);
        }
    });

    // 3. ОДОБРЕНИЕ АДМИНОМ
    restBot.action(/approve_rest_(.+)/, async (ctx) => {
        const restId = ctx.match[1];
        await supabase.from('restaurants').update({ is_approved: true }).eq('id', restId);
        await ctx.editMessageText(`✅ Ресторан ${restId} одобрен!`);
        
        try {
            await restBot.telegram.sendMessage(restId, "🎉 Поздравляем! Ваш ресторан одобрен. Теперь вы будете получать заказы.");
        } catch (e) {}
    });

    // 4. ЛОГИКА ЗАКАЗА (Yandex.Pro Style)
    restBot.action(/rest_accept_(.+)/, async (ctx) => {
        const orderId = ctx.match[1];
        await supabase.from('orders').update({ status: 'cooking' }).eq('id', orderId);
        
        ctx.editMessageText(`👨‍🍳 Заказ #${String(orderId).slice(0,5)} готовится!\nКурьеры уже получили уведомление и выезжают к вам.\n\nКогда отдадите пакет курьеру, нажмите кнопку ниже:`,
            Markup.inlineKeyboard([
                [Markup.button.callback('📦 ЗАКАЗ ПЕРЕДАН КУРЬЕРУ', `rest_given_${orderId}`)]
            ])
        );
    });

    restBot.action(/rest_given_(.+)/, async (ctx) => {
        const orderId = ctx.match[1];
        ctx.editMessageText(`✅ Вы успешно передали заказ #${String(orderId).slice(0,5)} курьеру. Отличная работа!`);
    });

    restBot.action(/rest_decline_(.+)/, async (ctx) => {
        const orderId = ctx.match[1];
        await supabase.from('orders').update({ status: 'canceled' }).eq('id', orderId);
        const { data: order } = await supabase.from('orders').select('client_id').eq('id', orderId).maybeSingle();
        
        ctx.editMessageText(`❌ Вы отклонили заказ #${String(orderId).slice(0,5)}.`);
        
        if (order && order.client_id) {
            try {
                await clientBot.telegram.sendMessage(order.client_id, "😔 К сожалению, ресторан не смог принять ваш заказ. Деньги не списаны.");
            } catch (e) {}
        }
    });

    console.log('📦 Модуль Restaurant загружен');
};