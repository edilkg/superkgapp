const { Markup } = require('telegraf');

// Функция защиты от крашей Telegram при отправке спецсимволов
const safeHtml = (str) => String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

module.exports = function setupCourierBot(courierBot, bot, restBot, supabase, ADMIN_GROUP_ID) {
    
    // ==========================================
    // 0. СТАРТ И ПРОФИЛЬ
    // ==========================================
    courierBot.start(async (ctx) => {
        try {
            const id = ctx.from?.id;
            if (!id) return;

            const { data: courier } = await supabase.from('couriers').select('*').eq('id', id).maybeSingle();

            if (!courier) {
                await supabase.from('couriers').insert([{ id, name: ctx.from.first_name || 'Курьер', status: 'offline', step: 'ask_phone', balance: 0 }]);
                return ctx.reply("Привет! Чтобы стать курьером, отправь свой номер телефона, нажав на кнопку ниже:", 
                    Markup.keyboard([[Markup.button.contactRequest('📱 Отправить мой номер')]]).resize()
                );
            }

            if (courier.step === 'ask_phone') {
                return ctx.reply("Пожалуйста, отправь свой номер телефона:", 
                    Markup.keyboard([[Markup.button.contactRequest('📱 Отправить мой номер')]]).resize()
                );
            }

            if (courier.status === 'waiting_approval') {
                return ctx.reply("⏳ Твой аккаунт на проверке.", Markup.removeKeyboard());
            }

            ctx.reply(`👤 ЛИЧНЫЙ КАБИНЕТ\nИмя: ${courier.name || 'Курьер'}\nТелефон: ${courier.phone || 'Не указан'}\nБаланс: ${courier.balance || 0} сом\n\nДля пополнения баланса напишите админу: @foodkg_admin`, 
                Markup.keyboard([['👤 Профиль']]).resize()
            );
        } catch (e) { 
            console.error("Ошибка при старте курьера:", e); 
        }
    });

    courierBot.on('contact', async (ctx) => {
        try {
            const id = ctx.from.id;
            const { data: courier } = await supabase.from('couriers').select('step').eq('id', id).maybeSingle();
            if (!courier || courier.step !== 'ask_phone') return;

            const phone = ctx.message.contact.phone_number;
            await supabase.from('couriers').update({ phone: phone, step: 'completed', status: 'waiting_approval' }).eq('id', id);
            await ctx.reply("✅ Спасибо! Заявка отправлена админу. Жди одобрения.", Markup.removeKeyboard());

            return bot.telegram.sendMessage(ADMIN_GROUP_ID, 
                `🛵 НОВАЯ ЗАЯВКА (КУРЬЕР)\nИмя: ${ctx.from.first_name || 'Не указано'}\nТелефон: ${phone}\nID: ${id}`,
                Markup.inlineKeyboard([[Markup.button.callback('✅ ОДОБРИТЬ КУРЬЕРА', `approve_courier_${id}`)]])
            );
        } catch (e) { console.error("Ошибка контакта:", e); }
    });

    courierBot.on('text', async (ctx) => {
        try {
            const id = ctx.from.id;
            const text = ctx.message.text;
            if (text.startsWith('/')) return;

            const { data: courier } = await supabase.from('couriers').select('*').eq('id', id).maybeSingle();
            if (!courier) return;

            if (courier.step === 'ask_phone') {
                await supabase.from('couriers').update({ phone: text, step: 'completed', status: 'waiting_approval' }).eq('id', id);
                await ctx.reply("✅ Спасибо! Заявка отправлена админу.", Markup.removeKeyboard());

                return bot.telegram.sendMessage(ADMIN_GROUP_ID, 
                    `🛵 НОВАЯ ЗАЯВКА (КУРЬЕР)\nИмя: ${ctx.from.first_name || 'Не указано'}\nТелефон: ${text}\nID: ${id}`,
                    Markup.inlineKeyboard([[Markup.button.callback('✅ ОДОБРИТЬ КУРЬЕРА', `approve_courier_${id}`)]])
                );
            }

            if (text === '👤 Профиль') {
                if (courier.status === 'waiting_approval') return;
                return ctx.reply(`👤 ЛИЧНЫЙ КАБИНЕТ\nИмя: ${courier.name || 'Курьер'}\nТелефон: ${courier.phone || 'Не указан'}\nБаланс: ${courier.balance || 0} сом\n\nДля пополнения: @foodkg_admin`);
            }
        } catch (e) {}
    });

    // ==========================================
    // 1. КУРЬЕР БЕРЕТ ЗАКАЗ ИЗ ОБЩЕЙ ГРУППЫ
    // ==========================================
    courierBot.action(/(?:courier_take_|take_order_)(.+)/, async (ctx) => {
        // Очищаем ID от любых случайных пробелов или скрытых символов!
        const orderId = String(ctx.match[1]).trim(); 
        const courierId = ctx.from.id;

        console.log(`[КУРЬЕР] Попытка взять заказ. ID заказа: ${orderId}, ID курьера: ${courierId}`);

        try {
            // Проверка баланса курьера
            const { data: courierCheck } = await supabase.from('couriers').select('balance').eq('id', courierId).maybeSingle();
            if (!courierCheck) {
                console.log("[КУРЬЕР] Ошибка: Курьер не найден в БД.");
                return ctx.answerCbQuery("❌ Ошибка: курьер не найден", { show_alert: true });
            }
            
            if ((courierCheck.balance || 0) <= 0) {
                return ctx.answerCbQuery("❌ Ваш баланс 0 или ниже! Пополните счет, чтобы брать заказы.", { show_alert: true });
            }

            // Проверка статуса заказа
            const { data: orderCheck, error: checkErr } = await supabase.from('orders').select('*').eq('id', orderId).maybeSingle();
            if (checkErr || !orderCheck) {
                console.error("[КУРЬЕР] Ошибка поиска заказа:", checkErr);
                return ctx.answerCbQuery("❌ Заказ не найден", { show_alert: true });
            }

            if (orderCheck.status === 'canceled') {
                await ctx.answerCbQuery("❌ Отбой! Ресторан отменил этот заказ.", { show_alert: true });
                const currentText = ctx.callbackQuery.message.text || 'Заказ';
                return ctx.editMessageText(currentText + `\n\n❌ ОТМЕНЕН РЕСТОРАНОМ`).catch(() => {});
            }
            
            if (orderCheck.courier_id && orderCheck.courier_id !== courierId) {
                await ctx.answerCbQuery("❌ Опоздали! Заказ взял другой курьер", { show_alert: true });
                const currentText = ctx.callbackQuery.message.text || 'Заказ';
                return ctx.editMessageText(currentText + `\n\n❌ ЗАБРАЛ ДРУГОЙ КУРЬЕР`).catch(() => {});
            }

            let newBalance = courierCheck.balance || 0;

            // 👉 ЛОГИКА НАЗНАЧЕНИЯ В БАЗЕ (Ручной вызов vs Обычный заказ)
            if (orderCheck.is_manual) {
                newBalance -= 20;
                await supabase.from('orders').update({ courier_id: courierId, status: 'completed' }).eq('id', orderId);
                await supabase.from('couriers').update({ balance: newBalance }).eq('id', courierId);
            } else {
                await supabase.from('orders').update({ courier_id: courierId }).eq('id', orderId);
            }

            const { data: courierData } = await supabase.from('couriers').select('name, phone').eq('id', courierId).maybeSingle();
            const cName = courierData?.name || ctx.from.first_name || 'Курьер';
            const cPhone = courierData?.phone || 'Номер не указан';
            
            const notifyMessage = `🛵 Курьер едет за заказом #${String(orderId).slice(0,5)}\n👤 Курьер: ${cName}\n📞 Телефон: ${cPhone}`;
            try { await bot.telegram.sendMessage(ADMIN_GROUP_ID, notifyMessage); } catch(e) { console.error("Не смог отправить админу", e.message); }
            
            if (orderCheck.restaurant) {
                const { data: restData } = await supabase.from('restaurants').select('id').eq('name', orderCheck.restaurant).maybeSingle();
                if (restData) {
                    try { await restBot.telegram.sendMessage(restData.id, notifyMessage); } catch(e) { console.error("Не смог отправить в рест", e.message); }
                }
            }

            // ИСПРАВЛЕНИЕ БАГА ГРУППЫ: Изменяем текст максимально безопасно
            const groupMsg = ctx.callbackQuery.message.text || `Заказ #${String(orderId).slice(0,5)}`;
            await ctx.editMessageText(`${groupMsg}\n\n✅ ЗАКАЗ ВЗЯЛ: ${cName}`).catch((e) => console.error("Ошибка editMessageText:", e.message));
            
            await ctx.answerCbQuery("✅ Вы назначены на заказ! Подробности в ЛС.");

            // 👉 ФОРМИРУЕМ СООБЩЕНИЕ В ЛИЧКУ КУРЬЕРУ
            let privateText = '';
            const buttons = [];

            if (orderCheck.is_manual) {
                privateText = `📦 <b>Детали РУЧНОГО заказа #${String(orderId).slice(0,5)}</b>\n` +
                              `📍 Забрать из: <b>${safeHtml(orderCheck.restaurant)}</b>\n` +
                              `📞 <b>Данные клиента:</b>\n${safeHtml(orderCheck.address)}\n\n` +
                              `💸 Комиссия за заказ: 20 сом\n` +
                              `💳 Остаток Баланса: ${newBalance} сом`;
            } else {
                buttons.push([Markup.button.callback('📦 Я взял заказ (Еду к клиенту)', `courier_picked_up_${orderId}`)]);

                let deliveryPriceText = 0;
                let foodPrice = 0;
                try { 
                    const itemsArr = Array.isArray(orderCheck.items) ? orderCheck.items : JSON.parse(orderCheck.items || '[]');
                    itemsArr.forEach(i => {
                        const price = Number(i.price || (i.item ? i.item.price : 0)) || 0;
                        const count = Number(i.count) || 0;
                        foodPrice += price * count;
                    });
                    deliveryPriceText = Math.max(0, (orderCheck.total_price || 0) - foodPrice);
                } catch(e) {
                    console.error("Ошибка парсинга цены доставки", e);
                }

                let addressSuffix = '';
                let displayComment = orderCheck.comment || 'Нет комментариев';

                if (displayComment.includes('🏪 Адрес ресторана:')) {
                    const parts = displayComment.split(' | ');
                    const addrPart = parts.find(p => p.includes('🏪 Адрес ресторана:'));
                    if (addrPart) {
                        addressSuffix = ` (${addrPart.replace('🏪 Адрес ресторана:', '').trim()})`;
                        displayComment = parts.filter(p => !p.includes('🏪 Адрес ресторана:')).join(' | ') || 'Нет комментариев';
                    }
                }
                const fullRestName = `${orderCheck.restaurant || 'Не указан'}${addressSuffix}`;

                privateText = `📦 <b>Детали заказа #${String(orderId).slice(0,5)}</b>\n\n` +
                              `💰 <b>Заработок за доставку:</b> <u>${deliveryPriceText} сом</u>\n\n` +
                              `📍 Ресторан: <b>${safeHtml(fullRestName)}</b>\n\n` + 
                              `👤 <b>Клиент:</b> ${safeHtml(orderCheck.client_name || 'Гость')}\n` +
                              `📞 <b>Номер:</b> <code>${safeHtml(orderCheck.phone || 'Не указан')}</code>\n` +
                              `📍 <b>Адрес доставки:</b> <u>${safeHtml(orderCheck.address || 'Не указан')}</u>\n` +
                              `💬 <b>Комментарий:</b> <i>${safeHtml(displayComment)}</i>\n`; 

                const lat = orderCheck.lat || orderCheck.latitude;
                const lon = orderCheck.lon || orderCheck.longitude;
                if (lat && lon) {
                    const gisUrl = `https://2gis.kg/geo/${lon},${lat}`;
                    privateText += `\n🗺 <b>Карта:</b> <a href="${gisUrl}">Открыть точку в 2GIS</a>\n`;
                    buttons.push([Markup.button.url('🧭 Маршрут в 2GIS', gisUrl)]);
                }

                if (orderCheck.client_id && orderCheck.client_id != 111) {
                    buttons.push([Markup.button.url('💬 Написать клиенту', `tg://user?id=${orderCheck.client_id}`)]);
                }
            }

            // Отправляем в личку курьеру
            await courierBot.telegram.sendMessage(courierId, privateText, {
                parse_mode: 'HTML',
                ...(buttons.length > 0 ? Markup.inlineKeyboard(buttons) : {})
            });
            console.log("[КУРЬЕР] Успешно отправили данные в ЛС курьеру!");

        } catch (err) {
            console.error("❌ Фатальная ошибка при взятии заказа курьером:", err);
            try { await ctx.answerCbQuery("❌ Ошибка сервера", {show_alert: true}); } catch(e){}
        }
    });

    // ==========================================
    // 2. КУРЬЕР ЗАБРАЛ ЗАКАЗ (В ПУТИ)
    // ==========================================
    courierBot.action(/courier_picked_up_(.+)/, async (ctx) => {
        const orderId = ctx.match[1].trim();
        const courierId = ctx.from.id; 

        try {
            await supabase.from('orders').update({ status: 'delivery' }).eq('id', orderId);

            const { data: order } = await supabase.from('orders').select('client_id, is_manual').eq('id', orderId).maybeSingle();
            const { data: courierData } = await supabase.from('couriers').select('name, phone').eq('id', courierId).maybeSingle();
            
            const cName = courierData?.name || ctx.from.first_name || 'Курьер';
            const cPhone = courierData?.phone || 'Номер не указан';

            if (order && order.client_id && order.client_id != 111 && !order.is_manual) {
                const clientMessage = `🚀 Курьер взял заказ и летит к вам!\n\n👤 Курьер: <b>${cName}</b>\n📞 Телефон: ${cPhone}`;
                try { await bot.telegram.sendMessage(order.client_id, clientMessage, { parse_mode: 'HTML' }); } catch(e){}
            }

            const buttons = [[Markup.button.callback('✅ Я доставил заказ', `courier_delivered_${orderId}`)]];
            if (order && order.client_id && order.client_id != 111 && !order.is_manual) {
                buttons.push([Markup.button.url('💬 Написать клиенту', `tg://user?id=${order.client_id}`)]);
            }

            const oldText = ctx.callbackQuery.message.text || '';
            await ctx.editMessageText(oldText + `\n\n🛵 ВЫ В ПУТИ К КЛИЕНТУ!\nКак только отдадите еду, нажмите кнопку:`, Markup.inlineKeyboard(buttons));
            await ctx.answerCbQuery("Выехали к клиенту!");
        } catch (err) {
            console.error("Ошибка при статусе 'в пути':", err);
            try { await ctx.answerCbQuery("❌ Ошибка", {show_alert: true}); } catch(e){}
        }
    });

    // ==========================================
    // 3. КУРЬЕР ДОСТАВИЛ ЗАКАЗ
    // ==========================================
    courierBot.action(/courier_delivered_(.+)/, async (ctx) => {
        const orderId = ctx.match[1].trim();
        const courierId = ctx.from.id; 

        try {
            await supabase.from('orders').update({ status: 'completed' }).eq('id', orderId);

            const { data: order } = await supabase.from('orders').select('client_id, items, total_price, is_manual').eq('id', orderId).maybeSingle();
            
            let commission = 0;

            if (order && order.is_manual) {
                commission = 20; 
            } else if (order) {
                let foodPrice = 0;
                try { 
                    const itemsArr = Array.isArray(order.items) ? order.items : JSON.parse(order.items || '[]');
                    itemsArr.forEach(i => {
                        const price = Number(i.price || (i.item ? i.item.price : 0)) || 0;
                        const count = Number(i.count) || 0;
                        foodPrice += price * count;
                    });
                } catch(e) {}
                
                const deliveryPrice = Math.max(0, (order.total_price || 0) - foodPrice);
                commission = Math.round(deliveryPrice * 0.10); 
            }

            const { data: cData } = await supabase.from('couriers').select('balance').eq('id', courierId).maybeSingle();
            if (cData) {
                const newBalance = (cData.balance || 0) - commission;
                await supabase.from('couriers').update({ balance: newBalance }).eq('id', courierId);
                try { await courierBot.telegram.sendMessage(courierId, `💸 Комиссия за заказ: ${commission} сом.\n💳 Остаток Баланса: ${newBalance} сом.`); } catch(e) {}
            }

            if (order && order.client_id && order.client_id != 111 && !order.is_manual) {
                try { await bot.telegram.sendMessage(order.client_id, `🎉 Заказ успешно доставлен!\nПриятного аппетита 🍔😋`); } catch(e){}
            }

            const oldText = ctx.callbackQuery.message.text || '';
            await ctx.editMessageText(oldText + `\n\n🎉 ЗАКАЗ УСПЕШНО ДОСТАВЛЕН!`).catch(() => {});
            await ctx.answerCbQuery("Отличная работа!");
        } catch (err) {
            console.error("Ошибка при статусе 'доставлен':", err);
            try { await ctx.answerCbQuery("❌ Ошибка", {show_alert: true}); } catch(e){}
        }
    });
};