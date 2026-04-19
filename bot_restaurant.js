const { Markup } = require('telegraf');

module.exports = function setupRestaurantBot(restBot, courierBot, clientBot, supabase, ADMIN_GROUP_ID) {
    
    // 1. СТАРТ И РЕГИСТРАЦИЯ
    restBot.start(async (ctx) => {
        const id = ctx.from.id;
        
        // Проверяем, есть ли такой ресторан в базе
        const { data: rest, error } = await supabase
            .from('restaurants')
            .select('*')
            .eq('id', id)
            .single();

        if (!rest) {
            // Если нет — создаем черновик и спрашиваем название
            await supabase.from('restaurants').insert([{ id, step: 'ask_name', is_approved: false }]);
            return ctx.reply("Привет! Добро пожаловать в панель партнера ТамакKG. 🍔\n\nВведите название вашего заведения (например, 'Дракон Суши'):");
        }

        if (!rest.is_approved) {
            return ctx.reply("⏳ Ваша заявка находится на проверке у администратора. Мы пришлем уведомление, как только вас одобрят.");
        }

        ctx.reply(`✅ Личный кабинет ресторана "${rest.name}" активен!\nСюда будут приходить новые заказы от клиентов.`);
    });

    // 2. ОБРАБОТКА ТЕКСТОВЫХ СООБЩЕНИЙ (Шаги регистрации)
    restBot.on('text', async (ctx) => {
        const id = ctx.from.id;
        const text = ctx.message.text;

        const { data: rest } = await supabase.from('restaurants').select('*').eq('id', id).single();
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

            // Уведомляем админа в его группу
            return restBot.telegram.sendMessage(ADMIN_GROUP_ID, 
                `🏢 НОВАЯ ЗАЯВКА (РЕСТОРАН)\n\nНазвание: ${rest.name}\nВладелец: ${text}\nID: ${id}`,
                Markup.inlineKeyboard([
                    [Markup.button.callback('✅ ОДОБРИТЬ', `approve_rest_${id}`)]
                ])
            );
        }
    });

    // 3. ОДОБРЕНИЕ РЕСТОРАНА (Действие админа)
    restBot.action(/approve_rest_(.+)/, async (ctx) => {
        const restId = ctx.match[1];
        
        await supabase.from('restaurants').update({ is_approved: true }).eq('id', restId);
        
        await ctx.editMessageText(`✅ Ресторан ${restId} одобрен!`);
        
        // Уведомляем ресторан в личку
        try {
            await restBot.telegram.sendMessage(restId, "🎉 Поздравляем! Ваш ресторан одобрен. Теперь вы будете получать заказы в этот чат.");
        } catch (e) {
            console.error("Не удалось отправить сообщение ресторану:", e.message);
        }
    });

    // 4. ЛОГИКА ЗАКАЗА (Принять / Отклонить / Готово)
    // Эти кнопки будут прилетать из server.js
    
    restBot.action(/rest_accept_(.+)/, async (ctx) => {
        const orderId = ctx.match[1];
        await supabase.from('orders').update({ status: 'cooking' }).eq('id', orderId);
        
        ctx.editMessageText(`👨‍🍳 Заказ #${orderId.slice(0,5)} в работе!\n\nКогда всё будет упаковано, нажмите кнопку ниже:`,
            Markup.inlineKeyboard([
                [Markup.button.callback('🚀 ГОТОВО! ВЫЗВАТЬ КУРЬЕРА', `rest_ready_${orderId}`)]
            ])
        );
    });

    restBot.action(/rest_decline_(.+)/, async (ctx) => {
        const orderId = ctx.match[1];
        await supabase.from('orders').update({ status: 'canceled' }).eq('id', orderId);
        
        const { data: order } = await supabase.from('orders').select('client_id').eq('id', orderId).single();
        
        ctx.editMessageText(`❌ Вы отклонили заказ #${orderId.slice(0,5)}.`);
        
        if (order && order.client_id) {
            try {
                await clientBot.telegram.sendMessage(order.client_id, "😔 К сожалению, ресторан не смог принять ваш заказ. Деньги не списаны.");
            } catch (e) {}
        }
    });

    restBot.action(/rest_ready_(.+)/, async (ctx) => {
        const orderId = ctx.match[1];
        const { data: order } = await supabase.from('orders').select('*').eq('id', orderId).single();

        await supabase.from('orders').update({ status: 'searching_courier' }).eq('id', orderId);
        ctx.editMessageText(`✅ Заказ #${orderId.slice(0,5)} готов. Ищем курьера...`);

        // Тут мы добавим отправку курьерам, когда дойдем до server.js
    });

    console.log('📦 Модуль Restaurant (Персональный) загружен');
};