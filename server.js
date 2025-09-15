// server.js
require('dotenv').config();
const express = require('express');
const admin = require('firebase-admin');
const path = require('path');


admin.initializeApp({
  credential: admin.credential.cert({
    type: process.env.FIREBASE_TYPE,
    projectId: process.env.FIREBASE_PROJECT_ID,
    privateKeyId: process.env.FIREBASE_PRIVATE_KEY_ID,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    clientId: process.env.FIREBASE_CLIENT_ID,
    authUri: process.env.FIREBASE_AUTH_URI,
    tokenUri: process.env.FIREBASE_TOKEN_URI,
    authProviderX509CertUrl: process.env.FIREBASE_AUTH_PROVIDER_X509_CERT_URL,
    clientC509CertUrl: process.env.FIREBASE_CLIENT_X509_CERT_URL,
    universeDomain: process.env.FIREBASE_UNIVERSE_DOMAIN,
  }),
  databaseURL: process.env.FIREBASE_DATABASE_URL,
});

const db = admin.database();
const app = express();
const PORT = process.env.PORT || 3000;

// Konfigurasi Express
app.use(express.json());
app.use(express.static('public'));

// --- KONFIGURASI GAME ---
// server.js

// ... (kode inisialisasi awal biarkan sama) ...

// --- KONFIGURASI GAME --- (tetap sama)
const GROUP_SIZE = 2;
const QUESTION_TIME_LIMIT = 30000;

// --- DATABASE SOAL BAHASA JEPANG --- (tetap sama)
const questions = [
    {
        id: "q1",
        question: "「これは＿＿ですか？」 (Kore wa ___ desu ka?) - Apa ini?",
        options: ["なに (nani)", "どこ (doko)", "だれ (dare)", "いつ (itsu)"],
        answer: "なに (nani)"
    },
    {
        id: "q2",
        question: "「私は＿＿です。」 (Watashi wa ___ desu.) - Saya adalah dokter.",
        options: ["いしゃ (isha)", "がくせい (gakusei)", "せんせい (sensei)", "かいしゃいん (kaishain)"],
        answer: "いしゃ (isha)"
    },
    {
        id: "q3",
        question: "「＿＿で勉強します。」 (___ de benkyoushimasu.) - Belajar di sekolah.",
        options: ["がっこう (gakkou)", "うち (uchi)", "えき (eki)", "みせ (mise)"],
        answer: "がっこう (gakkou)"
    },
    {
        id: "q6",
        question: "「＿＿が好きですか？」 (___ ga suki desu ka?) - Suka apa?",
        options: ["だれ (dare)", "なに (nani)", "どれ (dore)", "どう (dou)"],
        answer: "なに (nani)"
    },
    {
        id: "q7",
        question: "「りんごを二つ＿＿。」 (Ringo o futatsu ___.) - Tolong, dua buah apel.",
        options: ["ください (kudasai)", "あります (arimasu)", "ほしい (hoshii)", "です (desu)"],
        answer: "ください (kudasai)"
    },
     {
        id: "q8",
        question: "'Selamat pagi' dalam bahasa Jepang (formal).",
        options: ["こんにちは (Konnichiwa)", "おやすみ (Oyasumi)", "おはようございます (Ohayou gozaimasu)", "こんばんは (Konbanwa)"],
        answer: "おはようございます (Ohayou gozaimasu)"
    },
];
const groupTimers = {};

// Endpoint Login & Submit-Answer (tetap sama)
app.post('/login', async (req, res) => {
    const { token } = req.body;
    try {
        const decodedToken = await admin.auth().verifyIdToken(token);
        const { uid, name, picture } = decodedToken;
        await db.ref(`users/${uid}`).set({
            displayName: name,
            photoURL: picture,
            status: 'online',
            groupId: null
        });
        console.log(`User logged in: ${name} (${uid})`);
        await assignUserToGroup({ uid, displayName: name, photoURL: picture });
        res.status(200).send({ message: 'Login successful, assigning to group.' });
    } catch (error) {
        console.error('Error verifying token:', error);
        res.status(401).send({ message: 'Unauthorized' });
    }
});

// Ganti endpoint /submit-answer Anda dengan yang ini
app.post('/submit-answer', async (req, res) => {
    const { token, answer } = req.body;
    try {
        const decodedToken = await admin.auth().verifyIdToken(token);
        const { uid } = decodedToken;
        const userSnapshot = await db.ref(`users/${uid}`).once('value');
        const userData = userSnapshot.val();
        const groupId = userData.groupId;

        if (!groupId) return res.status(400).send({ message: "User not in a group." });

        const groupRef = db.ref(`groups/${groupId}`);
        const groupSnapshot = await groupRef.once('value');
        const groupData = groupSnapshot.val();
        const currentQuestion = groupData.currentQuestion;

        if (!currentQuestion || !currentQuestion.id) {
            return res.status(400).send({ message: "No active question." });
        }

        const questionData = questions.find(q => q.id === currentQuestion.id);

        if (questionData.answer.toLowerCase() === answer.toLowerCase()) {
            // Jawaban BENAR (Logika ini tidak berubah)
            clearTimeout(groupTimers[groupId]);
            delete groupTimers[groupId];

            const timeTaken = Date.now() - currentQuestion.startTime;
            const newScore = (groupData.score || 0) + 10;
            const newTotalTime = (groupData.totalTime || 0) + timeTaken;

            await groupRef.update({
                score: newScore,
                totalTime: newTotalTime
            });
            
            await db.ref(`answeredQuestions/${questionData.id}`).set(true);
            
            // Berikan soal baru untuk kedua grup agar adil
            await serveNextQuestionToAllGroups();
            res.status(200).send({ correct: true });
        } else {
            // ✅ PERUBAHAN UTAMA: Logika Jawaban SALAH
            
            // Hentikan timer grup yang salah menjawab
            clearTimeout(groupTimers[groupId]);
            delete groupTimers[groupId];

            // Panggil fungsi baru untuk melempar soal ke grup lawan
            await handleWrongAnswer(groupId, questionData.id);
            
            // Beri tahu klien bahwa jawaban mereka salah
            res.status(200).send({ correct: false });
        }
    } catch (error) {
        console.error('Error submitting answer:', error);
        res.status(500).send({ message: 'Server error.' });
    }
});
async function assignUserToGroup(user) {
    const groupsRef = db.ref('groups');
    const snapshot = await groupsRef.orderByChild('status').equalTo('waiting').once('value');
    const waitingGroups = snapshot.val();
    let assignedGroupId = null;

    if (waitingGroups) {
        for (const groupId in waitingGroups) {
            if (Object.keys(waitingGroups[groupId].members).length < GROUP_SIZE) {
                assignedGroupId = groupId;
                break;
            }
        }
    }

    if (assignedGroupId) {
        await db.ref(`groups/${assignedGroupId}/members/${user.uid}`).set({ displayName: user.displayName, photoURL: user.photoURL });
        await db.ref(`users/${user.uid}`).update({ groupId: assignedGroupId });
        const groupSnapshot = await db.ref(`groups/${assignedGroupId}`).once('value');
        if (Object.keys(groupSnapshot.val().members).length === GROUP_SIZE) {
            // HANYA UPDATE STATUS JADI 'READY', TIDAK MEMULAI GAME
            await db.ref(`groups/${assignedGroupId}`).update({ status: 'ready' });
        }
    } else {
        const newGroupRef = groupsRef.push();
        assignedGroupId = newGroupRef.key;
        await newGroupRef.set({
            createdAt: admin.database.ServerValue.TIMESTAMP,
            members: { [user.uid]: { displayName: user.displayName, photoURL: user.photoURL } },
            score: 0,
            totalTime: 0,
            status: 'waiting' // Status awal saat grup belum penuh
        });
        await db.ref(`users/${user.uid}`).update({ groupId: assignedGroupId });
    }
}
app.post('/admin/start-battle', async (req, res) => {
    try {
        // Reset soal yg pernah terjawab
        await db.ref('answeredQuestions').remove();

        const groupsRef = db.ref('groups');
        const snapshot = await groupsRef.orderByChild('status').equalTo('ready').once('value');
        const readyGroups = snapshot.val();

        if (!readyGroups) {
            return res.status(400).send({ message: "No groups are ready to start." });
        }

        // Mulai game untuk semua grup yang 'ready'
        const startPromises = Object.keys(readyGroups).map(async (groupId) => {
            await db.ref(`groups/${groupId}`).update({ status: 'playing' });
            await serveNextQuestion(groupId);
        });

        await Promise.all(startPromises);
        await db.ref('gameState').set({ status: 'in_progress' });
        res.status(200).send({ message: "Battle started for all ready groups!" });
    } catch (error) {
        console.error("Error starting battle:", error);
        res.status(500).send({ message: "Failed to start battle." });
    }
});

// Endpoint untuk mengulang seluruh sesi
app.post('/admin/restart-battle', async (req, res) => {
    try {
        // Hapus semua data sesi
        await db.ref('groups').remove();
        await db.ref('users').remove();
        await db.ref('answeredQuestions').remove();
        await db.ref('gameState').remove();

        // Hentikan semua timer aktif
        for (const timer in groupTimers) {
            clearTimeout(groupTimers[timer]);
        }
        
        res.status(200).send({ message: "Battle has been completely reset." });
    } catch (error) {
        console.error("Error restarting battle:", error);
        res.status(500).send({ message: "Failed to restart battle." });
    }
});

// Endpoint untuk menghapus satu grup
app.post('/admin/delete-group', async (req, res) => {
    const { groupId } = req.body;
    if (!groupId) return res.status(400).send({ message: "Group ID is required." });

    try {
        const groupSnapshot = await db.ref(`groups/${groupId}`).once('value');
        const groupData = groupSnapshot.val();

        if (groupData && groupData.members) {
            // Kembalikan user ke state tanpa grup
            const memberUpdates = Object.keys(groupData.members).map(uid => 
                db.ref(`users/${uid}/groupId`).remove()
            );
            await Promise.all(memberUpdates);
        }
        
        await db.ref(`groups/${groupId}`).remove();
        res.status(200).send({ message: `Group ${groupId} deleted.` });
    } catch (error) {
        console.error(`Error deleting group ${groupId}:`, error);
        res.status(500).send({ message: "Failed to delete group." });
    }
});


// 📍 DIUBAH: Fungsi serveNextQuestion dan handleTimeUp kini menyertakan 'options'
async function serveNextQuestion(groupId) {
    const answeredSnapshot = await db.ref('answeredQuestions').once('value');
    const answeredIds = answeredSnapshot.val() ? Object.keys(answeredSnapshot.val()) : [];
    const availableQuestions = questions.filter(q => !answeredIds.includes(q.id));

    if (availableQuestions.length > 0) {
        const randomQuestion = availableQuestions[Math.floor(Math.random() * availableQuestions.length)];
        const questionPayload = {
            id: randomQuestion.id,
            text: randomQuestion.question,
            options: randomQuestion.options, // KIRIM OPSI JAWABAN
            startTime: Date.now(),
            isRebound: false,
            fromGroup: null
        };
        await db.ref(`groups/${groupId}/currentQuestion`).set(questionPayload);
        groupTimers[groupId] = setTimeout(() => handleTimeUp(groupId, randomQuestion.id), QUESTION_TIME_LIMIT);
    } else {
        await db.ref(`groups/${groupId}`).update({ status: 'finished', currentQuestion: { text: "Game Selesai!" } });
    }
}
// ✅ FUNGSI BARU: menangani logika saat jawaban salah
async function handleWrongAnswer(originalGroupId, questionId) {
    const questionData = questions.find(q => q.id === questionId);
    
    // Temukan grup lawan
    const groupsSnapshot = await db.ref('groups').orderByChild('status').equalTo('playing').once('value');
    const playingGroups = groupsSnapshot.val();
    if (!playingGroups) return;

    const groupIds = Object.keys(playingGroups);
    const targetGroupId = groupIds.find(id => id !== originalGroupId);

    // Jika tidak ada grup lawan, langsung beri soal baru ke grup yang sama
    if (!targetGroupId) {
        await db.ref(`groups/${originalGroupId}/currentQuestion`).set({ text: "Jawaban Salah! Mencari soal baru..." });
        setTimeout(() => serveNextQuestion(originalGroupId), 2000);
        return;
    }


    // Kosongkan soal di grup yang salah menjawab
    await db.ref(`groups/${originalGroupId}/currentQuestion`).set({ text: `Salah! Soal dilempar ke Grup ${targetGroupId.slice(-4)}...` });
    
    // Kirim soal yang SAMA ke grup lawan
    const questionPayload = {
        id: questionData.id,
        text: questionData.question,
        options: questionData.options,
        startTime: Date.now(), // Timer baru untuk grup lawan
        isRebound: true,
        fromGroup: originalGroupId.slice(-4)
    };
    await db.ref(`groups/${targetGroupId}/currentQuestion`).set(questionPayload);
    
    // Set timer baru untuk grup lawan
    groupTimers[targetGroupId] = setTimeout(() => handleTimeUp(targetGroupId, questionId), QUESTION_TIME_LIMIT);

    // Grup yang salah akan mendapat soal baru setelah jeda singkat
    setTimeout(() => serveNextQuestion(originalGroupId), 3000);
}


// ✅ FUNGSI BARU: Memberi soal baru ke semua grup secara bersamaan
async function serveNextQuestionToAllGroups() {
    const groupsSnapshot = await db.ref('groups').orderByChild('status').equalTo('playing').once('value');
    const playingGroups = groupsSnapshot.val();
    if (!playingGroups) return;

    for (const groupId of Object.keys(playingGroups)) {
        await serveNextQuestion(groupId);
    }
}

// 📝 FUNGSI DIPERBARUI: handleTimeUp sekarang hanya menangani soal yang tidak terjawab sama sekali
async function handleTimeUp(groupId, questionId) {
    
    // Hentikan timer
    delete groupTimers[groupId];

    // Tandai soal ini hangus karena tidak ada yang menjawab tepat waktu
    await db.ref(`answeredQuestions/${questionId}`).set(true);

    // Beri tahu grup bahwa waktu habis dan akan diberi soal baru
    await db.ref(`groups/${groupId}/currentQuestion`).set({ text: "Waktu Habis! Mencari soal baru..." });

    // Beri soal baru untuk SEMUA grup agar kembali serentak
    setTimeout(() => serveNextQuestionToAllGroups(), 2000);
}
async function handleThrowFailure(groupId, questionId) {
     delete groupTimers[groupId];
     await db.ref(`answeredQuestions/${questionId}`).set(true);
     await db.ref(`groups/${groupId}/currentQuestion`).set({ text: "Waktu Habis! Mencari soal baru..." });
     setTimeout(() => serveNextQuestion(groupId), 2000);
}
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});