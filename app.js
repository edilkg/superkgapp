// === НАСТРОЙКИ ГОРОДА ПО УМОЛЧАНИЮ ===
let globalCity = "Чолпон-Ата";

// Математика доставки
function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; 
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon/2) * Math.sin(dLon/2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function calculateDynamicDeliveryFee(resLat, resLon, cLat, cLon) {
    const straightDist = getDistance(resLat, resLon, cLat, cLon);
    const realDist = straightDist * 1.3; 
    let baseFee = 100; // Подача
    if (realDist > 1) baseFee += (realDist - 1) * 20; // 20 сом за км
    return Math.round(baseFee);
}

const tg = window.Telegram.WebApp;
tg.expand();

let totalSum = 0;
let currentDeliveryFee = 100; 
let currentRestaurantId = null;
let cartItems = {}; 
let cartActiveTabResId = null; 

// Переменные карты
let checkoutMap;
let checkoutClientMarker;
let checkoutResMarker; 
let clientLat = null;
let clientLon = null;

// Хранилище заполненного адреса (удалены Дом и Этаж)
let orderAddressData = { street: '', pod: '', kv: '', comment: '' };

const imgs = {
    asian: ['https://images.unsplash.com/photo-1579871494447-9811cf80d66c?w=300'],
    fastfood: ['https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=100'],
    pizza: ['https://images.unsplash.com/photo-1574071318508-1cdbab80d002?w=300']
};

const database = {
    'asian1': { lat: 42.6482, lon: 77.0855, city: 'Чолпон-Ата', title: 'Дракон Суши', logo: imgs.asian[0], address: 'ул. Советская, Чолпон-Ата', rating: 4.7, tags: ['sushi', 'promo'], img: imgs.asian[0], categories: ['Холодные роллы'], items: [{id: 'a1', cat: 'Холодные роллы', name: 'Филадельфия', price: 350, img: imgs.asian[0]}] },
    'fast1': { lat: 42.6490, lon: 77.0870, city: 'Чолпон-Ата', title: 'Burger Spot', logo: imgs.fastfood[0], address: 'ул. Горького, Чолпон-Ата', rating: 4.2, tags: ['fastfood'], img: imgs.fastfood[0], categories: ['Бургеры'], items: [{id: 'f1', cat: 'Бургеры', name: 'Чизбургер', price: 250, img: imgs.fastfood[0]}] },
    'piz1': { lat: 42.6346, lon: 77.1950, city: 'Чолпон-Ата', title: 'Roma Pizza (Бостери)', logo: imgs.pizza[0], address: 'Бостери, Центр', rating: 4.8, tags: ['pizza', 'top'], img: imgs.pizza[0], categories: ['Пицца'], items: [{id: 'p1', cat: 'Пицца', name: 'Маргарита', price: 450, img: imgs.pizza[0]}] }
};

// Навигация
history.replaceState({screen: 'main'}, '');

function showScreen(screenId) {
    ['screen-main', 'screen-menu', 'screen-cart-list', 'screen-checkout', 'screen-status', 'modal-map'].forEach(id => document.getElementById(id).classList.add('hidden'));
    document.getElementById('screen-'+screenId).classList.remove('hidden');
    document.getElementById('cart-float-btn').style.display = (totalSum > 0 && ['main', 'menu'].includes(screenId)) ? 'flex' : 'none';
}

function onNavClick(type) {
    tg.HapticFeedback.impactOccurred('light');
    if (type === 'main') showScreen('main');
    if (type === 'cart') { if(totalSum === 0) return alert("Корзина пуста"); openCartList(); }
    if (type === 'profile') openProfileModal();
}

function onBackClick() { history.back(); }

window.addEventListener('popstate', function(event) {
    if (!event.state) { showScreen('main'); return; }
    const st = event.state;
    if (st.screen) {
        showScreen(st.screen);
        if (st.page === 'menu' && st.resId) { currentRestaurantId = st.resId; renderRestaurantMenu(); }
    } else if (st.modal) {
        if (st.modal === 'map') {
            document.getElementById('modal-map').classList.remove('hidden');
            setTimeout(() => checkoutMap.invalidateSize(), 50);
        } else if (st.modal === 'profile') {
            document.getElementById('modal-profile').classList.remove('hidden');
        } else if (st.modal === 'address') {
            document.getElementById('modal-address').classList.remove('hidden');
        }
    }
});

// Отрисовка
function renderRestaurants() {
    const list = document.getElementById('restaurant-list');
    let html = '';
    Object.keys(database).forEach(key => {
        const res = database[key];
        if(res.city !== globalCity) return;
        html += `<div class="res-card" onclick="openMenu('${key}')"><img src="${res.img}" class="res-img"><div class="res-info"><div class="res-name"><span>${res.title}</span><span>★ ${res.rating}</span></div><div class="res-desc">${res.address}</div></div></div>`;
    });
    list.innerHTML = html;
}
renderRestaurants();

function toggleFilter(el, tag) {
    document.querySelectorAll('.cat-circle').forEach(c => c.classList.remove('active'));
    el.classList.add('active');
}

function toggleTagFilter(el, tag) {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    el.classList.add('active');
}

function handleSearch() {}

function openMenu(resId) {
    currentRestaurantId = resId;
    const res = database[resId];
    document.getElementById('menu-title').innerText = res.title;
    document.getElementById('menu-logo').src = res.logo;
    renderRestaurantMenu();
    history.pushState({screen: 'menu', page: 'menu', resId: resId}, '');
    showScreen('menu');
}

function renderRestaurantMenu() {
    const res = database[currentRestaurantId];
    let html = `<h3 class="cat-section-title">Меню</h3><div class="products-grid">`;
    res.items.forEach(item => {
        let count = cartItems[item.id] ? cartItems[item.id].count : 0;
        html += `
        <div class="item-card">
            <div class="img-wrap"><img src="${item.img}" class="item-img">
                ${count > 0 ? `<div class="counter-inline"><div onclick="updateCart('${item.id}', -1)">−</div><div class="c-val">${count}</div><div onclick="updateCart('${item.id}', 1)">+</div></div>` : `<div class="btn-add-img" onclick="updateCart('${item.id}', 1)">+</div>`}
            </div>
            <div class="item-info"><div class="item-price">${item.price} сом</div><div class="item-name">${item.name}</div></div>
        </div>`;
    });
    document.getElementById('all-products-container').innerHTML = html + `</div>`;
}

function updateCart(itemId, delta) {
    tg.HapticFeedback.impactOccurred('light'); 
    const item = database[currentRestaurantId].items.find(i => i.id === itemId);
    if(!cartItems[itemId]) cartItems[itemId] = { count: 0, item: item, pricePerUnit: item.price, resId: currentRestaurantId };
    cartItems[itemId].count += delta; 
    if(cartItems[itemId].count <= 0) delete cartItems[itemId]; 
    recalcTotal(); renderRestaurantMenu();
}

function recalcTotal() {
    totalSum = 0; let totalCount = 0;
    for(let k in cartItems) { totalSum += (cartItems[k].pricePerUnit * cartItems[k].count); totalCount += cartItems[k].count; }
    document.getElementById('total-price-btn').innerText = totalSum + " сом";
    document.getElementById('cart-items-count').innerText = totalCount;
    document.getElementById('cart-float-btn').style.display = totalSum > 0 ? 'flex' : 'none';
}

function openCartList() {
    let resIds = [...new Set(Object.values(cartItems).map(c => c.resId))];
    if(!cartActiveTabResId || !resIds.includes(cartActiveTabResId)) cartActiveTabResId = resIds[0];
    renderCartListItems(); 
    history.pushState({screen: 'cart-list'}, ''); showScreen('cart-list');
}

function renderCartListItems() {
    let html = ''; let sum = 0;
    for(let key in cartItems) { 
        let c = cartItems[key]; 
        if(c.resId === cartActiveTabResId) { 
            sum += (c.pricePerUnit * c.count); 
            html += `<div class="cart-item-row"><img src="${c.item.img}"><div class="cart-item-info"><div class="cart-item-title">${c.item.name}</div><div class="cart-item-price">${c.pricePerUnit} сом</div></div><div class="cart-item-counter"><div onclick="updateCartListCount('${key}', -1)">−</div><div style="cursor:default; width:20px; text-align:center;">${c.count}</div><div onclick="updateCartListCount('${key}', 1)">+</div></div></div>`; 
        } 
    }
    document.getElementById('cart-list-container').innerHTML = html; 
    document.getElementById('cart-list-total-sum').innerText = sum + " сом"; 
    document.getElementById('cart-list-delivery').innerText = (sum > 0 ? currentDeliveryFee : 0) + " сом";
}

function updateCartListCount(key, delta) {
    cartItems[key].count += delta; 
    if(cartItems[key].count <= 0) delete cartItems[key]; 
    recalcTotal();
    if(totalSum === 0) { showScreen('main'); return; }
    renderCartListItems();
}

function openClearCartModal() {
    document.getElementById('modal-clear-cart').classList.remove('hidden');
}

function executeClearCart() {
    for(let k in cartItems) { if(cartItems[k].resId === cartActiveTabResId) delete cartItems[k]; } 
    recalcTotal(); document.getElementById('modal-clear-cart').classList.add('hidden');
    if(totalSum === 0) { showScreen('main'); } else { renderCartListItems(); }
}

function openAddressModal() {
    document.getElementById('modal-city-select').value = globalCity;
    document.getElementById('modal-address').classList.remove('hidden');
    history.pushState({modal: 'address'}, '');
}

function saveAddressModal() {
    globalCity = document.getElementById('modal-city-select').value;
    document.getElementById('hdr-addr').innerText = globalCity;
    onBackClick();
    renderRestaurants();
}

function openProfileModal() {
    renderSavedAddressesInProfile();
    document.getElementById('modal-profile').classList.remove('hidden');
    history.pushState({modal: 'profile'}, '');
}

// ==========================================
// ОФОРМЛЕНИЕ И КАРТА
// ==========================================
function goToCheckout() {
    if(totalSum === 0) return;
    const activeRes = database[cartActiveTabResId];
    
    if (!clientLat) {
        let saved = JSON.parse(localStorage.getItem('tamak_saved_addresses') || '[]');
        if (saved.length > 0) {
            selectSavedAddressData(saved[0]);
        } else {
            clientLat = activeRes.lat + 0.005;
            clientLon = activeRes.lon + 0.005;
        }
    }

    document.getElementById('pickup-address').innerText = activeRes.address; 
    setDeliveryMode('delivery'); 
    renderSavedAddressesUI(); 
    updateCheckoutSummaryUI();

    history.pushState({screen: 'checkout'}, ''); showScreen('checkout');
}

function openMapModal() {
    document.getElementById('modal-map').classList.remove('hidden');
    history.pushState({modal: 'map'}, '');
    
    const activeRes = database[cartActiveTabResId];
    setTimeout(() => { initCheckoutMap(activeRes.lat, activeRes.lon); }, 50);
    
    // Заполняем поля
    document.getElementById('map-street').value = orderAddressData.street;
    document.getElementById('map-pod').value = orderAddressData.pod;
    document.getElementById('map-kv').value = orderAddressData.kv;
    document.getElementById('map-comment').value = orderAddressData.comment;
}

function confirmMapAddress() {
    orderAddressData.street = document.getElementById('map-street').value;
    orderAddressData.pod = document.getElementById('map-pod').value;
    orderAddressData.kv = document.getElementById('map-kv').value;
    orderAddressData.comment = document.getElementById('map-comment').value;

    if (!orderAddressData.street) return alert("Пожалуйста, укажите улицу и дом!");

    updateCheckoutSummaryUI();
    updateReceipt();
    onBackClick();
}

function updateCheckoutSummaryUI() {
    let title = "Укажите адрес на карте";
    let details = "Нажмите, чтобы выбрать";

    if (orderAddressData.street) {
        title = orderAddressData.street;
        let extra = [];
        if(orderAddressData.pod) extra.push(`под.${orderAddressData.pod}`);
        if(orderAddressData.kv) extra.push(`кв.${orderAddressData.kv}`);
        details = extra.length > 0 ? extra.join(', ') : "Можно указать подъезд и квартиру";
    }

    document.getElementById('checkout-summary-address').innerText = title;
    document.getElementById('checkout-summary-details').innerText = details;
}

// --- Геокодирование на Карте (Поиск объединен с полем "Улица и дом") ---
async function geocodeAddressFromInput() {
    const query = document.getElementById('map-street').value;
    if (!query) return;

    try {
        const response = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(globalCity + ', ' + query)}&accept-language=ru`);
        const data = await response.json();
        if (data && data.length > 0) {
            clientLat = parseFloat(data[0].lat);
            clientLon = parseFloat(data[0].lon);
            if (checkoutMap) { checkoutMap.setView([clientLat, clientLon], 16); checkoutClientMarker.setLatLng([clientLat, clientLon]); }
            recalcCheckoutDelivery(database[cartActiveTabResId].lat, database[cartActiveTabResId].lon);
        }
    } catch (err) {}
}

async function reverseGeocode(lat, lon) {
    try {
        const response = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&accept-language=ru`);
        const data = await response.json();
        if (data && data.address) {
            let street = data.address.road || data.address.pedestrian || data.address.village || "";
            let house = data.address.house_number || data.address.building || "";
            
            let fullAddress = street;
            if (street && house) fullAddress += ", " + house;
            else if (house) fullAddress = house;

            if (fullAddress) document.getElementById('map-street').value = fullAddress;
        }
    } catch(e) {}
    recalcCheckoutDelivery(database[cartActiveTabResId].lat, database[cartActiveTabResId].lon);
}

function initCheckoutMap(resLat, resLon) {
    if (!checkoutMap) {
        checkoutMap = L.map('fullscreen-map').setView([clientLat, clientLon], 15);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(checkoutMap);
        
        const resIcon = L.icon({ iconUrl: 'https://cdn-icons-png.flaticon.com/512/3180/3180209.png', iconSize: [32, 32] });
        checkoutResMarker = L.marker([resLat, resLon], {icon: resIcon}).addTo(checkoutMap).bindPopup("Ресторан");
        
        const clientIcon = L.icon({ iconUrl: 'https://cdn-icons-png.flaticon.com/512/149/149059.png', iconSize: [36, 36], iconAnchor: [18, 36] });
        checkoutClientMarker = L.marker([clientLat, clientLon], {icon: clientIcon, draggable: true}).addTo(checkoutMap).bindPopup("Доставить сюда").openPopup();
        
        checkoutClientMarker.on('dragend', function (e) {
            clientLat = e.target.getLatLng().lat; clientLon = e.target.getLatLng().lng;
            reverseGeocode(clientLat, clientLon);
        });

        checkoutMap.on('click', function(e) {
            clientLat = e.latlng.lat; clientLon = e.latlng.lng;
            checkoutClientMarker.setLatLng([clientLat, clientLon]);
            reverseGeocode(clientLat, clientLon);
        });
    } else {
        checkoutMap.setView([clientLat, clientLon], 15);
        checkoutClientMarker.setLatLng([clientLat, clientLon]);
        checkoutResMarker.setLatLng([resLat, resLon]);
    }
    recalcCheckoutDelivery(resLat, resLon);
}

function recalcCheckoutDelivery(resLat, resLon) {
    currentDeliveryFee = calculateDynamicDeliveryFee(resLat, resLon, clientLat, clientLon);
    document.getElementById('modal-map-price').innerText = currentDeliveryFee + ' сом';
}

function locateUser() {
    if (!navigator.geolocation) return alert("Браузер не поддерживает GPS");
    tg.HapticFeedback.impactOccurred('medium');
    const btn = document.querySelector('.btn-locate');
    const originalIcon = btn.innerText;
    btn.innerText = '⏳';

    navigator.geolocation.getCurrentPosition(
        async (position) => {
            btn.innerText = originalIcon;
            clientLat = position.coords.latitude; clientLon = position.coords.longitude;
            if (checkoutMap) { checkoutMap.setView([clientLat, clientLon], 16); checkoutClientMarker.setLatLng([clientLat, clientLon]); }
            await reverseGeocode(clientLat, clientLon);
        },
        (error) => {
            btn.innerText = originalIcon;
            if (error.code === 1) alert("Разрешите доступ к геолокации");
        },
        { enableHighAccuracy: true, timeout: 10000 }
    );
}

// --- Логика Сохранения Адресов ---
function saveCurrentAddress() {
    if (!orderAddressData.street) return alert("Сначала выберите адрес на карте!");
    let saved = JSON.parse(localStorage.getItem('tamak_saved_addresses') || '[]');
    if (saved.find(a => a.street === orderAddressData.street && a.kv === orderAddressData.kv)) return alert("Этот адрес уже сохранен!");

    let text = orderAddressData.street;
    if (orderAddressData.kv) text += `, кв.${orderAddressData.kv}`;

    saved.unshift({ text: text, ...orderAddressData, lat: clientLat, lon: clientLon });
    localStorage.setItem('tamak_saved_addresses', JSON.stringify(saved));
    renderSavedAddressesUI();
    tg.HapticFeedback.notificationOccurred('success');
}

function deleteSavedAddress(index) {
    let saved = JSON.parse(localStorage.getItem('tamak_saved_addresses') || '[]');
    saved.splice(index, 1);
    localStorage.setItem('tamak_saved_addresses', JSON.stringify(saved));
    renderSavedAddressesUI();
}

function selectSavedAddress(index) {
    let saved = JSON.parse(localStorage.getItem('tamak_saved_addresses') || '[]');
    if (saved[index]) selectSavedAddressData(saved[index]);
}

function selectSavedAddressData(data) {
    orderAddressData.street = data.street;
    orderAddressData.pod = data.pod || '';
    orderAddressData.kv = data.kv || '';
    orderAddressData.comment = data.comment || '';
    clientLat = data.lat;
    clientLon = data.lon;
    updateCheckoutSummaryUI();
    updateReceipt();
}

function renderSavedAddressesUI() {
    let saved = JSON.parse(localStorage.getItem('tamak_saved_addresses') || '[]');
    const wrapper = document.getElementById('saved-addresses-wrapper');
    if (saved.length === 0) { wrapper.classList.add('hidden'); return; }
    wrapper.classList.remove('hidden');
    document.getElementById('saved-addresses-list').innerHTML = saved.map((a, i) => `
        <div class="saved-addr-card">
            <div class="saved-addr-info" onclick="selectSavedAddress(${i})">📍 ${a.text}</div>
            <div class="saved-addr-del" onclick="deleteSavedAddress(${i})">✕</div>
        </div>
    `).join('');
}

function renderSavedAddressesInProfile() {
    let saved = JSON.parse(localStorage.getItem('tamak_saved_addresses') || '[]');
    const container = document.getElementById('profile-address-text');
    if (saved.length === 0) container.innerHTML = "У вас пока нет сохраненных адресов.";
    else container.innerHTML = saved.map(a => `<div style="padding: 8px 0; border-bottom: 1px solid #eee;">📍 ${a.text}</div>`).join('');
}

// --- Финал и Оплата ---
function setDeliveryMode(mode) {
    document.getElementById('tab-delivery').classList.remove('active');
    document.getElementById('tab-pickup').classList.remove('active');
    if (mode === 'delivery') {
        document.getElementById('tab-delivery').classList.add('active');
        document.getElementById('block-delivery').classList.remove('hidden');
        document.getElementById('block-pickup').classList.add('hidden');
        if(clientLat && clientLon) currentDeliveryFee = calculateDynamicDeliveryFee(database[cartActiveTabResId].lat, database[cartActiveTabResId].lon, clientLat, clientLon);
    } else {
        document.getElementById('tab-pickup').classList.add('active');
        document.getElementById('block-delivery').classList.add('hidden');
        document.getElementById('block-pickup').classList.remove('hidden');
        currentDeliveryFee = 0;
    }
    updateReceipt();
}

function updateReceipt() {
    let tabTotalSum = 0; 
    for(let k in cartItems) { if(cartItems[k].resId === cartActiveTabResId) tabTotalSum += (cartItems[k].pricePerUnit * cartItems[k].count); }
    document.getElementById('check-items').innerText = tabTotalSum + ' сом';
    document.getElementById('check-delivery').innerText = currentDeliveryFee + ' сом';
    document.getElementById('check-total').innerText = (tabTotalSum + currentDeliveryFee) + ' сом';
    document.getElementById('pay-btn-sum').innerText = (tabTotalSum + currentDeliveryFee) + ' сом';
}

async function createOrder() {
    if (!orderAddressData.street && currentDeliveryFee > 0) return alert("Пожалуйста, укажите адрес доставки!");
    
    const payBtn = document.getElementById('main-pay-btn');
    const originalBtnText = payBtn.innerText;
    payBtn.innerText = '⏳ Обработка...';
    payBtn.style.pointerEvents = 'none';
    payBtn.style.opacity = '0.7';

    const fullAddress = `${orderAddressData.street}, кв.${orderAddressData.kv} (Под:${orderAddressData.pod})`;
    
    const orderData = {
        type: 'food', 
        user: tg.initDataUnsafe?.user || { id: 111, first_name: "Тест Юзер" }, 
        address: fullAddress, 
        dest_lat: clientLat, 
        dest_lon: clientLon, 
        restaurantName: database[cartActiveTabResId]?.title || "Ресторан",
        totalPrice: totalSum + currentDeliveryFee,
        comment: orderAddressData.comment,
        items: Object.values(cartItems).filter(item => item.resId === cartActiveTabResId)
    };

    tg.HapticFeedback.notificationOccurred('success');
    
    try {
        const response = await fetch('https://tamak-backend.onrender.com/web-data', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(orderData)
        });
        if (response.ok) {
            showScreen('status');
            document.getElementById('st-res-name').innerText = database[cartActiveTabResId]?.title;
            document.getElementById('st-total').innerText = (totalSum + currentDeliveryFee) + " сом";
            for(let k in cartItems) { if(cartItems[k].resId === cartActiveTabResId) delete cartItems[k]; }
            recalcTotal();
        }
    } catch (e) { 
        alert("Ошибка сети"); 
    } finally {
        payBtn.innerText = originalBtnText;
        payBtn.style.pointerEvents = 'auto';
        payBtn.style.opacity = '1';
    }
}