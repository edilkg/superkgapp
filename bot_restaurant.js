const { Markup } = require('telegraf');

// ДОБАВЛЕН clientBot в аргументы, чтобы ресторан мог уведомить клиента
module.exports = function setupRestaurantBot(restBot, courierBot, clientBot, supabase, REST_GROUP_ID, COURIER_GROUP_ID) {
    
    // 1. Ресторан принимает заказ в готовку
    restBot.action(/rest_accept_(.+)/, async (ctx) => {
        const orderId = ctx.match[1];
        
        // Меняем статус в базе
        await supabase.from('orders').update({ status: 'cooking' }).eq('id', orderId);

        // Меняем сообщение в группе ресторана
        await ctx.editMessageText(`👨‍🍳 Вы готовите заказ #${orderId.slice(0, 5)}...\n\nКак только соберете пакет, нажмите кнопку ниже, чтобы вызвать курьера:`, 
            Markup.inlineKeyboard([
                [Markup.button.callback('🚀 ГОТОВО! ВЫЗВАТЬ КУРЬЕРА', `rest_ready_${orderId}`)]
            ])
        );
    });

    // 2. Ресторан ОТКЛОНЯЕТ заказ
    restBot.action(/rest_decline_(.+)/, async (ctx) => {
        const orderId = ctx.match[1];

        // Получаем ID клиента, чтобы написать ему напрямую
        const { data: order } = await supabase.from('orders').select('client_id').eq('id', orderId).single();

        // Меняем статус в базе
        await supabase.from('orders').update({ status: 'canceled' }).eq('id', orderId);

        // Обновляем панель ресторана (чтобы другие повара видели, что заказ отменен)
        await ctx.editMessageText(`❌ Вы отклонили заказ #${orderId.slice(0, 5)}.`);

        // Уведомляем клиента через клиентского бота
        if (order && order.client_id) {
            try {
                await clientBot.telegram.sendMessage(order.client_id, 
                    `😔 К сожалению, ресторан не смог принять ваш заказ #${orderId.slice(0, 5)}.\nДеньги не были списаны. Попробуйте заказать чуть позже или выберите другое заведение.`
                );
            } catch (e) {
                console.error("🔴 Не удалось отправить сообщение клиенту:", e.message);
            }
        }
    });

    // 3. Ресторан приготовил еду, ищем курьера
    restBot.action(/rest_ready_(.+)/, async (ctx) => {
        const orderId = ctx.match[1];

        // Вытягиваем данные заказа из базы, чтобы передать их курьеру
        const { data: order } = await supabase.from('orders').select('*').eq('id', orderId).single();

        if (!order) return ctx.answerCbQuery("❌ Заказ не найден в базе!", { show_alert: true });

        // Меняем статус на поиск курьера
        await supabase.from('orders').update({ status: 'searching_courier' }).eq('id', orderId);

        // Обновляем панель ресторана
        await ctx.editMessageText(`✅ Заказ #${orderId.slice(0, 5)} собран и ждет курьера!\nУведомление водителям отправлено.`);

        // ОТПРАВЛЯЕМ ЗАКАЗ В ГРУППУ КУРЬЕРОВ
        const orderText = `🔥 НОВЫЙ ЗАКАЗ #${orderId.slice(0,5)}\n🏬 Откуда: ${order.restaurant}\n📍 Куда: ${order.address}\n💰 Доход курьера: 150 сом\n💬 Коммент: ${order.comment || 'нет'}`;
        
        await courierBot.telegram.sendMessage(COURIER_GROUP_ID, orderText, 
            Markup.inlineKeyboard([
                [Markup.button.callback('🤝 ПРИНЯТЬ ЗАКАЗ', `accept_${orderId}`)]
            ])
        );
    });

    console.log('📦 Модуль Restaurant загружен');
};