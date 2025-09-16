const express = require('express');
const session = require('express-session');
const path = require('path');
const crypto = require('crypto');
const { setDefaultAutoSelectFamily } = require('net');

const app = express();
const PORT = process.env.PORT;

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
        secure: false, // Set to true in production with HTTPS
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

// In-memory storage for active sessions (use database in production)
const activeSessions = new Map();
const paymentTokens = new Map();

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname,'..', 'public', 'pagamentos.html'));
});

// Check session status
app.get('/api/session/check', (req, res) => {
    const sessionId = req.sessionID;
    const session = activeSessions.get(sessionId);
    
    if (session && session.expiresAt > Date.now()) {
        const remainingTime = Math.ceil((session.expiresAt - Date.now()) / 1000);
        res.json({
            hasAccess: true,
            remainingTime: remainingTime,
            sessionId: sessionId
        });
    } else {
        // Clean expired session
        if (session) {
            activeSessions.delete(sessionId);
        }
        res.json({
            hasAccess: false,
            sessionId: sessionId
        });
    }
});

app.post('/api/check-user', (req, res) => {
    const { userNumber } = req.body;
    const sessionId = req.sessionID;
    
    // Check if there is an active session for the given sessionId
    const session = activeSessions.get(sessionId);
    
    if (session && session.expiresAt > Date.now()) {
        res.json({
            hasAccess: true,
            remainingTime: Math.ceil((session.expiresAt - Date.now()) / 1000)
        });
    } else {
        res.json({
            hasAccess: false
        });
    }
});

// Initialize payment
app.post('/api/payment/init', (req, res) => {
    const { amount = 5.00, userNumber } = req.body; // Adicionado userNumber
    const paymentToken = crypto.randomUUID();
    const sessionId = req.sessionID;
    
    // Store payment info
    paymentTokens.set(paymentToken, {
        sessionId: sessionId,
        amount: amount,
        userNumber: userNumber, // Adicionado userNumber
        createdAt: Date.now(),
        status: 'pending'
    });
    
    res.json({
        paymentToken: paymentToken,
        amount: amount,
        userNumber: userNumber,
        paymentUrl: `/payment/${paymentToken}`
    });
});

// Payment page
app.get('/payment/:token', (req, res) => {
    const token = req.params.token;
    const paymentInfo = paymentTokens.get(token);
    
    if (!paymentInfo) {
        return res.status(404).send('Payment not found');
    }
    
    res.send(`
        <!DOCTYPE html>
        <html lang="pt">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Pagamento - Phuza Premium</title>
            <style>
                body {
                    font-family: 'Arial', sans-serif;
                    background: linear-gradient(135deg, #0f0f0f 0%, #1a1a1a 100%);
                    color: white;
                    margin: 0;
                    padding: 20px;
                    min-height: 100vh;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                }
                .payment-container {
                    background: rgba(255, 255, 255, 0.1);
                    backdrop-filter: blur(10px);
                    border-radius: 20px;
                    padding: 40px;
                    max-width: 400px;
                    width: 100%;
                    text-align: center;
                    border: 1px solid rgba(0, 255, 255, 0.3);
                }
                .payment-title {
                    color: #00ffff;
                    font-size: 2rem;
                    margin-bottom: 20px;
                }
                .user-info {
                    background: rgba(0, 255, 136, 0.2);
                    padding: 15px;
                    border-radius: 10px;
                    margin: 20px 0;
                }
                .payment-amount {
                    font-size: 3rem;
                    color: #00ff88;
                    margin: 20px 0;
                }
                .payment-btn {
                    background: linear-gradient(45deg, #00ffff, #00ff88);
                    border: none;
                    padding: 15px 30px;
                    border-radius: 10px;
                    color: #000;
                    font-weight: bold;
                    font-size: 1.2rem;
                    cursor: pointer;
                    margin: 10px;
                    transition: transform 0.3s;
                }
                .payment-btn:hover {
                    transform: scale(1.05);
                }
                .loading {
                    display: none;
                    margin: 20px 0;
                }
            </style>
        </head>
        <body>
            <div class="payment-container">
                <h1 class="payment-title">PHUZA PREMIUM</h1>
                <div class="user-info">
                    <strong>Usuário: #${paymentInfo.userNumber}</strong>
                </div>
                <div class="payment-amount">$${paymentInfo.amount.toFixed(2)}</div>
                <p>Acesso premium por 15 segundos</p>
                
                <button class="payment-btn" onclick="processPayment('pix')">
                    🏦 Pagar com PIX
                </button>
                <button class="payment-btn" onclick="processPayment('card')">
                    💳 Pagar com Cartão
                </button>
                
                <div class="loading" id="loading">
                    <p>Processando pagamento...</p>
                </div>
            </div>
            <script>
                async function processPayment(method) {
                    document.getElementById('loading').style.display = 'block';
                    
                    setTimeout(async () => {
                        try {
                            const response = await fetch('/api/payment/confirm', {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json'
                                },
                                body: JSON.stringify({
                                    paymentToken: '${token}',
                                    method: method
                                })
                            });
                            
                            const result = await response.json();
                            
                            if (result.success) {
                                alert('Pagamento aprovado! Redirecionando para área premium...');
                                window.location.href = '/premium?user=' + result.userNumber;
                            } else {
                                alert('Erro no pagamento. Tente novamente.');
                                document.getElementById('loading').style.display = 'none';
                            }
                        } catch (error) {
                            alert('Erro de conexão. Tente novamente.');
                            document.getElementById('loading').style.display = 'none';
                        }
                    }, 2000);
                }
            </script>
        </body>
        </html>
    `);
});

// Confirm payment
app.post('/api/payment/confirm', (req, res) => {
    const { paymentToken, method } = req.body;
    const paymentInfo = paymentTokens.get(paymentToken);
    
    if (!paymentInfo) {
        return res.json({ success: false, message: 'Payment not found' });
    }
    
    // Simulate payment success (in production, integrate with real payment gateway)
    const success = Math.random() > 0.1; // 90% success rate for simulation
    
    if (success) {
        // Create or extend session
        const sessionId = paymentInfo.sessionId;
        const expiresAt = Date.now() + (20 * 1000); // 20 seconds
        
        activeSessions.set(sessionId, {
            expiresAt: expiresAt,
            paymentMethod: method,
            amount: paymentInfo.amount
        });
        
        // Mark payment as completed
        paymentTokens.set(paymentToken, {
            ...paymentInfo,
            status: 'completed',
            completedAt: Date.now()
        });
        
        res.json({ 
            success: true, 
            expiresAt: expiresAt,
            remainingTime: 20
        });
    } else {
        res.json({ success: false, message: 'Payment failed' });
    }
});

// Extend session (for testing purposes)
app.post('/api/session/extend', (req, res) => {
    const sessionId = req.sessionID;
    const expiresAt = Date.now() + (20 * 1000);
    
    activeSessions.set(sessionId, {
        expiresAt: expiresAt,
        paymentMethod: 'test',
        amount: 0
    });
    
    res.json({ success: true, expiresAt: expiresAt });
});

// Clean expired sessions periodically
setInterval(() => {
    const now = Date.now();
    for (const [sessionId, session] of activeSessions.entries()) {
        if (session.expiresAt <= now) {
            activeSessions.delete(sessionId);
        }
    }
    
    // Clean old payment tokens (older than 1 hour)
    const oneHourAgo = now - (60 * 60 * 1000);
    for (const [token, payment] of paymentTokens.entries()) {
        if (payment.createdAt < oneHourAgo) {
            paymentTokens.delete(token);
        }
    }
}, 30000); // Run every 30 seconds

app.listen(PORT, () => {
    console.log(`Phuza server running on http://localhost:${PORT}`);
    console.log('Active sessions:', activeSessions.size);
});
