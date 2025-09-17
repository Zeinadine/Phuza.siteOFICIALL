const express = require('express');
const session = require('express-session');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs').promises;
const axios = require('axios'); // Usar axios para fazer requisições HTTP é uma boa prática
const { v4: uuidv4 } = require('uuid'); // Gerar UUIDs mais robustos

const app = express();
const PORT = process.env.PORT || 3000;

// e2Payments Configuration
// ATENÇÃO: Use variáveis de ambiente para a sua chave de API!
// Ex: no terminal, rode `export E2PAYMENTS_API_KEY='MBVk30o4mc7GARjruTKaVdGWp34U5sh40rQqN8k7'`
const E2PAYMENTS_CONFIG = {
    apiKey: process.env.E2PAYMENTS_API_KEY,
    baseUrl: process.env.E2PAYMENTS_BASE_URL || 'http://localhost:8000/v1',
    // Corrija os endpoints conforme a sua documentação da e2Payments
    endpoints: {
        test: '/test',
        c2bPayment: '/payments/c2b', // Nome de endpoint mais comum para C2B
        // Você deve verificar o nome exato na documentação da API e2Payments
        webhook: '/api/webhook/e2payments'
    }
};

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Session configuration
app.use(session({
    secret: 'phuza-game-secret-key',
    resave: false,
    saveUninitialized: true,
    cookie: {
        secure: false,
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

// File paths for JSON storage
const USERS_FILE = path.join(__dirname, 'users.json');
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');
const PAYMENTS_FILE = path.join(__dirname, 'payments.json');

// Inicializar ficheiros JSON
async function initializeFiles() {
    try { await fs.access(USERS_FILE); } catch { await fs.writeFile(USERS_FILE, '[]'); }
    try { await fs.access(SESSIONS_FILE); } catch { await fs.writeFile(SESSIONS_FILE, '{}'); }
    try { await fs.access(PAYMENTS_FILE); } catch { await fs.writeFile(PAYMENTS_FILE, '{}'); }
}

// Funções de leitura e escrita de ficheiros
async function readUsers() { try { const data = await fs.readFile(USERS_FILE, 'utf8'); return JSON.parse(data); } catch { return []; } }
async function writeUsers(users) { await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2)); }
async function readSessions() { try { const data = await fs.readFile(SESSIONS_FILE, 'utf8'); return JSON.parse(data); } catch { return {}; } }
async function writeSessions(sessions) { await fs.writeFile(SESSIONS_FILE, JSON.stringify(sessions, null, 2)); }
async function readPayments() { try { const data = await fs.readFile(PAYMENTS_FILE, 'utf8'); return JSON.parse(data); } catch { return {}; } }
async function writePayments(payments) { await fs.writeFile(PAYMENTS_FILE, JSON.stringify(payments, null, 2)); }

// Funções da API e2Payments
async function testE2PaymentsConnection() {
    try {
        const response = await axios.post(`${E2PAYMENTS_CONFIG.baseUrl}${E2PAYMENTS_CONFIG.endpoints.test}`, {}, {
            headers: {
                'Authorization': `Bearer ${E2PAYMENTS_CONFIG.apiKey}`
            }
        });
        console.log('e2Payments test response:', response.status);
        return response.status === 200;
    } catch (error) {
        console.error('e2Payments connection test failed:', error.message);
        return false;
    }
}

async function initiateE2Payment(userNumber, amount, method, paymentToken) {
    try {
        const response = await axios.post(`${E2PAYMENTS_CONFIG.baseUrl}${E2PAYMENTS_CONFIG.endpoints.c2bPayment}`, {
            amount: amount,
            phoneNumber: userNumber,
            paymentMethod: method,
            reference: paymentToken // Usar o token como referência para o webhook
        }, {
            headers: {
                'Authorization': `Bearer ${E2PAYMENTS_CONFIG.apiKey}`,
                'Content-Type': 'application/json'
            }
        });

        return { success: true, data: response.data };
    } catch (error) {
        console.error('e2Payments payment initiation failed:', error.message);
        return { success: false, error: error.message };
    }
}

// Rotas
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/premium', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'premium.html'));
});

// Checar sessão do usuário
app.post('/api/check-user', async (req, res) => {
    const { userNumber } = req.body;
    if (!userNumber) { return res.json({ hasAccess: false, message: 'Número de usuário obrigatório' }); }

    const sessions = await readSessions();
    const userSession = sessions[userNumber];

    if (userSession && userSession.expiresAt > Date.now()) {
        const remainingTime = Math.ceil((userSession.expiresAt - Date.now()) / 1000);
        res.json({ hasAccess: true, remainingTime: remainingTime, userNumber: userNumber });
    } else {
        if (userSession) { delete sessions[userNumber]; await writeSessions(sessions); }
        res.json({ hasAccess: false, userNumber: userNumber });
    }
});

// **NOVO FLUXO: Iniciar pagamento (sincrono)**
// Este endpoint envia a requisição para a e2Payments e recebe o "ok" de que a requisição foi recebida.
app.post('/api/payment/init', async (req, res) => {
    const { userNumber, amount = 50.00, method = 'mpesa' } = req.body;
    if (!userNumber) { return res.status(400).json({ error: 'Número de usuário obrigatório' }); }

    const paymentToken = uuidv4();

    // Armazenar pagamento como "pendente"
    const payments = await readPayments();
    payments[paymentToken] = {
        userNumber: userNumber,
        amount: amount,
        status: 'pending',
        method: method,
        createdAt: Date.now()
    };
    await writePayments(payments);

    // Chamar a API da e2Payments
    const e2Result = await initiateE2Payment(userNumber, amount, method, paymentToken);

    if (e2Result.success) {
        res.json({
            paymentToken: paymentToken,
            message: 'Pagamento iniciado, por favor confirme no seu telemóvel.',
            status: 'initiated'
        });
    } else {
        res.status(500).json({ error: 'Falha ao iniciar pagamento', details: e2Result.error });
    }
});

// **NOVO FLUXO: Webhook (assíncrono)**
// Este endpoint é o mais importante. A e2Payments vai chamá-lo para CONFIRMAR o pagamento.
app.post(E2PAYMENTS_CONFIG.endpoints.webhook, async (req, res) => {
    try {
        // TODO: Em produção, verifique a assinatura do webhook para segurança extra.
        const payload = req.body;
        console.log('Webhook e2Payments recebido:', payload);

        // Verifique se o pagamento foi bem-sucedido
        if (payload.status === 'completed' && payload.reference) {
            const paymentToken = payload.reference;
            const payments = await readPayments();
            const paymentInfo = payments[paymentToken];

            if (paymentInfo && paymentInfo.status === 'pending') {
                // Marcar pagamento como concluído
                payments[paymentToken].status = 'completed';
                payments[paymentToken].completedAt = Date.now();
                await writePayments(payments);

                // Ativar a sessão do usuário
                const userNumber = paymentInfo.userNumber;
                const sessions = await readSessions();
                const expiresAt = Date.now() + (15 * 1000); // 15 segundos

                sessions[userNumber] = {
                    expiresAt: expiresAt,
                    paymentMethod: 'e2payments_webhook',
                    amount: paymentInfo.amount
                };
                await writeSessions(sessions);

                console.log(`Sessão do usuário ${userNumber} ativada via webhook.`);
            }
        }

        res.json({ received: true });
    } catch (error) {
        console.error('Erro no webhook:', error);
        res.status(400).json({ error: 'Falha no processamento do webhook' });
    }
});

// Rota para checar o status do pagamento no cliente
app.get('/api/payment/status/:token', async (req, res) => {
    const token = req.params.token;
    const payments = await readPayments();
    const paymentInfo = payments[token];

    if (!paymentInfo) {
        return res.status(404).json({ status: 'not_found' });s
    }

    // Retorna o status atual do pagamento para o cliente
    res.json({
        status: paymentInfo.status,
        userNumber: paymentInfo.userNumber
    });
});

// Limpeza de dados
setInterval(async () => {
    try {
        const sessions = await readSessions();
        const payments = await readPayments();
        const now = Date.now();
        let sessionsChanged = false;
        let paymentsChanged = false;

        for (const userNumber in sessions) { if (sessions[userNumber].expiresAt <= now) { delete sessions[userNumber]; sessionsChanged = true; } }
        const twoHoursAgo = now - (2 * 60 * 60 * 1000);
        for (const token in payments) { if (payments[token].createdAt < twoHoursAgo && payments[token].status !== 'completed') { delete payments[token]; paymentsChanged = true; } }

        if (sessionsChanged) { await writeSessions(sessions); }
        if (paymentsChanged) { await writePayments(payments); }
        await testE2PaymentsConnection();
    } catch (error) {
        console.error('Cleanup error:', error);
    }
}, 10000); // Check every 10 seconds

initializeFiles().then(async () => {
    const connectionOk = await testE2PaymentsConnection();
    console.log(`e2Payments connection: ${connectionOk ? 'OK' : 'FAILED'}`);
    app.listen(PORT, () => {
        console.log(`Phuza Premium server running on http://localhost:${PORT}`);
        console.log(`e2Payments integration: ${connectionOk ? 'ACTIVE' : 'SIMULATION MODE'}`);
    });
});