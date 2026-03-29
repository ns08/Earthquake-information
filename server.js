const WebSocket = require('ws');
const axios = require('axios');
const express = require('express');
const { initializeApp } = require('firebase/app');
const { getFirestore, doc, setDoc, collection, getDocs } = require('firebase/firestore');
const { getAuth, signInAnonymously } = require('firebase/auth');

// --- 設定 (環境変数から取得) ---
const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG || '{}');
const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN;
const APP_ID = process.env.APP_ID || 'earthquake-fast-notify';

// Firebase初期化
const fbApp = initializeApp(firebaseConfig);
const db = getFirestore(fbApp);
const auth = getAuth(fbApp);

const app = express();
app.use(express.json());

// --- LINE Webhook: 郵便番号の登録処理 ---
app.post('/webhook', async (req, res) => {
    const events = req.body.events;
    if (!events) return res.sendStatus(200);

    for (let event of events) {
        if (event.type === 'message' && event.message.type === 'text') {
            const userId = event.source.userId;
            const text = event.message.text.replace(/-/g, '').trim();

            if (/^\d{7}$/.test(text)) {
                try {
                    // 郵便番号APIで住所特定
                    const zipRes = await axios.get(`https://zipcloud.ibsnet.co.jp/api/search?zipcode=${text}`);
                    if (zipRes.data.results) {
                        const result = zipRes.data.results[0];
                        const fullAddr = result.address1 + result.address2 + result.address3;
                        const city = result.address2; // 市区町村名 (例: 調布市)

                        // Firebaseに保存 (RULE 1)
                        const docRef = doc(db, 'artifacts', APP_ID, 'users', userId, 'locations', text);
                        await setDoc(docRef, {
                            zipcode: text,
                            address: fullAddr,
                            city: city,
                            createdAt: new Date()
                        });

                        await sendLineReply(event.replyToken, `✅ 登録完了！\n場所: ${fullAddr}\n今後、この地域で地震が観測されたら「初報」と「詳細」の両方を通知します。`);
                    } else {
                        await sendLineReply(event.replyToken, '❌ 郵便番号が見つかりませんでした。正しい7桁の番号を送信してください。');
                    }
                } catch (e) {
                    console.error('Registration Error:', e);
                }
            }
        }
    }
    res.sendStatus(200);
});

// --- P2P地震情報 WebSocket 監視 ---
function startEarthquakeMonitor() {
    const ws = new WebSocket('wss://api.p2pquake.net/v2/ws');

    ws.on('open', () => console.log('✅ 地震監視システム稼働中 (WebSocket)'));

    ws.on('message', async (data) => {
        try {
            const json = JSON.parse(data);
            
            // 1. 初報 (緊急地震速報など) - コード554/556
            if (json.code === 554 || json.code === 556) {
                await handleEarlyWarning(json);
            }
            
            // 2. 正確な情報 (震度速報/各地の震度) - コード551
            if (json.code === 551) {
                await handleDetailedReport(json);
            }
        } catch (err) {
            console.error('Data Process Error:', err);
        }
    });

    ws.on('close', () => {
        console.log('⚠️ 切断されました。再接続します...');
        setTimeout(startEarthquakeMonitor, 5000);
    });
}

// --- 初報の処理 ---
async function handleEarlyWarning(data) {
    // 初報は「都道府県」レベルでまず一致を確認
    const areaName = data.area || (data.earthquake && data.earthquake.hypocenter.name);
    const message = `【⚠️ 初報・地震速報】\n震源付近: ${areaName}\nマグニチュード: ${data.earthquake?.hypocenter.magnitude || '調査中'}\n強い揺れに警戒してください。`;
    
    // 全ユーザーに一斉送信（または都道府県一致でフィルタ）
    // ※無料枠を考慮し、ここでは登録者全員に「速報」として送る例
    await broadcastToAllUsers(message);
}

// --- 正確な情報の処理 ---
async function handleDetailedReport(data) {
    if (!data.points) return;

    // 震度情報を市区町村ごとに整理
    const cityScaleMap = {};
    data.points.forEach(p => {
        cityScaleMap[p.addr] = convertScale(p.scale);
    });

    // ユーザーごとに登録地点が揺れたかチェック
    // 本来はインデックスが必要だが、RULE 2に従い全取得してメモリ内でフィルタ
    const usersSnap = await getDocs(collection(db, 'artifacts', APP_ID, 'users'));
    
    for (let userDoc of usersSnap.docs) {
        const userId = userDoc.id;
        const locationsSnap = await getDocs(collection(db, 'artifacts', APP_ID, 'users', userId, 'locations'));
        
        for (let locDoc of locationsSnap.docs) {
            const regCity = locDoc.data().city; // 登録されている市区町村
            
            // 登録地点が揺れた地点に含まれているか
            const matchedCity = Object.keys(cityScaleMap).find(shakenCity => shakenCity.includes(regCity));
            
            if (matchedCity) {
                const scale = cityScaleMap[matchedCity];
                const message = `【📢 正確な地震情報】\n登録地域: ${regCity} 付近\n震度: ${scale}\n\n震源地: ${data.earthquake.hypocenter.name}\n最大震度: ${convertScale(data.earthquake.maxScale)}\n発生時刻: ${data.earthquake.time}`;
                await sendLinePush(userId, message);
                break; // 1ユーザーに同じ地震で複数回送らないようbreak
            }
        }
    }
}

// --- LINE送信ユーティリティ ---
async function sendLineReply(token, text) {
    await axios.post('https://api.line.me/v2/bot/message/reply', {
        replyToken: token, messages: [{ type: 'text', text }]
    }, { headers: { 'Authorization': `Bearer ${LINE_ACCESS_TOKEN}` } });
}

async function sendLinePush(to, text) {
    await axios.post('https://api.line.me/v2/bot/message/push', {
        to, messages: [{ type: 'text', text }]
    }, { headers: { 'Authorization': `Bearer ${LINE_ACCESS_TOKEN}` } });
}

async function broadcastToAllUsers(text) {
    // 簡易的な一斉送信 (Messaging APIのbroadcastを使用)
    await axios.post('https://api.line.me/v2/bot/message/broadcast', {
        messages: [{ type: 'text', text }]
    }, { headers: { 'Authorization': `Bearer ${LINE_ACCESS_TOKEN}` } });
}

function convertScale(s) {
    return { 10:'1', 20:'2', 30:'3', 40:'4', 45:'5弱', 50:'5強', 55:'6弱', 60:'6強', 70:'7' }[s] || '不明';
}

// --- 起動 ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`Server running on port ${PORT}`);
    await signInAnonymously(auth);
    startEarthquakeMonitor();
});
