const express = require('express');
const session = require('express-session');
const path = require('path');
const stripe = require('stripe')('sk_test_51SAU6vJeRhiUN7ahBAAN0rcgg8ozL9bfVJocO8XQCZ9AszK5F4yunbcP7eaCibGbPgh1rZGQx9KlBcX6TDjvX35200LdYCNMaE');
const { createClient } = require('@supabase/supabase-js');

// Configuração do Supabase
const supabaseUrl = 'https://dggdijcgiyegfchzvgbw.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRnZ2RpamNnaXllZ2ZjaHp2Z2J3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTgzNzIzMjAsImV4cCI6MjA3Mzk0ODMyMH0.Ea7X6tI7BfJ2kFegW0MXR851msilj3b9j3ZePl1xOls'; // Sua chave pública (anon key)
const supabase = createClient(supabaseUrl, supabaseKey);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use(session({
    secret: 'phuza-game-secret-key',
    resave: false,
    saveUninitialized: true,
    cookie: { 
        secure: false,
        maxAge: 24 * 60 * 60 * 1000
    }
}));

const activeSessions = new Map();

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.get('/premium.html', (req, res) => {
    const sessionId = req.sessionID;
    const session = activeSessions.get(sessionId);
    
    if (session && session.expiresAt > Date.now()) {
        res.sendFile(path.join(__dirname, '..', 'public', 'premium.html'));
    } else {
        res.redirect('/');
    }
});

app.get('/api/session/check', (req, res) => {
    const sessionId = req.sessionID;
    const session = activeSessions.get(sessionId);
    const currentTime = Date.now();
    
    console.log(`Session check for ${sessionId}:`, {
        sessionExists: !!session,
        currentTime,
        expiresAt: session?.expiresAt,
        hasAccess: session && session.expiresAt > currentTime
    });
    
    if (session && session.expiresAt > currentTime) {
        const remainingTime = Math.ceil((session.expiresAt - currentTime) / 1000);
        res.json({
            hasAccess: true,
            remainingTime: remainingTime,
            sessionId: sessionId
        });
    } else {
        if (session) {
            console.log(`Removing expired session ${sessionId}`);
            activeSessions.delete(sessionId);
        }
        res.json({
            hasAccess: false,
            sessionId: sessionId
        });
    }
});

app.post('/api/payment/init', async (req, res) => {
    const { amount = 5.00, userNumber, paymentMethodType = 'card' } = req.body;
    const sessionId = req.sessionID;

    try {
        const paymentIntent = await stripe.paymentIntents.create({
            amount: Math.round(amount * 100),
            currency: 'usd',
            metadata: { userNumber: userNumber, sessionId: sessionId },
            payment_method_types: ['card'],
            confirm: false,
            automatic_payment_methods: {
                enabled: true,
                allow_redirects: 'never'
            }
        });

        res.json({
            clientSecret: paymentIntent.client_secret,
            amount: amount,
            userNumber: userNumber
        });
    } catch (error) {
        console.error('Erro ao criar Payment Intent:', error);
        res.status(500).json({ error: 'Erro ao inicializar pagamento: ' + error.message });
    }
});

app.post('/api/payment/confirm', async (req, res) => {
    const { paymentIntentId } = req.body;
    
    try {
        const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
        
        if (paymentIntent.status === 'succeeded') {
            const sessionId = paymentIntent.metadata.sessionId;
            const userNumber = paymentIntent.metadata.userNumber;
            const amount = paymentIntent.amount / 100;
            const accessTime = 20; // segundos

            const expiresAt = Date.now() + (accessTime * 1000);
            
            // Salvar no Supabase
            const { data, error } = await supabase
                .from('pagamentos') // Nome da sua tabela no Supabase
                .insert([
                    {
                        numero_telefone: userNumber,
                        preco: amount,
                        tempo: accessTime,
                        payment_intent_id: paymentIntentId,
                        data_pagamento: new Date().toISOString(),
                        expira_em: new Date(expiresAt).toISOString()
                    }
                ]);

            if (error) {
                console.error('Erro ao salvar no Supabase:', error);
                // Continua mesmo com erro no Supabase
            } else {
                console.log('Pagamento salvo no Supabase:', data);
            }
            
            activeSessions.set(sessionId, {
                expiresAt: expiresAt,
                paymentMethod: paymentIntent.charges.data[0]?.payment_method_details?.type || 'card',
                amount: amount,
                userNumber: userNumber
            });
            
            res.json({ 
                success: true, 
                expiresAt: expiresAt,
                remainingTime: accessTime,
                userNumber: userNumber
            });
        } else {
            res.json({ success: false, message: 'Pagamento não foi bem-sucedido.' });
        }
    } catch (error) {
        console.error('Erro ao confirmar pagamento:', error);
        res.status(500).json({ success: false, message: 'Erro ao processar a confirmação do pagamento: ' + error.message });
    }
});

// ROTA PARA TESTE (remover em produção)
app.post('/api/session/extend', async (req, res) => {
    const sessionId = req.sessionID;
    const expiresAt = Date.now() + (20 * 1000);
    const userNumber = req.body.userNumber || 'teste-' + Date.now();
    
    // Salvar teste no Supabase
    const { data, error } = await supabase
        .from('pagamentos')
        .insert([
            {
                numero_telefone: userNumber,
                preco: 0,
                tempo: 20,
                payment_intent_id: 'test-' + sessionId,
                data_pagamento: new Date().toISOString(),
                expira_em: new Date(expiresAt).toISOString()
            }
        ]);

    if (error) {
        console.error('Erro ao salvar teste no Supabase:', error);
    }
    
    activeSessions.set(sessionId, {
        expiresAt: expiresAt,
        paymentMethod: 'test',
        amount: 0,
        userNumber: userNumber
    });
    
    res.json({ success: true, expiresAt: expiresAt });
});

setInterval(() => {
    const now = Date.now();
    for (const [sessionId, session] of activeSessions.entries()) {
        if (session.expiresAt <= now) {
            activeSessions.delete(sessionId);
        }
    }
}, 30000);

app.listen(PORT, () => {
    console.log(`Phuza server running on http://localhost:${PORT}`);
    console.log('Active sessions:', activeSessions.size);
});