const { Markup } = require('telegraf');

module.exports = function setupAdminBot(adminBot, restBot, courierBot, supabase, ADMIN_GROUP_ID) {
    
    // ==========================================
    // 1. ОДОБРЕНИЕ КУРЬЕРОВ И РЕСТОРАНОВ
    // ==========================================
    adminBot.action(/approve_courier_(.+)/, async (ctx) => {
        const id = ctx.match[1];
        await supabase.from('couriers').update({ status: 'active' }).eq('id', id);
        await ctx.editMessageText(`✅ Курьер ${id} одобрен!`, 
            Markup.inlineKeyboard([[Markup.button.callback('➕ Пополнить баланс (100)', `add_balance_${id}_100`)]])
        ).catch(() => {});
        try { await courierBot.telegram.sendMessage(id, "🎉 Твоя заявка одобрена! Напиши /start, чтобы увидеть кабинет."); } catch(e){}
    });

    adminBot.action(/approve_rest_(.+)/, async (ctx) => {
        const restId = ctx.match[1];
        await supabase.from('restaurants').update({ is_approved: true }).eq('id', restId);
        await ctx.editMessageText(`✅ Ресторан ${restId} одобрен!`).catch(() => {});
        try { await restBot.telegram.sendMessage(restId, "🎉 Поздравляем! Ваш ресторан одобрен. Теперь вы можете принимать заказы."); } catch(e){}
    });

    adminBot.action(/add_balance_(.+)_(.+)/, async (ctx) => {
        const id = ctx.match[1];
        const amount = parseInt(ctx.match[2]);
        const { data: c } = await supabase.from('couriers').select('balance').eq('id', id).single();
        const newBalance = (c.balance || 0) + amount;
        await supabase.from('couriers').update({ balance: newBalance }).eq('id', id);
        await ctx.answerCbQuery(`Баланс пополнен!`).catch(() => {});
        await ctx.editMessageText(`💰 Баланс курьера ${id} обновлен: ${newBalance} сом.`).catch(() => {});
        try { await courierBot.telegram.sendMessage(id, `💰 Ваш баланс пополнен на ${amount} сом!\nТекущий баланс: ${newBalance} сом.`); } catch(e){}
    });

    // ==========================================
    // 2. УМНАЯ КОМАНДА ДЛЯ ПОПОЛНЕНИЯ БАЛАНСА КУРЬЕРА
    // ==========================================
    adminBot.command('pay', async (ctx) => {
        if (ctx.chat.id.toString() !== ADMIN_GROUP_ID.toString()) return;
        
        const text = ctx.message.text.trim();
        const args = text.split(/\s+/);
        
        if (args.length < 3) {
            return ctx.reply("❌ Неверный формат!\nИспользуйте: /pay [Имя, Телефон или ID] [Сумма]");
        }
        
        const amount = parseInt(args.pop()); 
        if (isNaN(amount) || amount <= 0) return ctx.reply("❌ Сумма должна быть числом больше нуля!");

        const identifier = args.slice(1).join(' '); 
        const cleanSearchPhone = identifier.replace(/[\s\+\-\(\)]/g, ''); 

        try {
            const { data: couriers, error } = await supabase.from('couriers').select('id, name, phone, balance');
            if (error || !couriers) return ctx.reply("❌ Ошибка при поиске курьеров в базе.");

            const matched = couriers.filter(c => {
                const idStr = String(c.id);
                const nameStr = (c.name || '').toLowerCase();
                const phoneStr = (c.phone || '').replace(/[\s\+\-\(\)]/g, '');
                const searchStr = identifier.toLowerCase();

                return idStr === searchStr || 
                       nameStr.includes(searchStr) || 
                       (cleanSearchPhone.length >= 5 && phoneStr.includes(cleanSearchPhone));
            });

            if (matched.length === 0) {
                return ctx.reply(`❌ Курьер "${identifier}" не найден.\nПроверьте правильность написания имени или номера.`);
            }

            if (matched.length > 1) {
                let msg = `⚠️ Найдено несколько курьеров по запросу "${identifier}". Уточните, кому именно пополнить:\n\n`;
                matched.forEach(c => {
                    msg += `👤 ${c.name} | 📞 ${c.phone || 'Нет номера'} | ID: <code>${c.id}</code>\n`;
                });
                msg += `\nПожалуйста, скопируйте нужный ID или номер и повторите команду.`;
                return ctx.reply(msg, { parse_mode: 'HTML' });
            }

            const c = matched[0];
            const newBalance = (c.balance || 0) + amount;
            
            await supabase.from('couriers').update({ balance: newBalance }).eq('id', c.id);
            
            await ctx.reply(`✅ Баланс успешно пополнен!\n👤 Курьер: ${c.name}\n📞 Тел: ${c.phone || 'Нет'}\n💰 Зачислено: ${amount} сом\n💳 Текущий баланс: ${newBalance} сом.`);
            
            try { 
                await courierBot.telegram.sendMessage(c.id, `💰 Ваш баланс пополнен администратором на ${amount} сом!\n💳 Текущий баланс: ${newBalance} сом.\n\nУдачных доставок! 🛵`); 
            } catch(e) {
                console.error("Не удалось отправить сообщение курьеру", e);
            }

        } catch (err) {
            console.error("Ошибка при пополнении:", err);
            ctx.reply("❌ Произошла системная ошибка базы данных.");
        }
    });

    // ==========================================
    // 3. ОТПРАВКА ИНФО-ЧЕКА В АДМИНКУ И РАССЫЛКА ПО РЕСТОРАНАМ (АВТОМАТИЧЕСКАЯ)
    // ==========================================
    return {
        sendOrderToAdmin: async (orderData) => {
            try {
                // 1. Формируем красивый чек для тебя (в админ-группу)
                const itemsArr = Array.isArray(orderData.items) ? orderData.items : (JSON.parse(orderData.items || '[]'));
                const itemsText = itemsArr.map(i => {
                    const name = i.item ? i.item.name : i.name;
                    return `▫️ ${name} x${i.count}`;
                }).join('\n');

                let addressSuffix = '';
                let displayComment = orderData.comment || 'Нет';

                if (orderData.restaurantAddress) {
                    addressSuffix = ` (${orderData.restaurantAddress})`;
                    if (displayComment.includes('🏪 Адрес ресторана:')) {
                        displayComment = displayComment.split(' | ').filter(p => !p.includes('🏪 Адрес ресторана:')).join(' | ') || 'Нет';
                    }
                } else if (displayComment.includes('🏪 Адрес ресторана:')) {
                    const parts = displayComment.split(' | ');
                    const addrPart = parts.find(p => p.includes('🏪 Адрес ресторана:'));
                    if (addrPart) {
                        addressSuffix = ` (${addrPart.replace('🏪 Адрес ресторана:', '').trim()})`;
                        displayComment = parts.filter(p => !p.includes('🏪 Адрес ресторана:')).join(' | ') || 'Нет';
                    }
                }

                const fullRestName = `${orderData.restaurant || 'Не указан'}${addressSuffix}`;

                // Убрали кнопки оплаты, оставили только кнопку "Написать клиенту", если нужно
                const message = `✅ ОПЛАЧЕННЫЙ ЗАКАЗ В РАБОТЕ!\nID: #${String(orderData.id).slice(0,5)}\n💰 Сумма: ${orderData.total_price} сом\n\n👤 Клиент: ${orderData.client_name || 'Гость'}\n📞 Номер: ${orderData.phone || 'Не указан'}\n📍 Адрес: ${orderData.address || 'Не указан'}\n💬 Комментарий: ${displayComment}\n\n🏢 Ресторан: ${fullRestName}\n\n🛒 Блюда:\n${itemsText}`;

                const buttons = [];
                const cid = orderData.client_id;
                if (cid && String(cid) !== '111' && String(cid) !== 'null' && String(cid) !== 'undefined') {
                    buttons.push([Markup.button.url("💬 Написать клиенту", `tg://user?id=${cid}`)]);
                }

                // Отправляем тебе инфо-сообщение
                await adminBot.telegram.sendMessage(ADMIN_GROUP_ID, message, Markup.inlineKeyboard(buttons));

                // ==========================================
                // 🚀 АВТОМАТИЧЕСКАЯ РАССЫЛКА (МАГИЯ!)
                // ==========================================
                
                // 1. Отправляем в ресторан
                try {
                    // Ищем Telegram ID ресторана в базе по имени
                    const { data: restData } = await supabase
                        .from('restaurants')
                        .select('id')
                        .eq('name', orderData.restaurant)
                        .maybeSingle();

                    if (restData && restData.id) {
                        const orderTextForRest = `🔥 <b>НОВЫЙ ОПЛАЧЕННЫЙ ЗАКАЗ #${orderData.id}</b>\n\nБлюда:\n${itemsText}\n\nСумма: ${orderData.total_price} сом\nКомментарий: ${displayComment}`;
                        
                        await restBot.telegram.sendMessage(restData.id, orderTextForRest, {
                            parse_mode: 'HTML',
                            reply_markup: {
                                inline_keyboard: [[
                                    { text: "👨‍🍳 Принять и начать готовить", callback_data: `rest_accept_${orderData.id}` }
                                ]]
                            }
                        });
                    } else {
                        console.warn(`⚠️ Ресторан ${orderData.restaurant} не найден в базе для отправки заказа.`);
                    }
                } catch (e) {
                    console.error("❌ Ошибка отправки в ресторан:", e.message);
                }

                // 2. Отправляем курьерам в общую группу
                try {
                    const COURIER_GROUP_ID = process.env.COURIER_CHAT_ID; // Убедись, что эта переменная есть в Render
                    if (COURIER_GROUP_ID) {
                        const courierText = `🚕 <b>НОВЫЙ ЗАКАЗ #${orderData.id}</b>\n\nОткуда: ${fullRestName}\nКуда: ${orderData.address}\n\nСумма заказа: ${orderData.total_price} сом`;
                        
                        await courierBot.telegram.sendMessage(COURIER_GROUP_ID, courierText, {
                            parse_mode: 'HTML',
                            reply_markup: {
                                inline_keyboard: [[
                                    { text: "🙋‍♂️ Я возьму заказ", callback_data: `take_order_${orderData.id}` }
                                ]]
                            }
                        });
                    }
                } catch (e) {
                    console.error("❌ Ошибка отправки курьерам:", e.message);
                }

            } catch (err) {
                console.error("❌ ОШИБКА ОТПРАВКИ В АДМИНКУ/РАССЫЛКИ:", err.message);
            }
        }
    };
};