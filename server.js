const WebSocket = require('ws');
const axios = require('axios');
const express = require('express');
const { initializeApp } = require('firebase/app');
const { getFirestore, doc, setDoc, collection, getDocs, query } = require('firebase/firestore');
const { getAuth, signInAnonymously } = require('firebase/auth');

// --- 設定 (RenderのEnvironment Variablesから取得) ---
const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG || '{}');
const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN;
const APP_ID = process.env.APP_ID || 'earthquake-fast-notify';

// Firebase初期化
const fbApp = initializeApp(firebaseConfig);
const db = getFirestore(fbApp);
const auth = getAuth(fbApp);

const app = express();
app.use(express.json());

// --- 1. トップページ (Renderのスリープ防止 & 動作確認用) ---
app.get('/', (req, res) => {
    res.send('地震通知サーバー稼働中 (OK)');
});

// --- 2. LINE Webhook (郵便番号の登録処理) ---
app.post('/webhook', async (req, res) => {
    const events = req.body.events;
    if (!events || events.length === 0) return res.sendStatus(200);

    for (let event of events) {
        if (event.type === 'message' && event.message.type === 'text') {
            const userId = event.source.userId;
            const text = event.message.text.replace(/-/g, '').trim(); // ハイフンを除去

            // 7桁の数字（郵便番号）か判定
            if (/^\d{7}$/.test(text)) {
                try {
                    // 郵便番号APIで住所を検索
                    const zipRes = await axios.get(`https://zipcloud.ibsnet.co.jp/api/search?zipcode=${text}`);
                    if (zipRes.data.results) {
                        const result = zipRes.data.results[0];
                        const fullAddr = result.address1 + result.address2 + result.address3;
                        const city = result.address2; // 市区町村名

                        // Firebaseに保存 (artifacts > APP_ID > users > LINE_ID > locations > 郵便番号)
                        const docRef = doc(db, 'artifacts', APP_ID, 'users', userId, 'locations', text);
                        await setDoc(docRef, {
                            zipcode: text,
                            address: fullAddr,
                            city: city,
                            createdAt: new Date()
                        });

                        await sendLineReply(event.replyToken, `✅ 登録完了！\n場所: ${fullAddr}\nこの地域で地震が観測されたら「初報」と「詳細」を通知します。`);
                    } else {
                        await sendLineReply(event.replyToken, '❌ 郵便番号が見つかりませんでした。正確な7桁の番号を送ってください。');
                    }
                } catch (e) {
                    console.error('Registration Error:', e);
                }
            }
        }
    }
    res.sendStatus(200);
});

// --- 3. P2P地震情報 WebSocket 監視 ---
function startEarthquakeMonitor() {
    const ws = new WebSocket('wss://api.p2pquake.net/v2/ws');

    ws.on('open', () => {
        console.log('✅ 地震監視システム稼働中 (WebSocket接続成功)');
    });

    ws.on('message', async (data) => {
        try {
            const json = JSON.parse(data);
            
            // A. 初報 (緊急地震速報など) - コード554/556
            if (json.code === 554 || json.code === 556) {
                console.log('📢 地震速報を受信');
                await handleEarlyWarning(json);
            }
            
            // B. 正確な情報 (各地の震度) - コード551
            if (json.code === 551) {
                console.log('📊 詳細な震度情報を受信');
                await handleDetailedReport(json);
            }
        } catch (err) {
            console.error('Data Process Error:', err);
        }
    });

    ws.on('close', () => {
        console.log('⚠️ WebSocket切断。5秒後に再接続します...');
        setTimeout(startEarthquakeMonitor, 5000);
    });

    ws.on('error', (err) => {
        console.error('WebSocket Error:', err.message);
    });
}

// --- 4. 初報の配信処理 (Broadcast) ---
async function handleEarlyWarning(data) {
    const areaName = data.area || (data.earthquake && data.earthquake.hypocenter.name) || '不明な地域';
    const message = `【⚠️ 初報・地震速報】\n震源付近: ${areaName}\nマグニチュード: ${data.earthquake?.hypocenter.magnitude || '調査中'}\n強い揺れに警戒してください。`;
    
    // 登録者全員に一斉送信
    await axios.post('https://api.line.me/v2/bot/message/broadcast', {
        messages: [{ type: 'text', text: message }]
    }, { headers: { 'Authorization': `Bearer ${LINE_ACCESS_TOKEN}` } });
}

// --- 5. 正確な情報の配信処理 (登録地域のみ) ---
async function handleDetailedReport(data) {
    if (!data.points) return;

    // 市区町村ごとの震度マップを作成
    const cityScaleMap = {};
    data.points.forEach(p => {
        cityScaleMap[p.addr] = convertScale(p.scale);
    });

    try {
        // Firebaseからユーザー一覧を取得
        const usersSnap = await getDocs(collection(db, 'artifacts', APP_ID, 'users'));
        
        for (let userDoc of usersSnap.docs) {
            const userId = userDoc.id;
            // ユーザーごとの登録地点を取得
            const locationsSnap = await getDocs(collection(db, 'artifacts', APP_ID, 'users', userId, 'locations'));
            
            for (let locDoc of locationsSnap.docs) {
                const regCity = locDoc.data().city; 
                
                // 登録した市区町村が揺れた地点リストにあるか照合
                const matchedCity = Object.keys(cityScaleMap).find(shakenCity => shakenCity.includes(regCity));
                
                if (matchedCity) {
                    const scale = cityScaleMap[matchedCity];
                    const message = `【📢 正確な地震情報】\n登録地域: ${regCity} 付近\n震度: ${scale}\n\n震源地: ${data.earthquake.hypocenter.name}\n最大震度: ${convertScale(data.earthquake.maxScale)}\n発生時刻: ${data.earthquake.time}`;
                    await sendLinePush(userId, message);
                    break; 
                }
            }
        }
    } catch (e) {
        console.error('Detailed Report Process Error:', e);
    }
}

// --- 6. ユーティリティ関数 ---
async function sendLineReply(token, text) {
    await axios.post('https://api.line.me/v2/bot/message/reply', {
        replyToken: token, messages: [{ type: 'text', text }]
    }, { headers: { 'Authorization': `Bearer ${LINE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } });
}

async function sendLinePush(to, text) {
    try {
        await axios.post('https://api.line.me/v2/bot/message/push', {
            to, messages: [{ type: 'text', text }]
        }, { headers: { 'Authorization': `Bearer ${LINE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } });
    } catch (e) {
        console.error('Line Push Error:', e.response?.data || e.message);
    }
}

function convertScale(s) {
    return { 10:'1', 20:'2', 30:'3', 40:'4', 45:'5弱', 50:'5強', 55:'6弱', 60:'6強', 70:'7' }[s] || '不明';
}

// --- 7. サーバー起動 ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`Server running on port ${PORT}`);
    try {
        await signInAnonymously(auth);
        console.log('🔥 Firebase 匿名認証成功');
        startEarthquakeMonitor();
    } catch (e) {
        console.error('Firebase Auth Error:', e.message);
    }
});
         
